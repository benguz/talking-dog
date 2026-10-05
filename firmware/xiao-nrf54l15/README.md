# Collar firmware — XIAO nRF54L15 (Zephyr / PlatformIO)

## Wiring (regular XIAO nRF54L15)

| XIAO pin | nRF54L15 | Goes to |
|---|---|---|
| D0 | P1.04 | MAX98357A **BCLK** |
| D1 | P1.05 | MAX98357A **LRC** |
| D2 | P1.06 | MAX98357A **DIN** |
| D4 | P1.10 | MPU-6050 SDA |
| D5 | P1.11 | MPU-6050 SCL |
| 3V3 | | MPU-6050 VCC |
| GND | | MPU-6050 GND, MPU-6050 AD0, MAX98357A GND |
| BAT+ | | MAX98357A VIN |

I2S20 is a PERI-domain peripheral and can only use P1 pins, so D8–D10 (P2) cannot carry I2S.
MAX98357A GAIN and SD: leave open.

## Build / flash

```
pio run -e collar -t upload      # regular board (mic off)
pio run -e collar-sense -t upload # Sense board: onboard PDM mic streaming on
pio device monitor
```

## BLE

Advertises as `DogCollarTest`. Service `12345678-1234-1234-1234-1234567890AB`:

| Char | UUID suffix | Dir | Payload |
|---|---|---|---|
| MEMS | ...def1 | notify 50 Hz | 6 × int16 LE: ax ay az gx gy gz |
| AUDIO_TX | ...def2 | write / write-no-resp | header `FF FF chunksHi chunksLo srHi srLo enc`, data `seqHi seqLo …`, end `FF FE` |
| TRIGGER | ...def3 | notify | uint8 event (0x01 wag start … 0x07 alert) |
| STATUS | ...def4 | read/notify | 0x01 = ready |
| MIC | ...def6 | notify | `seqHi seqLo` + 160 B μ-law @ 8 kHz (20 ms) |

### LightBlue test
1. Connect to `DogCollarTest`. LED goes solid.
2. Subscribe to `...def1` → 12-byte MEMS packets at 50 Hz.
3. Write hex `FFFF 0001 1F40 01` to `...def2`, then write ~1 kB of `FF` bytes in packets prefixed with `0000`, `0001`, …, then `FFFE`. The speaker plays it (μ-law `0xFF` = silence, so use varied bytes, e.g. repeat `00 FF` for a buzz).
4. Shake the board → `...def3` notifies 0x04 (EXCITED).

### Throughput note
The app currently writes 18-byte audio packets *with response*. That is ~1 kB/s at a 15 ms
interval, far below the 8 kB/s that 8 kHz μ-law needs; the collar buffers up to 4 s and plays
once 200 ms has arrived, so short clips work but with a delay. For real-time speech the app
should request MTU 247 and use write-without-response with 244-byte packets.
