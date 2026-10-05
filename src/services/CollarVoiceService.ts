/**
 * CollarVoiceService — turns the collar's microphone stream into chat input.
 *
 *   collar mic (8 kHz μ-law, 20 ms packets over BLE)
 *     → energy-based voice activity detection
 *     → one utterance (speech + trailing silence) buffered as μ-law
 *     → POST /v1/transcribe → text
 *     → onUtterance(text)  (useLLM feeds this into the chat)
 *
 * Suppressed while the collar speaker is playing so the dog doesn't answer
 * itself, and while a response is already being generated.
 */
import { Buffer } from 'buffer';
import { bluetoothService } from './BluetoothService';
import { AudioService } from './AudioService';
import { appAttestService } from './AppAttestService';

const SAMPLE_RATE = 8000;
const PACKET_MS = 20;

// VAD tuning (RMS of 16-bit PCM). The PDM mic on the XIAO Sense is quiet:
// room tone ≈ 60–150, normal speech at 1 m ≈ 400–2000.
const SPEECH_START_RMS = 350;   // packet must exceed this…
const SPEECH_START_PACKETS = 3; // …for this many packets (60 ms) to start
const SPEECH_END_MS = 450;      // silence needed to end an utterance
const SPEECH_END_RMS = 200;
const MIN_UTTERANCE_MS = 400;   // shorter than this is a bark/click, ignored
const MAX_UTTERANCE_MS = 15000; // cap so a noisy room can't buffer forever
const PRE_ROLL_PACKETS = 10;    // 200 ms kept from before speech start

type UtteranceCallback = (text: string, durationMs: number) => void;
type LevelCallback = (rms: number, speaking: boolean) => void;

class CollarVoiceService {
  onUtterance: UtteranceCallback | null = null;
  onLevel: LevelCallback | null = null;
  /** Return true to pause listening (e.g. while the LLM is generating). */
  shouldPause: (() => boolean) | null = null;

  backendUrl = '';
  recognizerPrompt = '';

  private enabled = false;
  private speaking = false;
  private aboveCount = 0;
  private silenceMs = 0;
  private utteranceMs = 0;
  private preRoll: Uint8Array[] = [];
  private chunks: Uint8Array[] = [];
  private transcribing = false;
  private lastSuppressedAt = 0;
  private stats = { packets: 0, suppressed: 0, maxRms: 0, lastLog: 0, reason: '' };

  /** Ignore the mic for `ms` from now (e.g. right after a reply finishes). */
  holdOff(ms: number) {
    this.lastSuppressedAt = Math.max(this.lastSuppressedAt, Date.now() + ms - 400);
    if (this.speaking) this.reset();
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    bluetoothService.onMicAudio = (ulaw, _seq) => this.handlePacket(ulaw);
    bluetoothService.setMicEnabled(true);
    this.reset();
    console.log('[CollarVoice] listening');
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    bluetoothService.setMicEnabled(false);
    bluetoothService.onMicAudio = null;
    this.reset();
    console.log('[CollarVoice] stopped');
  }

  get isListening() {
    return this.enabled && bluetoothService.isMicEnabled;
  }

  private reset() {
    this.speaking = false;
    this.aboveCount = 0;
    this.silenceMs = 0;
    this.utteranceMs = 0;
    this.preRoll = [];
    this.chunks = [];
  }

