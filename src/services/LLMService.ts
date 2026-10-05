/**
 * LLMService — routes dog speech generation through one of two providers:
 *
 *   1. BackendLLMProvider — POSTs the conversation to our hosted API.
 *      This is the default for shipped users, since API keys for any third-
 *      party LLM (OpenAI, Anthropic, etc.) MUST live on the server, not in
 *      the app binary.
 *
 *   2. OnDeviceLLMProvider — runs a tiny model locally via llama.rn for
 *      offline / dev iteration. Loads lazily the first time it is selected.
 *
 * Use `llmService.activate(provider)` (or just call `generate()`) to switch.
 */

import { initLlama, LlamaContext } from 'llama.rn';
import RNFS from 'react-native-fs';
import {
  ChatMessage,
  CollarTrigger,
  DogPersonalityTrait,
  DogProfile,
  DogState,
  DogVoiceStyle,
  ManualTrigger,
  ModelProvider,
  MANUAL_TRIGGER_PROMPTS,
  TRIGGER_DESCRIPTIONS,
} from '../types';
import { appAttestService } from './AppAttestService';

// Compile-time default base URL. The specific route paths (/v1/generate, /v1/tts)
// are appended by each provider. Override at runtime via `settings.backendUrl`.
const DEFAULT_BACKEND_URL = 'https://talking-dog-worker.benjamin-guzovsky.workers.dev';

export interface GenerateOptions {
  trigger: CollarTrigger | ManualTrigger;
  dogProfile: DogProfile;
  recentMessages: ChatMessage[];
  onToken?: (token: string) => void;
  /** Runtime-provided backend URL override, used by `BackendLLMProvider`. */
  backendUrl?: string;
  /** Base64 JPEG frames to show the model (backend provider only). */
  images?: string[];
}

const VOICE_STYLE_INSTRUCTIONS: Record<DogVoiceStyle, string> = {
  bouncy_excited:
    'You speak in short, energetic bursts. Use exclamation points! Get distracted by smells mid-sentence. Very enthusiastic.',
  wise_calm:
    'You speak thoughtfully and slowly. You have seen many walks and many squirrels. You are philosophical but still very dog-brained.',
  silly_goofy:
    'You make up silly words sometimes. You get confused easily but in an adorable way. Occasionally mention chasing your own tail.',
  sweet_loving:
    'You are warm, affectionate, and sentimental. You frequently remind your human how much you love them. Very wholesome.',
  dramatic_diva:
    'Everything is the BEST or WORST thing that has ever happened. You are extremely dramatic. Capitalize words for emphasis.',
};

const TRAIT_DESCRIPTORS: Record<DogPersonalityTrait, string> = {
  playful: 'loves to play and is always up for fetch',
  lazy: 'would rather nap than do anything strenuous',
  food_obsessed: 'thinks about food approximately 90% of the time',
  anxious: 'gets a little worried about loud noises and strangers',
  adventurous: 'always wants to explore new smells and places',
  cuddly: 'loves to snuggle and be close to their human',
  stubborn: 'has very strong opinions about what to do and when',
  goofy: 'constantly does silly things on accident',
  loyal: 'deeply devoted to their family',
  curious: 'investigates everything with their nose',
};

// ── Provider interface ────────────────────────────────────────────────────────

interface LLMProvider {
  readonly id: ModelProvider;
  isReady(): boolean;
  prepare(): Promise<void>;
  generate(opts: GenerateOptions): Promise<string>;
  unload(): Promise<void>;
}

// ── Backend provider ──────────────────────────────────────────────────────────

class BackendLLMProvider implements LLMProvider {
  readonly id: ModelProvider = 'backend';
  private ready = false;

  isReady() {
    return this.ready;
  }

  async prepare() {
    // No persistent connection needed — just mark ready. Real readiness is
    // verified at call time via the configured URL.
    this.ready = true;
  }

  async generate(opts: GenerateOptions): Promise<string> {
    const base = (opts.backendUrl?.trim() || DEFAULT_BACKEND_URL).replace(/\/$/, '');
    const url = `${base}/v1/generate`;

    const bodyPayload = {
      trigger: opts.trigger,
      dogProfile: opts.dogProfile,
      messages: opts.recentMessages.slice(-6).map(m => ({
        role: m.role,
        text: m.text,
      })),
      ...(opts.images?.length ? { images: opts.images } : {}),
    };
    const bodyJSON = JSON.stringify(bodyPayload);

    // Get App Attest assertion headers (empty object when unavailable)
    const attestHeaders = await appAttestService.assertionHeaders(bodyJSON);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...attestHeaders },
      body: bodyJSON,
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`Backend LLM error ${res.status}: ${text}`);
    }

    // Parse server-sent events stream
    // Format: data: {"type":"token","text":"..."}\n\n
    //         data: {"type":"done","full_text":"..."}\n\n
    //         data: [DONE]\n\n
    return readSSEStream(res, opts.onToken);
  }

  async unload() {
    this.ready = false;
  }
}

