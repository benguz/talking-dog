import { Hono } from 'hono';
import type { Env } from '../types';

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /v1/realtime/token
 *
 * Mints a short-lived ephemeral client secret from OpenAI's Realtime GA API.
 * The iOS client uses this to connect directly to OpenAI via WebRTC —
 * our backend is never in the media path.
 *
 * Response shape (from OpenAI GA /v1/realtime/client_secrets):
 *   { value, expires_at, session: { ... } }
 * The client uses `value` as the Bearer token for its WebRTC SDP offer to
 * https://api.openai.com/v1/realtime/calls.
 */
app.post('/token', async (c) => {
  const body = await c.req.json<{ voice?: string }>().catch(() => ({ voice: undefined }));
  const voice = body.voice ?? 'marin';
  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: 'gpt-realtime',
        audio: {
          output: { voice },
          // Disable server VAD at session creation, NOT just in a follow-up
          // session.update. The Realtime GA default is server_vad, which on a
          // sendrecv transceiver will barge-in on the dog's own response when
          // it picks up comfort-noise / acoustic echo, producing a "one word
          // at a time, repeating forever" loop. The PTT flow in the client
          // commits the input buffer manually, so we don't need server VAD.
          input: { turn_detection: null },
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[realtime] token mint error:', response.status, text);
    return c.json({ error: `OpenAI error: ${text}` }, 502);
  }

  const data = await response.json();
  return c.json(data);
});

export default app;
