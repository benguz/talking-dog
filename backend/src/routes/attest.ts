import { Hono } from 'hono';
import type { Env } from '../types';
import { registerAttestation, getRecord } from '../lib/appAttest';

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/attest/challenge
 * Returns a fresh random challenge the app must include when calling attestKey()
 * and when registering. Stored in KV with a 5-minute TTL.
 */
app.get('/challenge', async (c) => {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...challenge));
  // Store under a temporary key so we can verify it wasn't fabricated
  await c.env.APP_ATTEST_KV.put(`challenge:${b64}`, '1', { expirationTtl: 300 });
  return c.json({ challenge: b64 });
});

/**
 * POST /v1/attest/register
 * Body: { keyId: string, attestation: string (base64), challenge: string (base64) }
 *
 * Verifies the Apple App Attest attestation object against Apple's root CA,
 * checks the nonce, and stores the public key in KV for future assertion checks.
 */
app.post('/register', async (c) => {
  const body = await c.req.json<{
    keyId: string;
    attestation: string;
    challenge: string;
  }>();

  const { keyId, attestation, challenge } = body;
  if (!keyId || !attestation || !challenge) {
    return c.json({ error: 'keyId, attestation, and challenge are required' }, 400);
  }

  // Verify the challenge was issued by us
  const storedChallenge = await c.env.APP_ATTEST_KV.get(`challenge:${challenge}`);
  if (!storedChallenge) {
    return c.json({ error: 'Challenge expired or not issued by this server' }, 400);
  }
  await c.env.APP_ATTEST_KV.delete(`challenge:${challenge}`);

  // Check not already registered
  const existing = await getRecord(c.env, keyId);
  if (existing) {
    return c.json({ error: 'Key already registered' }, 409);
  }

  try {
    await registerAttestation(c.env, keyId, attestation, challenge);
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Attestation verification failed: ${msg}` }, 400);
  }
});

export default app;
