/**
 * LLMService — on-device language model inference via llama.rn.
 *
 * Model setup:
 *   Download a GGUF model (e.g. Llama-3.2-1B-Instruct.Q4_K_M.gguf or
 *   Phi-3-mini-4k-instruct.Q4_K_M.gguf) and place it in the app's
 *   Documents directory. The `modelPath` prop on LLMProvider points to it.
 *
 *   Recommended: Llama 3.2 1B Instruct Q4_K_M (~700 MB) for solid quality,
 *   or TinyLlama 1.1B Chat Q4_K_M (~670 MB) for faster inference.
 */

import { initLlama, LlamaContext } from 'llama.rn';
import {
  ChatMessage,
  CollarTrigger,
  DogPersonalityTrait,
  DogProfile,
  DogState,
  DogVoiceStyle,
  ManualTrigger,
  MANUAL_TRIGGER_PROMPTS,
  TRIGGER_DESCRIPTIONS,
} from '../types';

export interface GenerateOptions {
  trigger: CollarTrigger | ManualTrigger;
  dogProfile: DogProfile;
  recentMessages: ChatMessage[];
  onToken?: (token: string) => void;
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

class LLMService {
  private context: LlamaContext | null = null;
  private modelPath: string | null = null;

  async load(modelPath: string, onProgress?: (progress: number) => void): Promise<void> {
    this.modelPath = modelPath;
    this.context = await initLlama({
      model: modelPath,
      use_mlock: true,
      n_ctx: 2048,
      n_threads: 4,
      flash_attn: true,
    });
    onProgress?.(1.0);
  }

  get isReady() {
    return this.context != null;
  }

  async unload() {
    await this.context?.release();
    this.context = null;
  }

  async generate(opts: GenerateOptions): Promise<string> {
    if (!this.context) throw new Error('LLM not loaded');

    const systemPrompt = buildSystemPrompt(opts.dogProfile);
    const userPrompt = buildUserPrompt(opts.trigger, opts.dogProfile);

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

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildSystemPrompt(profile: DogProfile): string {
  const traitDesc = profile.personalityTraits
    .map(t => TRAIT_DESCRIPTORS[t])
    .join(', ');

  const voiceInstructions = VOICE_STYLE_INSTRUCTIONS[profile.voiceStyle];

  return [
    `You are ${profile.name || 'a dog'}, a ${profile.breed || 'dog'}.`,
    traitDesc ? `Your personality: you ${traitDesc}.` : '',
    `Voice and style: ${voiceInstructions}`,
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

function buildUserPrompt(
  trigger: CollarTrigger | ManualTrigger,
  _profile: DogProfile,
): string {
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
