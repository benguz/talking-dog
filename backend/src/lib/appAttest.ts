/**
 * Apple App Attest verification for Cloudflare Workers.
 *
 * Attestation (one-time per device install):
 *   POST /v1/attest/register  { keyId, attestation (base64), challenge (base64) }
 *   → verifies the certificate chain against Apple's root CA, confirms the
 *     device is genuine, stores the public key in KV.
 *
 * Assertion (per-request):
 *   Header X-App-Attest-Key-Id: <keyId>
 *   Header X-App-Attest-Assertion: <base64 CBOR assertion>
 *   → verifies the ECDSA-P256 signature over SHA256(authData || SHA256(body)),
 *     checks the counter hasn't gone backwards, updates the stored counter.
 *
 * References:
 *   https://developer.apple.com/documentation/devicecheck/validating_apps_that_connect_to_your_server
 */

import { decode as cborDecode } from 'cbor-x';
import { X509Certificate } from '@peculiar/x509';

// Apple App Attest Root CA (PEM).
// Downloaded from https://www.apple.com/certificateauthority/ — "Apple App Attest Root CA"
// Verify the fingerprint independently before deploying.
const APPLE_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTbNFNByn/M
Rp9aq/KQZN5zyZrQD6cECk9FQd+/SxGJlPaFJlHyLPYHbdMoT7nHp8GEIwNNbj7
kxmGbAFHBEUJ7bAoTNHm+3CjXKQnFYm2IKIjo0IwQDAdBgNVHQ4EFgQUuLe/dJLN
v5kGfBr6mMuniGx3nqswDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIxAKulGbSFkDSZusGjbNkAhubqgnzE6c8g7GQ3IJOL
uBLcLwUiDng9SXMDB2/GFnJoXgIwYSSbvSgmHAtFGJIFSqcQNBsmFpkAhN2UtFIN
QKnhp3c+yNrv9GXV2Cws+C4hOtLk
-----END CERTIFICATE-----`;

// OID 1.2.840.113635.100.8.2 — Apple's App Attest nonce extension.
// Encoded as DER bytes for comparison.
const ATTEST_NONCE_OID_HEX = '2a864886f763640802';

interface KVRecord {
  publicKeyJwk: JsonWebKey;
  counter: number;
}

export interface Env {
  APP_ATTEST_KV: KVNamespace;
  APPLE_TEAM_ID: string;
  APPLE_BUNDLE_ID: string;
}

// ── Attestation registration ───────────────────────────────────────────────────

export async function registerAttestation(
  env: Env,
  keyId: string,
  attestationB64: string,
  challengeB64: string,
): Promise<void> {
  const attestationBytes = base64ToBytes(attestationB64);
  const challengeBytes = base64ToBytes(challengeB64);

  // 1. Decode CBOR
  const decoded = cborDecode(attestationBytes) as {
    fmt: string;
    attStmt: { x5c: Uint8Array[]; receipt: Uint8Array };
    authData: Uint8Array;
  };

  if (decoded.fmt !== 'apple-appattest') {
    throw new Error(`Unexpected attestation format: ${decoded.fmt}`);
  }

  const { x5c, } = decoded.attStmt;
  const authData = decoded.authData;

  if (!x5c || x5c.length < 2) {
    throw new Error('Certificate chain too short');
  }

  // 2. Parse certs
  const leafCert = new X509Certificate(x5c[0]!);
  const caCert = new X509Certificate(x5c[1]!);
  const rootCert = new X509Certificate(pemToDer(APPLE_ROOT_CA_PEM));

  // 3. Verify certificate chain
  await verifyCertChain(leafCert, caCert, rootCert);

  // 4. Verify nonce in leaf cert extension
  //    nonce = SHA256(authData || SHA256(challenge))
  const challengeHash = new Uint8Array(await crypto.subtle.digest('SHA-256', challengeBytes));
  const composite = concat(authData, challengeHash);
  const expectedNonce = new Uint8Array(await crypto.subtle.digest('SHA-256', composite));

  const extensionNonce = extractAttestNonce(leafCert);
  if (!bytesEqual(extensionNonce, expectedNonce)) {
    throw new Error('Nonce mismatch — challenge/authData tampered');
  }

  // 5. Verify keyId = SHA256(leaf public key DER)
  const pubKeyDer = leafCert.publicKey.rawData;
  const computedKeyId = bytesToBase64(
    new Uint8Array(await crypto.subtle.digest('SHA-256', pubKeyDer)),
  );
  if (computedKeyId !== keyId) {
    throw new Error('keyId does not match leaf certificate public key');
  }

  // 6. Verify appIdHash = SHA256(teamId || bundleId) matches first 32 bytes of authData
  const appIdStr = `${env.APPLE_TEAM_ID}.${env.APPLE_BUNDLE_ID}`;
  const appIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(appIdStr)),
  );
  if (!bytesEqual(authData.slice(0, 32), appIdHash)) {
    throw new Error('App ID hash mismatch');
  }

  // 7. Verify initial counter is 0
  const counter = readUint32BE(authData, 33);
  if (counter !== 0) {
    throw new Error(`Expected counter 0, got ${counter}`);
  }

  // 8. Store public key in KV
  const importedKey = await crypto.subtle.importKey(
    'spki',
    pubKeyDer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', importedKey)) as JsonWebKey;
  const record: KVRecord = { publicKeyJwk, counter: 0 };
  await env.APP_ATTEST_KV.put(kvKey(keyId), JSON.stringify(record));
}

// ── Per-request assertion verification ────────────────────────────────────────

export async function verifyAssertion(
  env: Env,
  keyId: string,
  assertionB64: string,
  requestBodyText: string,
): Promise<boolean> {
  try {
    const record = await getRecord(env, keyId);
    if (!record) return false;

    const assertionBytes = base64ToBytes(assertionB64);
    const decoded = cborDecode(assertionBytes) as {
      signature: Uint8Array;
      authenticatorData: Uint8Array;
    };

    const { signature, authenticatorData } = decoded;

    // 1. Verify appIdHash
    const appIdStr = `${env.APPLE_TEAM_ID}.${env.APPLE_BUNDLE_ID}`;
    const appIdHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(appIdStr)),
    );
    if (!bytesEqual(authenticatorData.slice(0, 32), appIdHash)) return false;

    // 2. Verify counter is strictly increasing
    const counter = readUint32BE(authenticatorData, 33);
    if (counter <= record.counter) return false;

    // 3. Reconstruct nonce = SHA256(authenticatorData || SHA256(requestBody))
    const bodyHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestBodyText)),
    );
    const nonce = new Uint8Array(
      await crypto.subtle.digest('SHA-256', concat(authenticatorData, bodyHash)),
    );

    // 4. Verify ECDSA signature over nonce
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      record.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature,
      nonce,
    );
    if (!valid) return false;

    // 5. Persist updated counter
    await env.APP_ATTEST_KV.put(kvKey(keyId), JSON.stringify({ ...record, counter }));
    return true;
  } catch {
    return false;
  }
}

export async function getRecord(env: Env, keyId: string): Promise<KVRecord | null> {
  const raw = await env.APP_ATTEST_KV.get(kvKey(keyId));
  if (!raw) return null;
  return JSON.parse(raw) as KVRecord;
}

// ── Certificate helpers ────────────────────────────────────────────────────────

async function verifyCertChain(
  leaf: X509Certificate,
  intermediate: X509Certificate,
  root: X509Certificate,
): Promise<void> {
  const intKey = await intermediate.publicKey.export();
  const leafValid = await leaf.verify({ publicKey: intKey });
  if (!leafValid) throw new Error('Leaf certificate signature invalid');

  const rootKey = await root.publicKey.export();
  const intValid = await intermediate.verify({ publicKey: rootKey });
  if (!intValid) throw new Error('Intermediate certificate signature invalid');

  // Verify root is self-signed and matches our pinned cert
  const rootSelfValid = await root.verify({ publicKey: rootKey });
  if (!rootSelfValid) throw new Error('Root certificate self-signature invalid');
}

function extractAttestNonce(cert: X509Certificate): Uint8Array {
  // Look for the Apple-specific extension and pull the nonce bytes out.
  // The extension value is a DER SEQUENCE containing an OCTET STRING.
  for (const ext of cert.extensions) {
    if (ext.type.replace(/\./g, '') === ATTEST_NONCE_OID_HEX) {
      // value is DER SEQUENCE { OCTET STRING { nonce } }
      const extValue = ext.value as ArrayBuffer | ArrayBufferView;
      const der = extValue instanceof ArrayBuffer
        ? new Uint8Array(extValue)
        : new Uint8Array((extValue as ArrayBufferView).buffer as ArrayBuffer);
      // Skip outer SEQUENCE (tag 30, length) and inner OCTET STRING (tag 04, length)
      let offset = 0;
      if (der[offset] === 0x30) offset += 2 + (der[offset + 1]! > 0x80 ? der[offset + 1]! - 0x80 + 1 : 0);
      if (der[offset] === 0x04) offset += 2;
      return der.slice(offset);
    }
  }
  throw new Error('Apple App Attest nonce extension not found in leaf cert');
}

// ── Byte helpers ───────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function bytesEqual(a: Uint8Array | ArrayBuffer, b: Uint8Array): boolean {
  const av = a instanceof Uint8Array ? a : new Uint8Array(a);
  if (av.length !== b.length) return false;
  for (let i = 0; i < av.length; i++) if (av[i] !== b[i]) return false;
  return true;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>> 0
  );
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const bytes = base64ToBytes(b64);
  // Ensure we return a plain ArrayBuffer, not a SharedArrayBuffer slice
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function kvKey(keyId: string): string {
  return `attest:${keyId}`;
}
