/**
 * BluetoothService — manages BLE connection to the Talking Dog Collar.
 *
 * Collar BLE layout:
 *   Service:  COLLAR_SERVICE_UUID
 *   CHAR_MEMS_DATA (notify)  — 12-byte MPU-6050 packets [ax,ay,az,gx,gy,gz] int16 LE
 *   CHAR_AUDIO_TX  (write)   — audio chunks phone→collar speaker
 *   CHAR_TRIGGER   (notify)  — uint8 trigger events from collar
 *   CHAR_STATUS    (notify)  — uint8 status/battery byte
 *   CHAR_CAMERA    (notify)  — chunked JPEG stream (ESP32-CAM collar only; skipped if absent)
 *   CHAR_MIC       (notify)  — collar microphone: [seqHi, seqLo, ...8 kHz μ-law] (XIAO collar)
 *
 * CHAR_CAMERA protocol (matches collar.ino):
 *   Header  [0x01, event_type, total_len(4B big-endian)]
 *   Chunk   [0x02, seq_hi, seq_lo, ...data]
 *   EOF     [0x03]  → onCameraFrame(eventType, jpegBytes) fires
 *
 * Audio TX packet protocol:
 *   First packet:  [0xFF, 0xFF, totalChunksHi, totalChunksLo, srHi, srLo, enc]
 *   Data packets:  [seqHi, seqLo, ...up to (MTU-5) bytes audio]  write WITH response
 *                  (ble-plx's write-without-response never resolves on iOS)
 *   End packet:    [0xFF, 0xFE]
 * Data packets are paced so the collar never holds more than ~1.5 s ahead of
 * real time (its buffer is 4 s); at 8 kHz μ-law that is 8 kB/s.
 */

import { BleManager, Device, BleError, Characteristic } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import { cameraService } from './CameraService';
import {
  CHAR_AUDIO_TX,
  CHAR_CAMERA,
  CHAR_MEMS_DATA,
  CHAR_MIC,
  CHAR_STATUS,
  CHAR_TRIGGER,
  COLLAR_NAME_PREFIX,
  COLLAR_SERVICE_UUID,
  CollarTrigger,
  MemsData,
} from '../types';

type TriggerCallback = (trigger: CollarTrigger) => void;
type MemsCallback = (data: MemsData) => void;
type DisconnectCallback = () => void;
/** Called when a full JPEG frame has been reassembled from BLE chunks. */
type CameraFrameCallback = (eventType: CollarTrigger, jpeg: Uint8Array) => void;
/** Called for every mic packet from the collar: 8 kHz μ-law bytes (header already stripped). */
type MicAudioCallback = (ulaw: Uint8Array, seq: number) => void;

const AUDIO_SAMPLE_RATE = 8000; // Hz — default (μ-law) rate; ADPCM streams run at 16 kHz
/** Collar audio encodings (header byte 7). Both run at 8 kB/s over BLE. */
export type CollarAudioFormat = 'ulaw8k' | 'adpcm16k';
const FORMAT_INFO: Record<CollarAudioFormat, { enc: number; sampleRate: number; bytesPerSec: number }> = {
  ulaw8k: { enc: 1, sampleRate: 8000, bytesPerSec: 8000 },
  adpcm16k: { enc: 3, sampleRate: 16000, bytesPerSec: 8000 },
};
const AUDIO_MAX_CHUNK = 242;    // MTU 247 − 3 ATT − 2 seq: one packet per ATT PDU
const AUDIO_LEAD_SECONDS = 3.0; // how far ahead of real time we let the collar buffer (it holds 8 s)

class BluetoothService {
  private manager: BleManager;
  private device: Device | null = null;
  private triggerSub: { remove: () => void } | null = null;
  private memsSub: { remove: () => void } | null = null;
  private cameraSub: { remove: () => void } | null = null;
  private micSub: { remove: () => void } | null = null;
  /** UUIDs (lower-case) of characteristics the connected collar actually exposes. */
  private availableChars = new Set<string>();
  private _isStreamingAudio = false;
  /** When the collar will finish playing everything sent so far (epoch ms). */
  private playbackEndsAt = 0;
  /** Clips are sent strictly in order; each call chains onto this. */
  private sendChain: Promise<void> = Promise.resolve();
  /** Largest audio payload per packet that this phone/collar pair accepts (probed). */
  private audioChunkSize: number | null = null;

  onTrigger: TriggerCallback | null = null;
  onMems: MemsCallback | null = null;
  /** Most recent IMU packet (updated at 50 Hz; read this instead of the store for live data). */
  lastMems: MemsData | null = null;
  onDisconnect: DisconnectCallback | null = null;
  onCameraFrame: CameraFrameCallback | null = null;
  onMicAudio: MicAudioCallback | null = null;