// ── On-device provider ───────────────────────────────────────────────────────

class OnDeviceLLMProvider implements LLMProvider {
  readonly id: ModelProvider = 'on_device';
  private context: LlamaContext | null = null;

  isReady() {
    return this.context != null;
  }

  async prepare() {
    if (this.context) return;
    const modelPath = await locateOnDeviceModel();
    if (!modelPath) {
      throw new Error(
        'No on-device model file found. Place a small model in the app Documents directory.',
      );
    }
    this.context = await initLlama({
      model: modelPath,
      use_mlock: true,
      n_ctx: 2048,
      n_threads: 4,
      flash_attn: true,
    });
  }

  async generate(opts: GenerateOptions): Promise<string> {
    if (!this.context) await this.prepare();
    if (!this.context) throw new Error('On-device model not ready');

    const systemPrompt = buildSystemPrompt(opts.dogProfile);
    const userPrompt = buildUserPrompt(opts.trigger);

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...opts.recentMessages.slice(-6).map(m => ({
        role: m.role === 'dog' ? ('assistant' as const) : ('user' as const),
        content: m.text,
      })),
      { role: 'user' as const, content: userPrompt },
    ];

    let fullText = '';
    const result = await this.context.completion(
      {
        messages,
        n_predict: 80,
        temperature: 0.85,
        top_p: 0.9,
        top_k: 40,
        penalty_repeat: 1.1,
        stop: ['\n\n', 'Human:', 'human:', '[/INST]'],
      },
      data => {
        if (data.token) {
          fullText += data.token;
          opts.onToken?.(data.token);
        }
      },
    );

    return (result.text ?? fullText).trim();
  }

  async unload() {
    await this.context?.release();
    this.context = null;
  }
}

// ── Service facade ────────────────────────────────────────────────────────────

class LLMService {
  private providers: Record<ModelProvider, LLMProvider> = {
    backend: new BackendLLMProvider(),
    on_device: new OnDeviceLLMProvider(),
  };
  private activeId: ModelProvider = 'backend';

  get isReady() {
    return this.providers[this.activeId].isReady();
  }

  get active(): ModelProvider {
    return this.activeId;
  }

  /** Switch the active provider, preparing it if needed. */
  async activate(provider: ModelProvider): Promise<void> {
    if (this.activeId === provider && this.providers[provider].isReady()) return;
    this.activeId = provider;
    await this.providers[provider].prepare();
  }

  async generate(opts: GenerateOptions): Promise<string> {
    const provider = this.providers[this.activeId];
    if (!provider.isReady()) await provider.prepare();
    return provider.generate(opts);
  }

  async unloadAll() {
    await Promise.all(Object.values(this.providers).map(p => p.unload()));
  }

