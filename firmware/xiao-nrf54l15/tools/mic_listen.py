#!/usr/bin/env python3
"""
Listen to the collar's microphone stream over BLE.

  pip3 install bleak            # required
  pip3 install sounddevice numpy   # optional: live playback through your speakers

  python3 tools/mic_listen.py                 # level meter + record to mic_YYYYmmdd_HHMMSS.wav
  python3 tools/mic_listen.py --play          # also play live
  python3 tools/mic_listen.py --seconds 10    # stop after 10 s

Packets on CHAR_MIC: [seqHi, seqLo, ...160 bytes u-law @ 8 kHz]  (20 ms each)
"""
import argparse, asyncio, struct, sys, time, wave
from datetime import datetime

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab"
CHAR_MIC     = "12345678-1234-5678-1234-56789abcdef6"
NAME_PREFIX  = "DogCollarTest"
SAMPLE_RATE  = 8000

# ITU-T G.711 u-law -> int16 (same as firmware ulaw.h)
def _ulaw_table():
    t = []
    for u in range(256):
        u = ~u & 0xFF
        sign, exp, man = u & 0x80, (u >> 4) & 7, u & 0x0F
        s = (((man << 3) + 0x84) << exp) - 0x84
        t.append(-s if sign else s)
    return t
ULAW = _ulaw_table()

def meter(rms, peak, width=40):
    import math
    db = 20 * math.log10(max(rms, 1) / 32768)
    fill = int(max(0, min(1, (db + 60) / 60)) * width)
    return f"[{'#' * fill}{'.' * (width - fill)}] {db:6.1f} dBFS  peak {peak:6d}"

async def main(a):
    print(f"scanning for {NAME_PREFIX}...")
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: (d.name or "").startswith(NAME_PREFIX) or SERVICE_UUID in (ad.service_uuids or []),
        timeout=15)
    if not dev:
        sys.exit("collar not found (is LightBlue still connected? disconnect it first)")
    print(f"found {dev.name} {dev.address}")

    fname = a.out or datetime.now().strftime("mic_%Y%m%d_%H%M%S.wav")
    wav = wave.open(fname, "wb"); wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(SAMPLE_RATE)

    player = None
    if a.play:
        try:
            import numpy as np, sounddevice as sd
            player = sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16", blocksize=160)
            player.start()
        except Exception as e:
            print(f"playback unavailable ({e}); recording only")

    stats = {"pkts": 0, "bytes": 0, "lost": 0, "last_seq": None, "t0": time.time()}
    win = []

    def on_notify(_, data: bytearray):
        seq = struct.unpack(">H", data[:2])[0]
        if stats["last_seq"] is not None:
            gap = (seq - stats["last_seq"] - 1) & 0xFFFF
            if gap: stats["lost"] += gap
        stats["last_seq"] = seq
        stats["pkts"] += 1; stats["bytes"] += len(data)

        pcm = [ULAW[b] for b in data[2:]]
        raw = struct.pack(f"<{len(pcm)}h", *pcm)
        wav.writeframes(raw)
        if player:
            import numpy as np
            player.write(np.frombuffer(raw, dtype=np.int16))

        win.extend(pcm)
        if len(win) >= 800:  # update meter every 100 ms
            rms = (sum(x * x for x in win) / len(win)) ** 0.5
            peak = max(abs(x) for x in win)
            el = time.time() - stats["t0"]
            sys.stdout.write(f"\r{meter(rms, peak)}  {stats['pkts']:5d} pkts  "
                             f"{stats['bytes']/el/1000:5.1f} kB/s  lost {stats['lost']}   ")
            sys.stdout.flush()
            win.clear()

    async with BleakClient(dev) as client:
        mtu = getattr(client, "mtu_size", None)
        print(f"connected, MTU {mtu}; recording to {fname}  (Ctrl-C to stop)")
        await client.start_notify(CHAR_MIC, on_notify)
        try:
            if a.seconds: await asyncio.sleep(a.seconds)
            else:
                while True: await asyncio.sleep(1)
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            try: await client.stop_notify(CHAR_MIC)
            except Exception: pass
    wav.close()
    if player: player.stop(); player.close()
    el = time.time() - stats["t0"]
    print(f"\nsaved {fname}: {stats['pkts']} packets, {stats['pkts']*0.02:.1f} s of audio, "
          f"{stats['lost']} lost, {stats['bytes']/el/1000:.1f} kB/s")

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--play", action="store_true", help="play live through default output")
    p.add_argument("--seconds", type=float, default=0, help="stop after N seconds")
    p.add_argument("--out", help="wav filename")
    try:
        asyncio.run(main(p.parse_args()))
    except KeyboardInterrupt:
        pass
