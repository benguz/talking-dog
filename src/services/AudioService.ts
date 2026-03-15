/**
 * AudioService — handles:
 *   1. Microphone recording (for future voice input to LLM)
 *   2. TTS playback through phone speaker
 *   3. μ-law encoding for streaming audio to the collar
 *
 * Collar audio pipeline:
 *   llmService.generate() → text → Tts.speak() (phone speaker)
 *                                → μ-law encode → bluetoothService.streamAudio()
 */

import AudioRecorderPlayer, {
  AudioEncoderAndroidType,
  AudioSourceAndroidType,
  AVEncoderAudioQualityIOSType,
} from 'react-native-audio-recorder-player';
import type { RecordBackType } from 'react-native-audio-recorder-player';
import Tts from 'react-native-tts';
import type { TtsEventHandler } from 'react-native-tts';
import { Platform } from 'react-native';

class AudioService {
  private isRecording = false;
  private isTtsInitialized = false;

  // ── TTS ───────────────────────────────────────────────────────────────────

  async initTts(voiceRate: number = 0.5, voicePitch: number = 1.1): Promise<void> {
    if (this.isTtsInitialized) return;
    await Tts.getInitStatus();
    Tts.setDefaultRate(voiceRate);
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
      Tts.stop();

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
    Tts.stop();
  }

  // ── Microphone recording ──────────────────────────────────────────────────

  async startRecording(): Promise<void> {
    if (this.isRecording) return;
    this.isRecording = true;
    await AudioRecorderPlayer.startRecorder(undefined, {
      AVSampleRateKeyIOS: 8000,
      AVNumberOfChannelsKeyIOS: 1,
      AVEncoderAudioQualityKeyIOS: AVEncoderAudioQualityIOSType.low,
      AVFormatIDKeyIOS: 'lpcm',
      AudioSourceAndroid: AudioSourceAndroidType.MIC,
      AudioEncoderAndroid: AudioEncoderAndroidType.AAC,
    });
  }

  async stopRecording(): Promise<string> {
    if (!this.isRecording) return '';
    this.isRecording = false;
    const path = await AudioRecorderPlayer.stopRecorder();
    AudioRecorderPlayer.removeRecordBackListener();
    return path;
  }

  onRecordingProgress(cb: (dBFS: number) => void) {
    AudioRecorderPlayer.addRecordBackListener((e: RecordBackType) => {
      cb(e.currentMetering ?? -60);
    });
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

export const audioService = new AudioService();
export { AudioService };