  // JPEG reassembly state
  private cameraEventType: CollarTrigger = CollarTrigger.ALERT;
  private cameraTotalLen = 0;
  private cameraChunks: Map<number, Uint8Array> = new Map();
  private cameraReceivedBytes = 0;

  constructor() {
    this.manager = new BleManager();
  }

  destroy() {
    this.disconnect();
    this.manager.destroy();
  }

  // ── Scanning ────────────────────────────────────────────────────────────────

  async scanAndConnect(
    onDeviceFound?: (name: string) => void,
  ): Promise<Device> {
    console.log(`[BLE] startDeviceScan — service filter: ${COLLAR_SERVICE_UUID}`);
    return new Promise((resolve, reject) => {
      this.manager.startDeviceScan(
        [COLLAR_SERVICE_UUID],
        { allowDuplicates: false },
        async (error: BleError | null, device: Device | null) => {
          if (error) {
            console.error('[BLE] scan error:', error.message, `(code ${error.errorCode})`);
            this.manager.stopDeviceScan();
            reject(error);
            return;
          }
          if (!device) return;

          const name = device.name ?? device.localName ?? '(no name)';
          console.log(`[BLE] collar found: id=${device.id} name="${name}" rssi=${device.rssi} — connecting…`);
          this.manager.stopDeviceScan();
          onDeviceFound?.(name);

          try {
            const connected = await this.connectToDevice(device);
            resolve(connected);
          } catch (e) {
            console.error('[BLE] connectToDevice failed:', e);
            reject(e);
          }
        },
      );
    });
  }

  async stopScan() {
    this.manager.stopDeviceScan();
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  private async connectToDevice(device: Device): Promise<Device> {
    console.log(`[BLE] connecting to "${device.name ?? device.id}"…`);
    const connected = await Promise.race([
      device.connect({ autoConnect: false, requestMTU: 512 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('connect() timed out after 10s')), 10_000),
      ),
    ]);
    console.log(`[BLE] connected — MTU: ${connected.mtu}`);

    console.log('[BLE] discovering services and characteristics…');
    await connected.discoverAllServicesAndCharacteristics();
    const services = await connected.services();
    console.log(`[BLE] discovered ${services.length} service(s):`);
    this.availableChars.clear();
    for (const svc of services) {
      console.log(`[BLE]   service: ${svc.uuid}`);
      const chars = await svc.characteristics();
      for (const c of chars) {
        this.availableChars.add(c.uuid.toLowerCase());
        console.log(`[BLE]     char: ${c.uuid}  isNotifiable=${c.isNotifiable}  isWritableWithResponse=${c.isWritableWithResponse}  isWritableWithoutResponse=${c.isWritableWithoutResponse}`);
      }
    }
    console.log('[BLE] discovery complete');
    this.device = connected;

    connected.onDisconnected(() => {
      console.log('[BLE] disconnected');
      this.device = null;
      this.triggerSub?.remove();
      this.memsSub?.remove();
      this.cameraSub?.remove();
      this.micSub?.remove();
      this.micSub = null;
      this._isStreamingAudio = false;
      this.playbackEndsAt = 0;
      this.audioChunkSize = null;
      this.onDisconnect?.();
    });

    this.subscribeTriggers();
    this.subscribeMems();
    if (this.hasCharacteristic(CHAR_CAMERA)) {
      this.subscribeCamera();
    }
    console.log(
      `[BLE] subscribed: trigger, MEMS` +
        (this.hasCharacteristic(CHAR_CAMERA) ? ', camera' : '') +
        (this.hasCharacteristic(CHAR_MIC) ? ' — mic available (subscribe with setMicEnabled)' : ''),
    );

    return connected;
  }

  disconnect() {
    this.triggerSub?.remove();
    this.memsSub?.remove();
    this.cameraSub?.remove();
    this.micSub?.remove();
    this.micSub = null;
    this.device?.cancelConnection().catch(() => {});
    this.device = null;
  }

  get isConnected() {
    return this.device != null;
  }

  /**
   * True while speech is queued or playing on the collar speaker (from the
   * first byte sent until the collar's buffer has drained, plus a short tail).
   */
  get isStreamingAudio() {
    return this._isStreamingAudio || Date.now() < this.playbackEndsAt + 300;
  }

  /** Epoch ms when everything queued so far will have finished playing. */
  get playbackEndsAtMs() {
    return this.playbackEndsAt;
  }

