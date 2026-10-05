import { Hono } from 'hono';
import { cors } from 'hono/cors';
import generateRoute from './routes/generate';
import ttsRoute from './routes/tts';
import transcribeRoute from './routes/transcribe';
import attestRoute from './routes/attest';
import realtimeRoute from './routes/realtime';
import { verifyAssertion } from './lib/appAttest';
import type { Env } from './types';
export type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'X-App-Attest-Key-Id', 'X-App-Attest-Assertion'] }));

// ── App Attest middleware ──────────────────────────────────────────────────────
// Applied to the /v1/generate and /v1/tts routes (not the attest registration
// endpoints themselves, which bootstrap the key).
app.use('/v1/generate/*', appAttestMiddleware);
app.use('/v1/tts/*', appAttestMiddleware);
app.use('/v1/transcribe/*', appAttestMiddleware);

async function appAttestMiddleware(
  c: { req: { header: (k: string) => string | undefined; raw: Request }; env: Env; json: (v: unknown, s?: number) => Response },
  next: () => Promise<void>,
) {
  const env = c.env;
  const keyId = c.req.header('X-App-Attest-Key-Id');
  const assertion = c.req.header('X-App-Attest-Assertion');

  if (keyId && assertion) {
    const bodyText = await c.req.raw.clone().text();
    const valid = await verifyAssertion(env, keyId, assertion, bodyText);
    if (!valid) {
      return c.json({ error: 'App Attest assertion invalid or counter replay' }, 401);
    }
    return next();
  }

  if (env.REQUIRE_ATTEST === 'true') {
    return c.json(
      { error: 'App Attest required. Register your device at /v1/attest/register first.' },
      401,
    );
  }

  return next();
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.route('/v1/generate', generateRoute);
app.route('/v1/tts', ttsRoute);
app.route('/v1/transcribe', transcribeRoute);
app.route('/v1/attest', attestRoute);
app.route('/v1/realtime', realtimeRoute);

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

export default app;
