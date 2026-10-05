#pragma once
/* Talking Dog collar — shared configuration */

#ifndef COLLAR_MIC
#define COLLAR_MIC 0            /* 1 = stream onboard PDM mic (XIAO nRF54L15 Sense) */
#endif

/* ── BLE UUIDs — must match app/src/types/index.ts ─────────────────────────── */
#define COLLAR_SVC_UUID_VAL     BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x1234, 0x1234, 0x1234567890AB)
#define COLLAR_MEMS_UUID_VAL    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef1)
#define COLLAR_AUDIO_UUID_VAL   BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef2)
#define COLLAR_TRIGGER_UUID_VAL BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef3)
#define COLLAR_STATUS_UUID_VAL  BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef4)
/* new: collar → phone microphone stream (μ-law 8 kHz, [seqHi, seqLo, ...bytes]) */
#define COLLAR_MIC_UUID_VAL     BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef6)

/* ── Trigger codes — must match app CollarTrigger enum ─────────────────────── */
#define EVT_WAG_START 0x01
#define EVT_WAG_STOP  0x02
#define EVT_BARK      0x03
#define EVT_EXCITED   0x04
#define EVT_CALM      0x05
#define EVT_SLEEPING  0x06
#define EVT_ALERT     0x07

/* ── IMU (MPU-6050 on xiao_i2c, D4/D5) ─────────────────────────────────────── */
#define MPU6050_ADDR        0x68     /* AD0 tied to GND */
#define IMU_POLL_HZ         100
#define MEMS_NOTIFY_HZ      50
#define IMU_WINDOW_MS       300
#define IMU_WINDOW_SIZE     (IMU_POLL_HZ * IMU_WINDOW_MS / 1000)
#define IMU_ACCEL_SCALE     4096.0f  /* counts/g at ±8 g */
#define IMU_SPIKE_G         3.0f
#define IMU_WAG_G           1.0f
#define IMU_WAG_DROP_G      0.5f
#define IMU_STILL_G         0.08f
#define IMU_COOLDOWN_MS     800

/* ── Speaker (MAX98357A on I2S20, D0/D1/D2) ────────────────────────────────── */
#define SPK_SAMPLE_RATE     16000    /* I2S runs at 16 kHz; 8 kHz input is 2× upsampled */
#define SPK_BLOCK_FRAMES    160      /* 10 ms per block */
#define SPK_BLOCK_BYTES     (SPK_BLOCK_FRAMES * 2 /*ch*/ * 2 /*bytes*/)
#define SPK_BLOCK_COUNT     8
#define SPK_GAIN_SHIFT      0        /* legacy attenuation: 0 = none, 1 = -6 dB */
#define SPK_GAIN_X10        15       /* digital gain ×0.1 before the limiter: 15 = ×1.5 (+3.5 dB) */
#define SPK_LIMIT_KNEE      24000    /* soft-clip above this (of 32767) so peaks round off instead of crunching */
#define AUDIO_RX_RING_BYTES 65536    /* ~8 s at 8 kB/s (8 kHz μ-law or 16 kHz ADPCM) */
#define AUDIO_PREBUFFER     1600     /* start playback once 200 ms has arrived */
#define AUDIO_KEEPALIVE_MS  1500     /* keep I2S running (silence) this long between clips */

/* ── Microphone (PDM20 onboard, Sense only) ────────────────────────────────── */
#define MIC_PCM_RATE        16000
#define MIC_BLOCK_SAMPLES   320      /* 20 ms @ 16 kHz → 160 μ-law bytes @ 8 kHz */
#define MIC_BLOCK_BYTES     (MIC_BLOCK_SAMPLES * 2)
#define MIC_BLOCK_COUNT     6