  hasCharacteristic(uuid: string) {
    return this.availableChars.has(uuid.toLowerCase());
  }

  get hasMic() {
    return this.hasCharacteristic(CHAR_MIC);
  }

  get isMicEnabled() {
    return this.micSub != null;
  }

  /**
   * Turn the collar microphone stream on/off. Subscribing is what makes the
   * collar start sending (it only streams while someone listens), so keep it
   * off when not needed to save BLE bandwidth and battery.
   */
  setMicEnabled(enabled: boolean) {
    if (!this.device || !this.hasMic) return;
    if (enabled && !this.micSub) {
      this.micSub = this.device.monitorCharacteristicForService(
        COLLAR_SERVICE_UUID,
        CHAR_MIC,
        (error: BleError | null, char: Characteristic | null) => {
          if (error) {
            console.error('[BLE] mic notify error:', error.message);
            return;
          }
          if (!char?.value) return;
          const bytes = Buffer.from(char.value, 'base64');
          if (bytes.length < 3) return;
          const seq = (bytes[0]! << 8) | bytes[1]!;
          this.onMicAudio?.(new Uint8Array(bytes.buffer, bytes.byteOffset + 2, bytes.length - 2), seq);
        },
      );
      console.log('[BLE] mic stream ON');
    } else if (!enabled && this.micSub) {
      this.micSub.remove();
      this.micSub = null;
      console.log('[BLE] mic stream off');
    }
  }

  get deviceName() {
    return this.device?.name ?? this.device?.localName ?? null;
  }

  // ── Dev simulator ───────────────────────────────────────────────────────────
  // The iOS simulator does not expose CoreBluetooth, so for in-simulator testing
  // we let the developer inject fake collar events directly through the same
  // callback path the real BLE notifications would take.

  simulateTrigger(trigger: CollarTrigger) {
    this.onTrigger?.(trigger);
  }

  simulateMems(data: MemsData) {
    this.onMems?.(data);
  }

