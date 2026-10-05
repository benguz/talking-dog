/**
 * AppAttestService — JS facade over the AppAttestModule native bridge.
 *
 * Lifecycle:
 *   1. On first launch: getOrCreateKey() → fetches a challenge, generates a key,
 *      attests it with Apple, and registers the result with the backend.
 *   2. On every API request: assertionHeaders(body) → returns the two assertion
 *      headers the Cloudflare Worker middleware expects.
 *
 * Degraded mode (iOS Simulator):
 *   - DCAppAttestService.isSupported → false → the native module resolves with null.
 *   - This service detects the null response and silently skips attestation.
 *   - The Worker allows the request through when REQUIRE_ATTEST !== "true".
 */

import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_ID_STORAGE = '@talking_dog_attest_key';

interface NativeAppAttest {
  generateKey(): Promise<string | null>;
  attestKey(keyId: string, challengeB64: string): Promise<string | null>;
  generateAssertion(keyId: string, requestBodyJSON: string): Promise<string | null>;
}

const Native = NativeModules.AppAttestModule as NativeAppAttest | undefined;

class AppAttestService {
  private keyId: string | null = null;
  private initialized = false;
  private backendBaseUrl = '';

  setBackendUrl(url: string) {
    this.backendBaseUrl = url.replace(/\/$/, '');
  }

  /**
   * Must be called once on app startup (after settings are hydrated).
   * Idempotent — returns immediately if already registered.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!Native) {
      console.warn('[AppAttest] Native module not available');
      return;
    }

    try {
      // Restore a previously registered key
      const stored = await AsyncStorage.getItem(KEY_ID_STORAGE);
      if (stored) {
        this.keyId = stored;
        return;
      }

      // First run: generate + attest a new key
      const keyId = await Native.generateKey();
      if (!keyId) {
        // Simulator or unsupported device — graceful skip
        return;
      }

      // Fetch a fresh challenge from the backend
      const challengeRes = await fetch(`${this.backendBaseUrl}/v1/attest/challenge`);
      if (!challengeRes.ok) {
        throw new Error(`Challenge fetch failed: ${challengeRes.status}`);
      }
      const { challenge } = (await challengeRes.json()) as { challenge: string };

      // Attest the key with Apple
      const attestation = await Native.attestKey(keyId, challenge);
      if (!attestation) {
        return; // Simulator
      }

      // Register with the backend
      const regRes = await fetch(`${this.backendBaseUrl}/v1/attest/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId, attestation, challenge }),
      });

      if (!regRes.ok) {
        const err = (await regRes.json()) as { error?: string };
        throw new Error(`Registration failed: ${err.error ?? regRes.status}`);
      }

      this.keyId = keyId;
      await AsyncStorage.setItem(KEY_ID_STORAGE, keyId);
    } catch (e) {
      console.warn('[AppAttest] initialization failed, running without attestation:', e);
    }
  }

  /**
   * Returns headers to add to an API request, or an empty object if attestation
   * is unavailable (Simulator, unsupported device, initialization failed).
   */
  async assertionHeaders(requestBodyJSON: string): Promise<Record<string, string>> {
    if (!Native || !this.keyId) return {};

    try {
      const assertion = await Native.generateAssertion(this.keyId, requestBodyJSON);
      if (!assertion) return {};
      return {
        'X-App-Attest-Key-Id': this.keyId,
        'X-App-Attest-Assertion': assertion,
      };
    } catch (e) {
      console.warn('[AppAttest] failed to generate assertion:', e);
      return {};
    }
  }
}

export const appAttestService = new AppAttestService();
