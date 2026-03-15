/**
 * BluetoothService — manages BLE connection to the Talking Dog Collar.
 *
 * Collar BLE layout:
 *   Service:  COLLAR_SERVICE_UUID
 *   CHAR_MEMS_DATA (notify)  — 12-byte MPU-6050 packets [ax,ay,az,gx,gy,gz] int16 LE
 *   CHAR_AUDIO_TX  (write)   — audio chunks phone→collar speaker
 *   CHAR_TRIGGER   (notify)  — uint8 trigger events from collar
 *   CHAR_STATUS    (notify)  — uint8 status/battery byte
 *
 * Audio TX packet protocol:
 *   First packet:  [0xFF, 0xFF, totalChunksHi, totalChunksLo, srHi, srLo, enc]
 *   Data packets:  [seqHi, seqLo, ...18 bytes audio]
 *   End packet:    [0xFF, 0xFE]
 */

import { BleManager, Device, BleError, Characteristic } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import {
  CHAR_AUDIO_TX,
  CHAR_MEMS_DATA,
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

const AUDIO_CHUNK_SIZE = 18; // bytes of audio per BLE packet (20 byte MTU – 2 header bytes)
const AUDIO_SAMPLE_RATE = 8000; // Hz — narrow-band; keeps BLE bandwidth manageable

class BluetoothService {
  private manager: BleManager;
  private device: Device | null = null;
  private triggerSub: { remove: () => void } | null = null;
  private memsSub: { remove: () => void } | null = null;

  onTrigger: TriggerCallback | null = null;
  onMems: MemsCallback | null = null;
  onDisconnect: DisconnectCallback | null = null;

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
    return new Promise((resolve, reject) => {
      this.manager.startDeviceScan(
        [COLLAR_SERVICE_UUID],
        { allowDuplicates: false },
        async (error: BleError | null, device: Device | null) => {
          if (error) {
            this.manager.stopDeviceScan();
            reject(error);
            return;
          }
          if (!device) return;

          const name = device.name ?? device.localName ?? '';
          if (!name.startsWith(COLLAR_NAME_PREFIX)) return;

          this.manager.stopDeviceScan();
          onDeviceFound?.(name);

          try {
            const connected = await this.connectToDevice(device);
            resolve(connected);
          } catch (e) {
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
    const connected = await device.connect({ autoConnect: false, requestMTU: 512 });
    await connected.discoverAllServicesAndCharacteristics();
    this.device = connected;

    // Monitor disconnect
    connected.onDisconnected(() => {
      this.device = null;
      this.triggerSub?.remove();
      this.memsSub?.remove();
      this.onDisconnect?.();
    });

    this.subscribeTriggers();
    this.subscribeMems();

    return connected;
  }

  disconnect() {
    this.triggerSub?.remove();
    this.memsSub?.remove();
    this.device?.cancelConnection().catch(() => {});
    this.device = null;
  }

  get isConnected() {
    return this.device != null;
  }

  get deviceName() {
    return this.device?.name ?? this.device?.localName ?? null;
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  private subscribeTriggers() {
    if (!this.device) return;
    this.triggerSub = this.device.monitorCharacteristicForService(
      COLLAR_SERVICE_UUID,
      CHAR_TRIGGER,
      (error: BleError | null, char: Characteristic | null) => {
        if (error || !char?.value) return;
        const bytes = Buffer.from(char.value, 'base64');
        if (bytes.length < 1) return;
        const trigger = bytes[0] as CollarTrigger;
        if (Object.values(CollarTrigger).includes(trigger)) {
          this.onTrigger?.(trigger);
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
        if (error || !char?.value) return;
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

  // ── Audio TX ─────────────────────────────────────────────────────────────────

  /**
   * Stream μ-law encoded PCM audio to the collar's speaker.
   * `audioData` should be 8 kHz, mono, μ-law encoded Uint8Array.
   */
  async streamAudio(audioData: Uint8Array): Promise<void> {
    if (!this.device) throw new Error('Not connected to collar');

    const totalChunks = Math.ceil(audioData.length / AUDIO_CHUNK_SIZE);

    // Send header packet
    const header = Buffer.alloc(7);
    header[0] = 0xff;
    header[1] = 0xff;
    header.writeUInt16BE(totalChunks, 2);
    header.writeUInt16BE(AUDIO_SAMPLE_RATE, 4);
    header[6] = 0x01; // encoding: mulaw
    await this.writeCharacteristic(header);

    // Send audio chunks
    for (let seq = 0; seq < totalChunks; seq++) {
      const chunkStart = seq * AUDIO_CHUNK_SIZE;
      const chunkEnd = Math.min(chunkStart + AUDIO_CHUNK_SIZE, audioData.length);
      const audioChunk = audioData.slice(chunkStart, chunkEnd);

      const packet = Buffer.alloc(2 + audioChunk.length);
      packet.writeUInt16BE(seq, 0);
      Buffer.from(audioChunk).copy(packet, 2);
      await this.writeCharacteristic(packet);

      // Pace packets to avoid overwhelming collar's receive buffer
      // 18 bytes at 8kHz ≈ 2.25ms of audio; add a tiny yield per chunk
      await yieldToLoop();
    }

    // Send end-of-stream marker
    const eof = Buffer.from([0xff, 0xfe]);
    await this.writeCharacteristic(eof);
  }

  private async writeCharacteristic(data: Buffer): Promise<void> {
    if (!this.device) return;
    await this.device.writeCharacteristicWithResponseForService(
      COLLAR_SERVICE_UUID,
      CHAR_AUDIO_TX,
      data.toString('base64'),
    );
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

function yieldToLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export const bluetoothService = new BluetoothService();
export { BluetoothService, AUDIO_SAMPLE_RATE };
