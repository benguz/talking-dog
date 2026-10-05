/**
 * Small audio helpers for the collar's 8 kHz μ-law stream (ITU-T G.711).
 * Matches the collar firmware (ulaw.h) and the app (AudioService.encodeUlaw).
 */

export const COLLAR_SAMPLE_RATE = 8000;

const ULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  ULAW_DECODE[i] = sign ? -sample : sample;
}

export function ulawDecode(ulaw: Uint8Array): Int16Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) out[i] = ULAW_DECODE[ulaw[i]!]!;
  return out;
}

export function ulawEncodeSample(pcm: number): number {
  const BIAS = 0x84, CLIP = 32635;
  const sign = pcm < 0 ? 0x80 : 0;
  let s = Math.min(Math.abs(pcm), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function ulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = ulawEncodeSample(pcm[i]!);
  return out;
}

/**
 * Downsample 16-bit mono PCM by an integer factor with a box (moving-average)
 * low-pass, then optional gain. Good enough for speech to 8 kHz.
 */
export function downsample(pcm: Int16Array, factor: number, gain = 1): Int16Array {
  const n = Math.floor(pcm.length / factor);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < factor; k++) acc += pcm[i * factor + k]!;
    const v = Math.round((acc / factor) * gain);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** Peak-normalize to `target` (0..1 of full scale). */
export function normalize(pcm: Int16Array, target = 0.9): Int16Array {
  let peak = 1;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  const g = (target * 32767) / peak;
  if (g <= 1) return pcm;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.round(pcm[i]! * g);
  return out;
}

/** Wrap 16-bit mono PCM in a RIFF/WAV container. */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** Linear-interpolation resample (fine for speech; 24 kHz → 16 kHz is the main use). */
export function resample(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return pcm;
  const n = Math.floor((pcm.length * toRate) / fromRate);
  const out = new Int16Array(n);
  const ratio = fromRate / toRate;
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    const a = pcm[j]!;
    const b = pcm[Math.min(j + 1, pcm.length - 1)]!;
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}

// ── IMA ADPCM (DVI4) encoder: 4 bits/sample, low nibble first. Matches collar adpcm.h.
const ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const ADPCM_STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

export function adpcmEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(pcm.length / 2));
  let predictor = 0;
  let index = 0;
  for (let i = 0; i < pcm.length; i++) {
    const step = ADPCM_STEP[index]!;
    let diff = pcm[i]! - predictor;
    let nib = 0;
    if (diff < 0) {
      nib = 8;
      diff = -diff;
    }
    let vpdiff = step >> 3;
    if (diff >= step) { nib |= 4; diff -= step; vpdiff += step; }
    if (diff >= step >> 1) { nib |= 2; diff -= step >> 1; vpdiff += step >> 1; }
    if (diff >= step >> 2) { nib |= 1; vpdiff += step >> 2; }
    predictor += nib & 8 ? -vpdiff : vpdiff;
    if (predictor > 32767) predictor = 32767;
    else if (predictor < -32768) predictor = -32768;
    index += ADPCM_INDEX[nib]!;
    if (index < 0) index = 0;
    else if (index > 88) index = 88;
    if (i & 1) out[i >> 1] = (out[i >> 1] ?? 0) | (nib << 4);
    else out[i >> 1] = nib;
  }
  return out;
}
