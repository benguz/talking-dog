#pragma once

// ─── Camera pins — AI-Thinker ESP32-CAM ──────────────────────────────────────
// If you're on a different module swap these out; everything else stays the same.
#define CAM_PWDN    32
#define CAM_RESET   -1
#define CAM_XCLK     0
#define CAM_SIOD    26   // camera I2C — do NOT reuse for MPU-6050
#define CAM_SIOC    27
#define CAM_Y9      35
#define CAM_Y8      34
#define CAM_Y7      39
#define CAM_Y6      36
#define CAM_Y5      21
#define CAM_Y4      19
#define CAM_Y3      18
#define CAM_Y2       5
#define CAM_VSYNC   25
#define CAM_HREF    23
#define CAM_PCLK    22

// ─── IMU — MPU-6050 (I2C bus 1, avoids camera SIOD/SIOC conflict) ─────────────
#define IMU_SDA     16
#define IMU_SCL     17
#define MPU6050_ADDR 0x68  // AD0 pulled LOW; use 0x69 if AD0 is HIGH

// ─── Microphone — INMP441 (I2S peripheral 1) ─────────────────────────────────
#define MIC_WS      42   // Word Select (L/R clock)
#define MIC_SCK      2   // Bit clock
#define MIC_SD       7   // Serial data
// Note: INMP441 L/R pin is unconnected — floats low → left channel, matches I2S_CHANNEL_FMT_ONLY_LEFT

// ─── BLE UUIDs — must match app's src/types/index.ts ─────────────────────────
#define BLE_DEVICE_NAME     "DogCollarTest"
#define SERVICE_UUID        "12345678-1234-1234-1234-1234567890AB"
#define CHAR_MEMS_UUID      "12345678-1234-5678-1234-56789abcdef1"
#define CHAR_AUDIO_TX_UUID  "12345678-1234-5678-1234-56789abcdef2"
#define CHAR_TRIGGER_UUID   "12345678-1234-5678-1234-56789abcdef3"
#define CHAR_STATUS_UUID    "12345678-1234-5678-1234-56789abcdef4"
#define CHAR_CAMERA_UUID    "12345678-1234-5678-1234-56789abcdef5"

// ─── Trigger event codes — must match app's CollarTrigger enum ───────────────
#define EVT_WAG_START   0x01
#define EVT_WAG_STOP    0x02
#define EVT_BARK        0x03
#define EVT_EXCITED     0x04
#define EVT_CALM        0x05
#define EVT_SLEEPING    0x06
#define EVT_ALERT       0x07

// ─── IMU spike detection ──────────────────────────────────────────────────────
// The IMU task samples at IMU_POLL_HZ and maintains a sliding window of
// acceleration magnitudes. A spike is flagged when the current sample
// deviates from the window mean by more than the relevant threshold.
#define IMU_POLL_HZ          100     // Hz — 100 samples/sec, 10ms/sample
#define IMU_WINDOW_MS        300     // sliding window duration (ms)
#define IMU_WINDOW_SIZE      (IMU_POLL_HZ * IMU_WINDOW_MS / 1000)  // = 30 samples
#define IMU_ACCEL_SCALE      4096.0f // counts/g at ±8g range (AFS_SEL=2)
#define IMU_SPIKE_G          3.0f    // g above mean → EVT_EXCITED (jump/run)
#define IMU_WAG_G            1.0f    // g above mean → EVT_WAG_START
#define IMU_WAG_DROP_G       0.5f    // g below mean → EVT_WAG_STOP
#define IMU_STILL_G          0.08f   // total magnitude below this → EVT_SLEEPING
#define IMU_COOLDOWN_MS      800     // min ms between IMU-triggered events

// ─── Microphone onset detection ───────────────────────────────────────────────
// Energy = mean(sample²) over a 20ms frame. INMP441 outputs 24-bit audio
// left-justified in a 32-bit word, so we right-shift by 8 before squaring.
#define MIC_SAMPLE_RATE       16000
#define MIC_FRAME_SAMPLES      320   // 20ms @ 16kHz
#define MIC_ENERGY_BARK     2000000LL  // tune to your environment; start high, lower until false-positives appear
#define MIC_COOLDOWN_MS        600

// ─── Camera ───────────────────────────────────────────────────────────────────
#define JPEG_QUALITY         12      // 0=best quality / largest, 63=worst; 12 ≈ 15-40KB
#define CAM_FRAMESIZE   FRAMESIZE_VGA  // 640×480; FRAMESIZE_QVGA (320×240) if too slow

// ─── BLE chunked JPEG transfer protocol ──────────────────────────────────────
// Safe chunk size for a typical iOS↔ESP32 negotiated MTU of ~185 bytes.
// Increase to 500 if you confirm higher MTU negotiation.
#define BLE_CHUNK_PAYLOAD    177     // bytes of JPEG data per notify packet
// Total notify payload = [0x02, seq_hi, seq_lo] + BLE_CHUNK_PAYLOAD = 180 bytes
#define BLE_CHUNK_DELAY_MS     8     // ms between chunks — tune vs. throughput
