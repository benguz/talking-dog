import { Hono } from 'hono';
import OpenAI from 'openai';
import type { Env } from '../types';
import { VOICE_STYLE_TO_ID } from '../lib/prompts';
import type { DogVoiceStyle } from '../lib/prompts';
import { COLLAR_SAMPLE_RATE, adpcmEncode, compress, downsample, normalize, resample, ulawEncode } from '../lib/audio';

const app = new Hono<{ Bindings: Env }>();

interface TtsBody {
  text: string;
  voice_style?: DogVoiceStyle;
  voice_id?: string;       // direct override — any inworld/tts-2 voice name
  speaking_rate?: number;  // 0.5–1.5, default 1.0
  temperature?: number;    // 0.01–2.0, default 1.0
  /**
   * 'mp3'      default, phone playback
   * 'ulaw8k'   raw 8 kHz μ-law for the collar speaker (8 kB/s, telephone band)
   * 'adpcm16k' raw 16 kHz IMA ADPCM for the collar speaker (8 kB/s, wideband)
   */
  format?: 'mp3' | 'ulaw8k' | 'adpcm16k';
}

/** OpenAI TTS voices used for the collar path (the inworld voices only ship MP3). */
const OPENAI_VOICE_FOR_STYLE: Record<DogVoiceStyle, string> = {
  bouncy_excited: 'nova',
  wise_calm: 'onyx',
  silly_goofy: 'fable',
  sweet_loving: 'shimmer',
  dramatic_diva: 'coral',
};
const OPENAI_VOICE_INSTRUCTIONS: Record<DogVoiceStyle, string> = {
  bouncy_excited: 'An excited, bouncy, happy dog. Fast, bright, lots of energy.',
  wise_calm: 'A calm, wise old dog. Slow, warm, thoughtful.',
  silly_goofy: 'A silly, goofy dog. Playful, a little confused, lovable.',
  sweet_loving: 'A sweet, affectionate dog. Gentle, warm, adoring.',
  dramatic_diva: 'A dramatic diva dog. Theatrical, over the top, expressive.',
};

// ── ElevenLabs (default when ELEVENLABS_API_KEY is set) ───────────────────────
// Eleven v4 Turbo: expressive, reacts to [audio tags], CAPS, "!!!" and "…" in
// the text itself; returns pcm_16000 which feeds the collar's ADPCM path with
// no resampling. https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4

const EL_API = 'https://api.elevenlabs.io/v1';
let elVoiceCache: { name: string; id: string } | null = null;

/** Resolve a voice by name (cached per isolate) unless an id is configured. */
async function elevenVoiceId(env: Env): Promise<string> {
  if (env.ELEVENLABS_VOICE_ID) return env.ELEVENLABS_VOICE_ID;
  const wanted = (env.ELEVENLABS_VOICE ?? 'Will').toLowerCase();
  if (elVoiceCache?.name === wanted) return elVoiceCache.id;
  const res = await fetch(`${EL_API}/voices`, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY! } });
  if (!res.ok) throw new Error(`voices list failed: ${res.status}`);
  const data = (await res.json()) as { voices: { voice_id: string; name: string }[] };
  const hit = data.voices.find(v => v.name.toLowerCase() === wanted) ?? data.voices.find(v => v.name.toLowerCase().startsWith(wanted));
  if (!hit) throw new Error(`ElevenLabs voice "${env.ELEVENLABS_VOICE}" not found in your library`);
  elVoiceCache = { name: wanted, id: hit.voice_id };
  console.log('[tts] elevenlabs voice', hit.name, hit.voice_id);
  return hit.voice_id;
}

