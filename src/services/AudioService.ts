/**
 * AudioService — handles:
 *   1. Local TTS through the phone speaker (on-device model path)
 *   2. Collar speech: backend TTS → BLE stream
 *   3. μ-law helpers
 *
 * Phone-speaker speech on the backend path plays through the WebRTC Realtime
 * session, not here.
 *
 * Collar audio pipeline:
 *   llmService.generate() → text → Tts.speak() (phone speaker)
 *                                → μ-law encode → bluetoothService.streamAudio()
 */

import Tts from 'react-native-tts';
import type { TtsEventHandler } from 'react-native-tts';
import { Platform } from 'react-native';
import { bluetoothService, AUDIO_SAMPLE_RATE } from './BluetoothService';
import type { CollarAudioFormat } from './BluetoothService';
import { fetchBackendTts } from './LLMService';

class AudioService {
  private isTtsInitialized = false;

  // ── TTS ───────────────────────────────────────────────────────────────────

  async initTts(voiceRate: number = 0.5, voicePitch: number = 1.1): Promise<void> {
    if (this.isTtsInitialized) return;
    await Tts.getInitStatus();
    Tts.setDefaultRate(voiceRate, false);
    Tts.setDefaultPitch(voicePitch);
    if (Platform.OS === 'ios') {
      Tts.setDefaultLanguage('en-US');
      Tts.setIgnoreSilentSwitch('ignore');
    }
    this.isTtsInitialized = true;
  }

  /**
   * Speak text through the phone's speaker.
   * Returns a promise that resolves when speech finishes.
   */
  speak(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      Tts.stop(false);

      const onFinish: TtsEventHandler<'tts-finish'> = () => {
        Tts.removeEventListener('tts-finish', onFinish);
        Tts.removeEventListener('tts-cancel', onCancel);
        Tts.removeEventListener('tts-error', onError);
        resolve();
      };
      const onCancel: TtsEventHandler<'tts-cancel'> = () => {
        Tts.removeEventListener('tts-finish', onFinish);
        Tts.removeEventListener('tts-cancel', onCancel);
        Tts.removeEventListener('tts-error', onError);
        resolve();
      };
      const onError: TtsEventHandler<'tts-error'> = err => {
        Tts.removeEventListener('tts-finish', onFinish);
        Tts.removeEventListener('tts-cancel', onCancel);
        Tts.removeEventListener('tts-error', onError);
        reject(err);
      };

      Tts.addEventListener('tts-finish', onFinish);
      Tts.addEventListener('tts-cancel', onCancel);
      Tts.addEventListener('tts-error', onError);
      Tts.speak(text);
    });
  }

  stopSpeaking() {
    Tts.stop(false);
  }

  /**
   * Speak `text` through the collar's speaker: the backend synthesizes it
   * straight to 8 kHz μ-law (POST /v1/tts with format: 'ulaw8k') and we
   * forward the bytes over BLE. Resolves when the collar has finished playing.
   */
  async streamToCollar(
    text: string,
    opts: { backendUrl?: string; voiceStyle?: string } = {},
  ): Promise<void> {
    if (!bluetoothService.isConnected) {
      console.warn('[Audio] streamToCollar: collar not connected; dropping audio');
      return;
    }
    const clip = await AudioService.fetchCollarSpeech(text, opts);
    await bluetoothService.streamAudio(clip.bytes, { waitForPlayback: true, format: clip.format });
  }

  /** Collar speech format: 16 kHz IMA ADPCM (wideband, 8 kB/s). 'ulaw8k' is the fallback. */
  static readonly COLLAR_FORMAT: CollarAudioFormat = 'adpcm16k';

  /** Synthesize `text` for the collar via the backend (no BLE involved). */
  static async fetchCollarSpeech(
    text: string,
    opts: { backendUrl?: string; voiceStyle?: string } = {},
  ): Promise<{ bytes: Uint8Array; format: CollarAudioFormat }> {
    const t0 = Date.now();
    const format = AudioService.COLLAR_FORMAT;
    const res = await fetchBackendTts(opts.backendUrl ?? '', text, opts.voiceStyle ?? 'bouncy_excited', format);
    if (!res.ok) {
      throw new Error(`collar TTS request failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    // Guard against a backend that doesn't know this format yet (it would fall
    // back to MP3, which the collar would play as noise).
    const expectedType = format === 'adpcm16k' ? 'audio/x-adpcm' : 'audio/basic';
    const contentType = res.headers.get('Content-Type') ?? '';
    if (!contentType.startsWith(expectedType)) {
      throw new Error(
        `collar TTS returned ${contentType || 'unknown'} instead of ${expectedType} — deploy the backend (wrangler deploy)`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    console.log(`[Audio] collar TTS (${format}): "${text.slice(0, 40)}…" ${(bytes.length / 8000).toFixed(1)} s in ${Date.now() - t0} ms`);
    return { bytes, format };
  }

  /** Dev: stream a synthetic tone to the collar (no backend needed). */
  async streamTestToneToCollar(text: string): Promise<void> {
    if (!bluetoothService.isConnected) return;
    await bluetoothService.streamAudio(AudioService.encodeUlaw(synthesizePlaceholderPcm(text)));
  }

  // ── μ-law encoding ────────────────────────────────────────────────────────

  /**
   * Encode 16-bit linear PCM to 8-bit μ-law (ITU-T G.711).
   * Suitable for streaming over BLE to the collar's speaker.
   */
  static encodeUlaw(pcm16: Int16Array): Uint8Array {
    const BIAS = 0x84;
    const CLIP = 32635;
    const ulaw = new Uint8Array(pcm16.length);

    for (let i = 0; i < pcm16.length; i++) {
      let sample = pcm16[i];
      const sign = (sample >> 8) & 0x80;
      if (sign !== 0) sample = -sample;
      if (sample > CLIP) sample = CLIP;
      sample += BIAS;

      let exponent = 7;
      for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
      const mantissa = (sample >> (exponent + 3)) & 0x0f;
      ulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
    }

    return ulaw;
  }

  /**
   * Decode μ-law back to 16-bit PCM (for local playback testing).
   */
  static decodeUlaw(ulaw: Uint8Array): Int16Array {
    const pcm = new Int16Array(ulaw.length);
    for (let i = 0; i < ulaw.length; i++) {
      const byte = ~ulaw[i];
      const sign = byte & 0x80;
      const exponent = (byte >> 4) & 0x07;
      const mantissa = byte & 0x0f;
      let sample = ((mantissa << 3) + 0x84) << exponent;
      sample -= 0x84;
      pcm[i] = sign !== 0 ? -sample : sample;
    }
    return pcm;
  }
}

/**
 * Generate a simple amplitude-modulated tone whose duration scales with the
 * input text. Output is 16-bit linear PCM @ AUDIO_SAMPLE_RATE Hz, mono.
 */
function synthesizePlaceholderPcm(text: string): Int16Array {
  const charsPerSecond = 14;
  const seconds = Math.min(4, Math.max(0.4, text.length / charsPerSecond));
  const totalSamples = Math.floor(seconds * AUDIO_SAMPLE_RATE);
  const carrierHz = 380;
  const modulatorHz = 5;
  const pcm = new Int16Array(totalSamples);
  const twoPi = Math.PI * 2;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const envelope = 0.5 + 0.5 * Math.sin(twoPi * modulatorHz * t);
    const sample = Math.sin(twoPi * carrierHz * t) * envelope * 0.6;
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
  }
  return pcm;
}

export const audioService = new AudioService();
export { AudioService };