  private handlePacket(ulaw: Uint8Array) {
    // Copy: the buffer we get is a view into ble-plx's transient Buffer.
    const pkt = new Uint8Array(ulaw);
    const rms = rmsOfUlaw(pkt);
    this.logStatus(rms);

    const reason = bluetoothService.isStreamingAudio
      ? 'collar speaking'
      : this.transcribing
        ? 'transcribing'
        : (this.shouldPause?.() ?? false)
          ? 'generating'
          : Date.now() - this.lastSuppressedAt < 400
            ? 'hold-off'
            : '';
    if (reason) {
      this.stats.suppressed++;
      this.stats.reason = reason;
      if (reason !== 'hold-off') this.lastSuppressedAt = Date.now();
      if (this.speaking) this.reset();
      this.onLevel?.(rms, false);
      return;
    }

    if (!this.speaking) {
      this.preRoll.push(pkt);
      if (this.preRoll.length > PRE_ROLL_PACKETS) this.preRoll.shift();

      this.aboveCount = rms > SPEECH_START_RMS ? this.aboveCount + 1 : 0;
      if (this.aboveCount >= SPEECH_START_PACKETS) {
        this.speaking = true;
        this.chunks = [...this.preRoll];
        this.preRoll = [];
        this.silenceMs = 0;
        this.utteranceMs = this.chunks.length * PACKET_MS;
        console.log('[CollarVoice] speech start');
      }
      this.onLevel?.(rms, false);
      return;
    }

    this.chunks.push(pkt);
    this.utteranceMs += PACKET_MS;
    this.silenceMs = rms < SPEECH_END_RMS ? this.silenceMs + PACKET_MS : 0;
    this.onLevel?.(rms, true);

    if (this.silenceMs >= SPEECH_END_MS || this.utteranceMs >= MAX_UTTERANCE_MS) {
      const speechMs = this.utteranceMs - this.silenceMs;
      const chunks = this.chunks;
      this.reset();
      if (speechMs < MIN_UTTERANCE_MS) {
        console.log(`[CollarVoice] ignored short sound (${speechMs} ms)`);
        return;
      }
      void this.transcribe(concat(chunks), this.utteranceMsOf(chunks));
    }
  }

  /** One line every 5 s: proves packets are arriving and shows why they're ignored. */
  private logStatus(rms: number) {
    const st = this.stats;
    st.packets++;
    if (rms > st.maxRms) st.maxRms = rms;
    const now = Date.now();
    if (now - st.lastLog >= 5000) {
      console.log(
        `[CollarVoice] ${st.packets} pkts/5s, peak rms ${Math.round(st.maxRms)} (start>${SPEECH_START_RMS})` +
          (st.suppressed ? `, ${st.suppressed} ignored (${st.reason})` : '') +
          (this.speaking ? ', in speech' : ''),
      );
      st.packets = 0; st.suppressed = 0; st.maxRms = 0; st.lastLog = now;
    }
  }

  private utteranceMsOf(chunks: Uint8Array[]) {
    return chunks.reduce((n, c) => n + c.length, 0) / (SAMPLE_RATE / 1000);
  }

  private async transcribe(ulaw: Uint8Array, durationMs: number) {
    this.transcribing = true;
    const t0 = Date.now();
    try {
      const base = (this.backendUrl.trim() || DEFAULT_BACKEND_URL).replace(/\/$/, '');
      const bodyJSON = JSON.stringify({
        audio: Buffer.from(ulaw).toString('base64'),
        encoding: 'ulaw8k',
        ...(this.recognizerPrompt ? { prompt: this.recognizerPrompt } : {}),
      });
      const attestHeaders = await appAttestService.assertionHeaders(bodyJSON);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000); // never let a hung request mute the mic
      let res: Response;
      try {
        res = await fetch(`${base}/v1/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...attestHeaders },
          body: bodyJSON,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        console.warn('[CollarVoice] transcribe failed:', res.status, await res.text().catch(() => ''));
        return;
      }
      const { text } = (await res.json()) as { text: string };
      console.log(`[CollarVoice] ${Math.round(durationMs)} ms → "${text}" (${Date.now() - t0} ms)`);
      if (text && text.trim().length > 1) {
        if (!this.onUtterance) console.warn('[CollarVoice] transcript but no onUtterance handler');
        this.onUtterance?.(text.trim(), durationMs);
      }
    } catch (e) {
      console.warn('[CollarVoice] transcribe error:', e);
    } finally {
      this.transcribing = false;
      this.lastSuppressedAt = Date.now();
    }
  }
}

// Mirrors LLMService's default so this file doesn't import the LLM module.
const DEFAULT_BACKEND_URL = 'https://talking-dog-worker.benjamin-guzovsky.workers.dev';

function rmsOfUlaw(ulaw: Uint8Array): number {
  const pcm = AudioService.decodeUlaw(ulaw);
  let acc = 0;
  for (let i = 0; i < pcm.length; i++) acc += pcm[i]! * pcm[i]!;
  return Math.sqrt(acc / Math.max(1, pcm.length));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export const collarVoiceService = new CollarVoiceService();
export { CollarVoiceService };