/** ElevenLabs → 16 kHz PCM16 LE. */
async function elevenPcm16k(env: Env, text: string, rate: number): Promise<Int16Array> {
  const voiceId = await elevenVoiceId(env);
  const model = env.ELEVENLABS_MODEL ?? 'eleven_v4_turbo';
  const res = await fetch(`${EL_API}/text-to-speech/${voiceId}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: model,
      // Low stability = more expressive / varied delivery (v4 has no style slider).
      voice_settings: {
        stability: Number(env.ELEVENLABS_STABILITY ?? 0.35),
        similarity_boost: 0.8,
        use_speaker_boost: true,
        ...(model.startsWith('eleven_v4') ? {} : { speed: Math.min(1.2, Math.max(0.7, rate)) }),
      },
      apply_text_normalization: 'auto',
    }),
  });
  if (!res.ok) {
    throw new Error(`elevenlabs ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const buf = await res.arrayBuffer();
  return new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
}

/**
 * Collar path: TTS → PCM → 16 kHz ADPCM (audio/x-adpcm) or 8 kHz μ-law (audio/basic).
 * Provider: ElevenLabs when configured (TTS_PROVIDER / ELEVENLABS_API_KEY), else OpenAI.
 * The app forwards these bytes straight to the collar over BLE.
 */
async function ttsForCollar(
  c: { env: Env },
  text: string,
  style: DogVoiceStyle | undefined,
  rate: number,
  format: 'ulaw8k' | 'adpcm16k',
) {
  const useEleven =
    c.env.TTS_PROVIDER === 'elevenlabs' || (c.env.TTS_PROVIDER == null && !!c.env.ELEVENLABS_API_KEY);

  let pcm16: Int16Array;
  let voice: string;
  if (useEleven) {
    voice = `elevenlabs:${c.env.ELEVENLABS_VOICE_ID ?? c.env.ELEVENLABS_VOICE ?? 'Will'}`;
    pcm16 = await elevenPcm16k(c.env, text, rate);
  } else {
    voice = (style && OPENAI_VOICE_FOR_STYLE[style]) || 'nova';
    pcm16 = await openaiPcm16k(c.env, text, voice, style, rate);
  }

  // Speech compression (+ makeup to 0.9 peak): louder on a small speaker
  // without clipping. COLLAR_COMPRESS=off disables it.
  const shaped = c.env.COLLAR_COMPRESS === 'off' ? normalize(pcm16, 0.9) : compress(pcm16, 16000);

  if (format === 'adpcm16k') {
    const adpcm = adpcmEncode(shaped);
    console.log('[tts] collar adpcm16k — voice:', voice, `${(pcm16.length / 16000).toFixed(1)} s, ${adpcm.length} B`);
    return new Response(adpcm, {
      headers: { 'Content-Type': 'audio/x-adpcm', 'X-Sample-Rate': '16000', 'X-Encoding': 'adpcm' },
    });
  }

  const pcm8 = downsample(shaped, 2);
  const ulaw = ulawEncode(pcm8);
  console.log('[tts] collar ulaw8k — voice:', voice, `${(pcm8.length / COLLAR_SAMPLE_RATE).toFixed(1)} s`);
  return new Response(ulaw, {
    headers: { 'Content-Type': 'audio/basic', 'X-Sample-Rate': String(COLLAR_SAMPLE_RATE), 'X-Encoding': 'ulaw' },
  });
}

/** OpenAI TTS → 16 kHz PCM16 (24 kHz native, resampled). */
async function openaiPcm16k(env: Env, text: string, voice: string, style: DogVoiceStyle | undefined, rate: number): Promise<Int16Array> {
  const oai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const res = await oai.audio.speech.create({
    model: env.TTS_MODEL ?? 'gpt-4o-mini-tts',
    voice,
    input: text,
    instructions: (style && OPENAI_VOICE_INSTRUCTIONS[style]) || 'A friendly talking dog.',
    response_format: 'pcm', // 24 kHz, 16-bit, mono, little-endian
    speed: Math.min(4, Math.max(0.25, rate)),
  });
  const buf = await res.arrayBuffer();
  const pcm24 = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
  return resample(pcm24, 24000, 16000);
}

app.post('/', async (c) => {
  const body = await c.req.json<TtsBody>();
  const { text, voice_style, voice_id, speaking_rate = 1.0, temperature = 1.0, format = 'mp3' } = body;

  if (!text || text.trim().length === 0) {
    return c.json({ error: 'text is required' }, 400);
  }
  if (text.length > 2000) {
    return c.json({ error: 'text exceeds 2000 character limit' }, 400);
  }

  if (format === 'ulaw8k' || format === 'adpcm16k') {
    try {
      return await ttsForCollar(c, text.trim(), voice_style, speaking_rate, format);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tts] collar TTS error:', msg);
      return c.json({ error: `collar TTS failed: ${msg}` }, 502);
    }
  }

  // Resolve voice: direct id > mapped style > default
  const resolvedVoice =
    voice_id ??
    (voice_style ? VOICE_STYLE_TO_ID[voice_style] : undefined) ??
    'Pippa';

  const input = {
    text: text.trim(),
    voice_id: resolvedVoice,
    output_format: 'mp3' as const,
    sample_rate: 24000,
    speaking_rate: Math.min(1.5, Math.max(0.5, speaking_rate)),
    temperature: Math.min(2, Math.max(0.01, temperature)),
    timestamp_type: 'none' as const,
  };

  console.log('[tts] running model — voice:', resolvedVoice, 'text length:', input.text.length);

  let result: unknown;
  try {
    result = await c.env.AI.run(
      'inworld/tts-2' as Parameters<typeof c.env.AI.run>[0],
      input as Parameters<typeof c.env.AI.run>[1],
      { gateway: { id: 'default' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[tts] AI.run error:', msg);
    return c.json({ error: `AI TTS failed: ${msg}` }, 502);
  }

  console.log('[tts] result type:', typeof result, result instanceof Response ? 'Response' : result instanceof ArrayBuffer ? 'ArrayBuffer' : JSON.stringify(result)?.slice(0, 100));

  if (result instanceof Response) {
    return new Response(result.body, { headers: { 'Content-Type': 'audio/mpeg' } });
  }

  if (result instanceof ArrayBuffer) {
    return new Response(result, { headers: { 'Content-Type': 'audio/mpeg' } });
  }

  // AI Gateway wraps the result: { state: "Completed", result: { audio: "https://..." } }
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    const audioUrl =
      (r.audio as string | undefined) ??
      ((r.result as Record<string, unknown> | undefined)?.audio as string | undefined);

    if (audioUrl) {
      console.log('[tts] fetching audio from URL:', audioUrl.slice(0, 80));
      const upstream = await fetch(audioUrl);
      return new Response(upstream.body, {
        headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'audio/mpeg' },
      });
    }
  }

  return c.json({ error: 'Unexpected TTS response shape from Cloudflare AI' }, 502);
});

export default app;