  /** Heuristically derive dog state from current trigger */
  static triggerToDogState(trigger: CollarTrigger | ManualTrigger): DogState {
    if (trigger === CollarTrigger.WAG_START) return 'wagging';
    if (trigger === CollarTrigger.EXCITED) return 'excited';
    if (trigger === CollarTrigger.SLEEPING) return 'sleeping';
    if (trigger === CollarTrigger.ALERT) return 'alert';
    if (trigger === CollarTrigger.CALM || trigger === CollarTrigger.WAG_STOP) return 'calm';
    return 'idle';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function locateOnDeviceModel(): Promise<string | null> {
  try {
    const docs = RNFS.DocumentDirectoryPath;
    const entries = await RNFS.readDir(docs);
    // Pick the first model-like file. We deliberately don't expose the
    // ".gguf" detail in user-facing UI, but the on-device runtime still
    // expects a llama.cpp-compatible weights file.
    const candidate = entries.find(e =>
      /\.(gguf|bin)$/i.test(e.name) && e.isFile?.(),
    );
    return candidate?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads a server-sent events stream from the Worker's /v1/generate endpoint.
 * React Native 0.73+ exposes response.text() and DOES support streaming
 * via the response body reader, but the TypeScript lib types for ReadableStream
 * aren't included in the RN tsconfig. We therefore consume the full body text
 * (which works because the Worker keeps the stream open until [DONE]) and
 * parse SSE lines from it. For typical dog responses (1-2 sentences) the
 * latency difference is negligible; proper incremental streaming can be
 * added when we upgrade the tsconfig lib target to include 'dom' streams.
 *
 * Real-time token updates still flow via `onToken` during on-device generation
 * (llama.rn native callback); for the backend path the full text arrives as
 * one chunk and onToken fires once with the full result.
 */
// Minimal interfaces for WHATWG streaming APIs available in Hermes (RN 0.71+)
// but absent from the RN tsconfig lib target.
interface StreamReader {
  read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
}
interface StreamBody {
  getReader(): StreamReader;
}
interface TextDec {
  decode(value: Uint8Array | undefined, options?: { stream: boolean }): string;
}
declare const TextDecoder: new () => TextDec;

async function readSSEStream(
  res: Response,
  onToken?: (token: string) => void,
): Promise<string> {
  let fullText = '';

  // Hermes (RN 0.71+) exposes response.body as a WHATWG ReadableStream.
  // Reading incrementally lets tokens reach the UI as they arrive.
  const body = (res as unknown as { body: StreamBody | null }).body;
  if (body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break outer;

        let event: { type: string; text?: string; full_text?: string; message?: string };
        try {
          event = JSON.parse(payload) as typeof event;
        } catch {
          continue;
        }

        if (event.type === 'token' && event.text) {
          fullText += event.text;
          onToken?.(event.text);
        } else if (event.type === 'done') {
          fullText = event.full_text ?? fullText;
          break outer;
        } else if (event.type === 'error') {
          throw new Error(`Worker error: ${event.message}`);
        }
      }
    }
    return fullText;
  }

  // Fallback: read full body at once (no streaming support)
  const raw = await res.text();
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') break;

    let event: { type: string; text?: string; full_text?: string; message?: string };
    try {
      event = JSON.parse(payload) as typeof event;
    } catch {
      continue;
    }

    if (event.type === 'token' && event.text) {
      fullText += event.text;
      onToken?.(event.text);
    } else if (event.type === 'done') {
      fullText = event.full_text ?? fullText;
      break;
    } else if (event.type === 'error') {
      throw new Error(`Worker error: ${event.message}`);
    }
  }
  return fullText;
}

/**
 * Calls the backend TTS endpoint and returns a fetch Response.
 * With format 'adpcm16k' / 'ulaw8k' the caller streams the bytes to the collar.
 */
export async function fetchBackendTts(
  backendUrl: string,
  text: string,
  voiceStyle: string,
  format: 'mp3' | 'ulaw8k' | 'adpcm16k' = 'mp3',
): Promise<Response> {
  const base = (backendUrl.trim() || DEFAULT_BACKEND_URL).replace(/\/$/, '');
  const url = `${base}/v1/tts`;

  const bodyPayload = { text, voice_style: voiceStyle, format };
  const bodyJSON = JSON.stringify(bodyPayload);
  const attestHeaders = await appAttestService.assertionHeaders(bodyJSON);

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...attestHeaders },
    body: bodyJSON,
  });
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

export function buildSystemPrompt(profile: DogProfile): string {
  const traitDesc = profile.personalityTraits
    .map(t => TRAIT_DESCRIPTORS[t])
    .join(', ');

  const voiceInstructions = VOICE_STYLE_INSTRUCTIONS[profile.voiceStyle];

  return [
    `You are ${profile.name || 'a dog'}, a ${profile.breed || 'dog'}.`,
    traitDesc ? `Your personality: you ${traitDesc}.` : '',
    `Voice and style: ${voiceInstructions}`,
    profile.ownerNames ? `Owner(s): ${profile.ownerNames}.` : '',
    profile.bio ? `About ${profile.name || 'this dog'}: ${profile.bio}` : '',
    profile.lifeStory ? `Life story: ${profile.lifeStory}` : '',
    profile.favoriteSnacks ? `Favorite snacks: ${profile.favoriteSnacks}.` : '',
    profile.additionalContext ? `Additional notes: ${profile.additionalContext}` : '',
    '',
    'Rules:',
    '- Respond in 1–2 short sentences only. Never more.',
    '- Speak entirely as the dog. Never break character.',
    '- Use dog-appropriate vocabulary and concerns (squirrels, treats, walks, belly rubs, etc.).',
    '- Do not explain that you are an AI.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildUserPrompt(trigger: CollarTrigger | ManualTrigger): string {
  if (trigger in CollarTrigger) {
    const collarTrigger = trigger as CollarTrigger;
    const description = TRIGGER_DESCRIPTIONS[collarTrigger];
    return `Right now your ${description}. Say something!`;
  }

  const manualTrigger = trigger as ManualTrigger;
  return `${MANUAL_TRIGGER_PROMPTS[manualTrigger]}. Respond in character.`;
}

export const llmService = new LLMService();
export { LLMService };