  simulateDisconnect() {
    this.onDisconnect?.();
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  private subscribeTriggers() {
    if (!this.device) return;
    this.triggerSub = this.device.monitorCharacteristicForService(
      COLLAR_SERVICE_UUID,
      CHAR_TRIGGER,
      (error: BleError | null, char: Characteristic | null) => {
        if (error) {
          console.error('[BLE] trigger notify error:', error.message);
          return;
        }
        if (!char?.value) return;
        const bytes = Buffer.from(char.value, 'base64');
        if (bytes.length < 1) return;
        const trigger = bytes[0] as CollarTrigger;
        console.log(`[BLE] trigger received: 0x${trigger.toString(16).padStart(2, '0')}`);
        if (Object.values(CollarTrigger).includes(trigger)) {
          this.onTrigger?.(trigger);
        } else {
          console.warn(`[BLE] unknown trigger byte: 0x${trigger.toString(16)}`);
        }
      },
    );
  }

  private subscribeMems() {
    if (!this.device) return;
    this.memsSub = this.device.monitorCharacteristicForService(
      COLLAR_SERVICE_UUID,
      CHAR_MEMS_DATA,
      (error: BleError | null, char: Characteristic | null) => {
        if (error) {
          console.error('[BLE] MEMS notify error:', error.message);
          return;
        }
        if (!char?.value) return;
        const bytes = Buffer.from(char.value, 'base64');
        if (bytes.length < 12) return;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const data: MemsData = {
          ax: view.getInt16(0, true),
          ay: view.getInt16(2, true),
          az: view.getInt16(4, true),
          gx: view.getInt16(6, true),
          gy: view.getInt16(8, true),
          gz: view.getInt16(10, true),
          timestamp: Date.now(),
        };
        this.onMems?.(data);
      },
    );
  }

  private subscribeCamera() {
    if (!this.device) return;
    this.cameraSub = this.device.monitorCharacteristicForService(
      COLLAR_SERVICE_UUID,
      CHAR_CAMERA,
      (error: BleError | null, char: Characteristic | null) => {
        if (error) {
          console.error('[BLE] camera notify error:', error.message);
          return;
        }
        if (!char?.value) return;
        const bytes = Buffer.from(char.value, 'base64');
        if (bytes.length === 0) return;

        const pktType = bytes[0];

        if (pktType === 0x01 && bytes.length >= 6) {
          // Header — start of a new frame; reset reassembly state
          this.cameraEventType = bytes[1] as CollarTrigger;
          this.cameraTotalLen =
            (bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5];
          this.cameraChunks.clear();
          this.cameraReceivedBytes = 0;
          console.log(`[BLE] camera frame start — event=0x${this.cameraEventType.toString(16).padStart(2, '0')}, totalLen=${this.cameraTotalLen}`);

        } else if (pktType === 0x02 && bytes.length >= 4) {
          // Data chunk
          const seq = (bytes[1] << 8) | bytes[2];
          const data = new Uint8Array(bytes.buffer, bytes.byteOffset + 3, bytes.length - 3);
          this.cameraChunks.set(seq, data);
          this.cameraReceivedBytes += data.length;

        } else if (pktType === 0x03) {
          // EOF — assemble and deliver
          if (this.cameraTotalLen === 0 || this.cameraChunks.size === 0) return;

          const jpeg = new Uint8Array(this.cameraTotalLen);
          let offset = 0;
          const seqs = Array.from(this.cameraChunks.keys()).sort((a, b) => a - b);
          for (const seq of seqs) {
            const chunk = this.cameraChunks.get(seq)!;
            jpeg.set(chunk, offset);
            offset += chunk.length;
          }

          console.log(`[BLE] camera frame complete — ${this.cameraChunks.size} chunks, ${offset} bytes assembled`);
          const assembled = jpeg.slice(0, offset);
          cameraService.setLastCollarFrame(assembled);
          this.onCameraFrame?.(this.cameraEventType, assembled);

          // Reset
          this.cameraChunks.clear();
          this.cameraTotalLen = 0;
          this.cameraReceivedBytes = 0;
        } else {
          console.warn(`[BLE] camera: unknown pktType=0x${pktType.toString(16)}, len=${bytes.length}`);
        }
      },
    );
  }

  // ── Audio TX ─────────────────────────────────────────────────────────────────

  /**
   * Stream μ-law encoded PCM audio to the collar's speaker.
   * `audioData` should be 8 kHz, mono, μ-law encoded Uint8Array.
   */
  async streamAudio(
    audioData: Uint8Array,
    opts: { waitForPlayback?: boolean; format?: CollarAudioFormat } = {},
  ): Promise<void> {
    if (!this.device) throw new Error('Not connected to collar');
    // Queue behind any clip still being sent so sentences play in order.
    const run = this.sendChain.then(() => this.sendClip(audioData, opts.format ?? 'ulaw8k'));
    this.sendChain = run.catch(() => undefined);
    await run;
    if (opts.waitForPlayback) {
      const remaining = this.playbackEndsAt - Date.now();
      if (remaining > 0) await sleep(remaining + 300);
    }
  }

  private async sendClip(audioData: Uint8Array, format: CollarAudioFormat): Promise<void> {
    if (!this.device) throw new Error('Not connected to collar');
    this._isStreamingAudio = true;
    try {
      const info = FORMAT_INFO[format];
      const chunkSize = await this.probeAudioChunkSize();
      const totalChunks = Math.ceil(audioData.length / chunkSize);
      const clipMs = (audioData.length / info.bytesPerSec) * 1000;
      console.log(`[BLE] streamAudio: ${format} ${audioData.length} B (${(clipMs / 1000).toFixed(1)} s), ${totalChunks} × ${chunkSize} B`);

      const header = Buffer.alloc(7);
      header[0] = 0xff;
      header[1] = 0xff;
      header.writeUInt16BE(Math.min(totalChunks, 0xffff), 2);
      header.writeUInt16BE(info.sampleRate, 4);
      header[6] = info.enc;
      await this.writeCharacteristic(header, true);

      // If the collar is idle, playback starts after its 200 ms pre-buffer;
      // otherwise this clip plays right after what is already queued.
      const t0 = Date.now();
      if (this.playbackEndsAt < t0) this.playbackEndsAt = t0 + 200;

      for (let seq = 0; seq < totalChunks; seq++) {
        if (!this.device) throw new Error('disconnected mid-stream');
        const chunkStart = seq * chunkSize;
        const chunkEnd = Math.min(chunkStart + chunkSize, audioData.length);
        const packet = Buffer.alloc(2 + (chunkEnd - chunkStart));
        packet.writeUInt16BE(seq & 0xffff, 0);
        Buffer.from(audioData.subarray(chunkStart, chunkEnd)).copy(packet, 2);
        await this.writeCharacteristic(packet, true);
        this.playbackEndsAt += ((chunkEnd - chunkStart) / info.bytesPerSec) * 1000;

        // Pace: never queue more than AUDIO_LEAD_SECONDS ahead of playback
        // (the collar's ring buffer holds 4 s).
        const aheadMs = this.playbackEndsAt - Date.now();
        if (aheadMs > AUDIO_LEAD_SECONDS * 1000) {
          await sleep(aheadMs - AUDIO_LEAD_SECONDS * 1000);
        }
      }

      await this.writeCharacteristic(Buffer.from([0xff, 0xfe]), true);
      const secs = (Date.now() - t0) / 1000;
      console.log(`[BLE] streamAudio sent in ${secs.toFixed(1)} s; playback ends in ${((this.playbackEndsAt - Date.now()) / 1000).toFixed(1)} s`);
    } finally {
      this._isStreamingAudio = false;
    }
  }

  /**
   * Audio bytes per packet. ble-plx's `device.mtu` on iOS is not the
   * negotiated ATT MTU (it reports 23 while the link is at 247), so ask the
   * collar: its STATUS characteristic reads back [status, lastPktLen, attMtu].
   * One packet per ATT PDU keeps writes fast; a larger value would silently
   * become a multi-round-trip "long write".
   */
  private async probeAudioChunkSize(): Promise<number> {
    if (this.audioChunkSize) return this.audioChunkSize;
    let mtu = 23;
    try {
      const status = await this.device!.readCharacteristicForService(COLLAR_SERVICE_UUID, CHAR_STATUS);
      const bytes = Buffer.from(status.value ?? '', 'base64');
      if (bytes.length >= 5) mtu = bytes.readUInt16BE(3);
    } catch (e) {
      console.warn('[BLE] STATUS read failed, assuming MTU 23:', (e as Error).message);
    }
    const size = Math.max(18, Math.min(AUDIO_MAX_CHUNK, mtu - 5));
    this.audioChunkSize = size;
    console.log(`[BLE] ATT MTU ${mtu} (device.mtu said ${this.device?.mtu}) → ${size} B audio per packet`);
    return size;
  }

  private async writeCharacteristic(data: Buffer, withResponse: boolean): Promise<void> {
    if (!this.device) return;
    const b64 = data.toString('base64');
    const write = withResponse
      ? this.device.writeCharacteristicWithResponseForService(COLLAR_SERVICE_UUID, CHAR_AUDIO_TX, b64)
      : this.device.writeCharacteristicWithoutResponseForService(COLLAR_SERVICE_UUID, CHAR_AUDIO_TX, b64);
    // A write that never resolves would freeze the whole playback queue.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('BLE write timed out (3 s)')), 3000);
    });
    try {
      await Promise.race([write, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── MEMS Analysis ────────────────────────────────────────────────────────────

  /**
   * Analyse a window of MEMS samples and infer the current dog state.
   * Returns null if the window is too small to classify.
   */
  static analyzeMemsWindow(samples: MemsData[]): CollarTrigger | null {
    if (samples.length < 5) return null;

    const recent = samples.slice(-20); // last 20 samples

    const axValues = recent.map(s => s.ax);
    const variance = computeVariance(axValues);
    const mean = axValues.reduce((a, b) => a + b, 0) / axValues.length;
    const absAcc = recent.map(s => Math.sqrt(s.ax ** 2 + s.ay ** 2 + s.az ** 2));
    const avgAcc = absAcc.reduce((a, b) => a + b, 0) / absAcc.length;

    // Tail wag: rhythmic oscillation — moderate variance, lower mean offset
    const isRhythmic = detectRhythmicOscillation(axValues);
    if (isRhythmic && variance > 2000 && variance < 50000) {
      return CollarTrigger.WAG_START;
    }

    // Excited: high-amplitude, high-variance movement
    if (variance > 80000 || avgAcc > 24000) {
      return CollarTrigger.EXCITED;
    }

    // Sleeping/resting: very low variance
    if (variance < 500 && Math.abs(mean) < 1000) {
      return CollarTrigger.SLEEPING;
    }

    // Alert: sudden spike
    const maxAcc = Math.max(...absAcc);
    const minAcc = Math.min(...absAcc);
    if (maxAcc - minAcc > 15000) {
      return CollarTrigger.ALERT;
    }

    return CollarTrigger.CALM;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeVariance(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
}

/** Zero-crossing rate heuristic to detect rhythmic oscillation */
function detectRhythmicOscillation(values: number[]): boolean {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const centered = values.map(v => v - mean);
  let crossings = 0;
  for (let i = 1; i < centered.length; i++) {
    if (centered[i - 1] * centered[i] < 0) crossings++;
  }
  // Tail wag is ~2–4 Hz; at ~10 samples/sec, expect 4–8 crossings in 20 samples
  return crossings >= 3 && crossings <= 12;
}


export const bluetoothService = new BluetoothService();
export { BluetoothService, AUDIO_SAMPLE_RATE };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
