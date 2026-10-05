import { Hono } from 'hono';
import OpenAI, { toFile } from 'openai';
import type { Env } from '../types';
import { COLLAR_SAMPLE_RATE, pcmToWav, ulawDecode, normalize } from '../lib/audio';

const app = new Hono<{ Bindings: Env }>();

interface TranscribeBody {
  /** base64 audio bytes (JSON so App Attest can sign the body like every other route) */
  audio: string;
  /** 'ulaw8k' (collar mic stream, default) or 'wav' */
  encoding?: 'ulaw8k' | 'wav';
  /** optional recognizer hint: dog's name, owner names, etc. */
  prompt?: string;
}

/**
 * POST /v1/transcribe
 * Body: { audio: base64, encoding?: 'ulaw8k' | 'wav', prompt?: string }
 * Response: { text, duration_ms }
 */
app.post('/', async (c) => {
  const body = await c.req.json<TranscribeBody>();
  if (!body.audio) {
    return c.json({ error: 'audio is required' }, 400);
  }
  const ct = body.encoding === 'wav' ? 'audio/wav' : 'audio/basic';
  const raw = Uint8Array.from(atob(body.audio), ch => ch.charCodeAt(0));
  if (raw.length < 800) {
    return c.json({ error: 'audio too short' }, 400);
  }
  if (raw.length > 2_000_000) {
    return c.json({ error: 'audio too long' }, 413);
  }

  let wav: Uint8Array;
  let durationMs: number;
  if (ct.startsWith('audio/wav') || ct.startsWith('audio/x-wav')) {
    wav = raw;
    durationMs = 0;
  } else {
    const pcm = normalize(ulawDecode(raw), 0.8);
    wav = pcmToWav(pcm, COLLAR_SAMPLE_RATE);
    durationMs = Math.round((pcm.length / COLLAR_SAMPLE_RATE) * 1000);
  }

  const oai = new OpenAI({ apiKey: c.env.OPENAI_API_KEY });
  const prompt = body.prompt;
  try {
    const result = await oai.audio.transcriptions.create({
      model: c.env.TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe',
      file: await toFile(wav, 'collar.wav', { type: 'audio/wav' }),
      language: 'en',
      ...(prompt ? { prompt } : {}),
    });
    const text = (result.text ?? '').trim();
    console.log('[transcribe]', durationMs, 'ms →', JSON.stringify(text));
    return c.json({ text, duration_ms: durationMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[transcribe] error:', msg);
    return c.json({ error: `transcription failed: ${msg}` }, 502);
  }
});

export default app;
