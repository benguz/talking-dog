#!/usr/bin/env python3
"""Print the collar's IMU stream (MEMS + trigger events) over BLE.  pip3 install bleak"""
import asyncio, struct, sys, time
from bleak import BleakClient, BleakScanner

SERVICE = "12345678-1234-1234-1234-1234567890ab"
CHAR_MEMS = "12345678-1234-5678-1234-56789abcdef1"
CHAR_TRIGGER = "12345678-1234-5678-1234-56789abcdef3"
NAMES = {1: "WAG_START", 2: "WAG_STOP", 3: "BARK", 4: "EXCITED", 5: "CALM", 6: "SLEEPING", 7: "ALERT"}

async def main():
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: (d.name or "").startswith("DogCollarTest") or SERVICE in (ad.service_uuids or []), timeout=15)
    if not dev:
        sys.exit("collar not found (disconnect the phone/LightBlue first)")
    n = 0; t0 = time.time()
    def on_mems(_, data):
        nonlocal n
        n += 1
        ax, ay, az, gx, gy, gz = struct.unpack("<6h", data[:12])
        g = ((ax**2 + ay**2 + az**2) ** 0.5) / 4096
        sys.stdout.write(f"\r{n/(time.time()-t0):4.0f} Hz  ax={ax:6d} ay={ay:6d} az={az:6d}  |a|={g:.2f} g   gx={gx:6d} gy={gy:6d} gz={gz:6d}   ")
        sys.stdout.flush()
    def on_trig(_, data):
        print(f"\n*** TRIGGER 0x{data[0]:02x} {NAMES.get(data[0], '?')}")
    async with BleakClient(dev) as c:
        print("connected; Ctrl-C to stop")
        await c.start_notify(CHAR_MEMS, on_mems)
        await c.start_notify(CHAR_TRIGGER, on_trig)
        while True: await asyncio.sleep(1)

try: asyncio.run(main())
except KeyboardInterrupt: print()
