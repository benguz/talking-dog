#!/usr/bin/env python3
"""
Send a WAV file to the collar speaker over BLE (same packet protocol as the app).

  pip3 install bleak
  python3 tools/speaker_send.py mic_20260927_155031.wav            # play it on the collar
  python3 tools/speaker_send.py file.wav --gain 4                   # louder
  python3 tools/speaker_send.py --tone 440 --seconds 2              # test tone instead of a file

Any WAV rate / channel count is accepted; it is mixed to mono and resampled to 8 kHz u-law.
Packets:  header [FF FF chunksHi chunksLo srHi srLo 01]
          data   [seqHi seqLo ...u-law]   (up to MTU-3 bytes, write-without-response)
          end    [FF FE]
Sending is paced to real time (8 kB/s) after a 1.5 s head start so the collar's 4 s buffer never overflows.
"""
import argparse, asyncio, math, struct, sys, time, wave

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab"
CHAR_AUDIO   = "12345678-1234-5678-1234-56789abcdef2"
NAME_PREFIX  = "DogCollarTest"
RATE = 8000

def ulaw_encode(pcm):
    BIAS, CLIP = 0x84, 32635
    sign = 0x80 if pcm < 0 else 0
    pcm = min(abs(pcm), CLIP) + BIAS
    exp = 7
    mask = 0x4000
    while (pcm & mask) == 0 and exp > 0:
        exp -= 1; mask >>= 1
    man = (pcm >> (exp + 3)) & 0x0F
    return (~(sign | (exp << 4) | man)) & 0xFF

# IMA ADPCM encoder (matches collar adpcm.h): 4 bits/sample, low nibble first
_IDX = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8]
_STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767]
def adpcm_encode(pcm):
    out = bytearray((len(pcm) + 1) // 2); pred = 0; idx = 0
    for i, sample in enumerate(pcm):
        step = _STEP[idx]; diff = sample - pred; nib = 0
        if diff < 0: nib = 8; diff = -diff
        vp = step >> 3
        if diff >= step: nib |= 4; diff -= step; vp += step
        if diff >= step >> 1: nib |= 2; diff -= step >> 1; vp += step >> 1
        if diff >= step >> 2: nib |= 1; vp += step >> 2
        pred = max(-32768, min(32767, pred - vp if nib & 8 else pred + vp))
        idx = max(0, min(88, idx + _IDX[nib]))
        if i & 1: out[i >> 1] |= nib << 4
        else: out[i >> 1] = nib
    return bytes(out)

def load_wav(path, gain, rate=RATE):
    w = wave.open(path, "rb")
    ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    raw = w.readframes(n); w.close()
    if sw == 2:
        s = struct.unpack(f"<{n*ch}h", raw)
    elif sw == 1:
        s = [(b - 128) << 8 for b in raw]
    else:
        sys.exit(f"unsupported sample width {sw}")
    if ch > 1:
        s = [sum(s[i:i+ch]) // ch for i in range(0, len(s), ch)]
    if sr != rate:  # linear resample
        out, ratio = [], sr / rate
        for i in range(int(len(s) / ratio)):
            x = i * ratio; j = int(x); f = x - j
            a = s[j]; b = s[min(j + 1, len(s) - 1)]
            out.append(int(a + (b - a) * f))
        s = out
    s = [max(-32767, min(32767, int(v * gain))) for v in s]
    return adpcm_encode(s) if rate == 16000 else bytes(ulaw_encode(v) for v in s)

def make_tone(freq, seconds, gain):
    n = int(RATE * seconds)
    return bytes(ulaw_encode(int(8000 * gain * math.sin(2 * math.pi * freq * i / RATE))) for i in range(n))

async def main(a):
    adpcm = a.format == "adpcm16k"
    sr, enc = (16000, 3) if adpcm else (8000, 1)
    if a.tone:
        ulaw = make_tone(a.tone, a.seconds, a.gain); adpcm = False; sr, enc = 8000, 1
        print(f"tone {a.tone} Hz, {a.seconds} s")
    else:
        ulaw = load_wav(a.file, a.gain, sr)
        print(f"{a.file}: {len(ulaw)/8000:.1f} s as {'16 kHz ADPCM' if adpcm else '8 kHz u-law'}, gain x{a.gain}")

    print(f"scanning for {NAME_PREFIX}...")
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: (d.name or "").startswith(NAME_PREFIX) or SERVICE_UUID in (ad.service_uuids or []),
        timeout=15)
    if not dev:
        sys.exit("collar not found (disconnect LightBlue / the app first)")

    async with BleakClient(dev) as client:
        mtu = getattr(client, "mtu_size", 23) or 23
        chunk = max(18, min(244, mtu - 3) - 2)      # audio bytes per packet
        chunks = [ulaw[i:i + chunk] for i in range(0, len(ulaw), chunk)]
        print(f"connected, MTU {mtu}: {len(chunks)} packets of {chunk} B")

        await client.write_gatt_char(CHAR_AUDIO, struct.pack(">BBHHB", 0xFF, 0xFF, min(len(chunks), 0xFFFF), sr, enc), response=True)

        t0 = time.time(); sent = 0
        for seq, c in enumerate(chunks):
            await client.write_gatt_char(CHAR_AUDIO, struct.pack(">H", seq & 0xFFFF) + c, response=False)
            sent += len(c)
            # pace: stay at most `lead` seconds of audio ahead of real time
            ahead = sent / 8000 - (time.time() - t0)   # both formats are 8 kB/s
            if ahead > a.lead:
                await asyncio.sleep(ahead - a.lead)
            if seq % 50 == 0:
                sys.stdout.write(f"\r{sent/8000:5.1f} / {len(ulaw)/8000:.1f} s  ({sent/(time.time()-t0)/1000:.1f} kB/s)   "); sys.stdout.flush()
        await client.write_gatt_char(CHAR_AUDIO, bytes([0xFF, 0xFE]), response=True)
        print(f"\nsent {len(ulaw)} bytes in {time.time()-t0:.1f} s; collar drains its buffer for ~{a.lead:.1f} s more")
        await asyncio.sleep(a.lead + 0.5)

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("file", nargs="?", help="WAV file to play")
    p.add_argument("--gain", type=float, default=10.0, help="linear gain applied before u-law, clipped at full scale (default 10)")
    p.add_argument("--tone", type=float, help="send a sine tone of this frequency instead of a file")
    p.add_argument("--seconds", type=float, default=2.0, help="tone length")
    p.add_argument("--lead", type=float, default=1.5, help="seconds of audio to keep buffered ahead on the collar")
    p.add_argument("--format", choices=["adpcm16k", "ulaw8k"], default="adpcm16k", help="collar encoding (default: 16 kHz ADPCM)")
    args = p.parse_args()
    if not args.file and not args.tone:
        p.error("give a WAV file or --tone")
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        pass
