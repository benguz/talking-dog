/**
 * test_mic.ino — INMP441 I2S microphone standalone test
 *
 * Wiring:
 *   WS  (word select / LR clock) → GPIO 42  ← ESP32-S3 only; use GPIO 15 on classic ESP32
 *   SCK (bit clock)              → GPIO  2
 *   SD  (serial data)            → GPIO  7  ← NOT GPIO 1 (that's UART0 TX)
 *   L/R → unconnected/GND = left channel; tie to 3.3V + set MIC_LR_RIGHT=true for right channel
 *   VDD → 3.3 V
 *   GND → GND
 *
 * Expected Serial output at 115200 baud:
 *   One line per 20 ms frame: RMS amplitude + a simple ASCII level bar
 *   "BARK?" printed when the energy crosses the threshold
 *
 * Flash target: any ESP32 board (uses I2S peripheral 1).
 */

#include <driver/i2s.h>

// ─── Pin config ───────────────────────────────────────────────────────────────
#define MIC_WS   2   // Word Select (LR clock)
#define MIC_SCK   41   // Bit clock
#define MIC_SD    7   // Serial data in

// ─── Audio config ─────────────────────────────────────────────────────────────
#define SAMPLE_RATE     16000
#define FRAME_SAMPLES     320   // 20 ms @ 16 kHz
#define BARK_ENERGY   500000000000LL // with MIC_RSHIFT=0, scale is 256x larger — tune downward if needed

// ─── Debug switches ────────────────────────────────────────────────────────────
// If you get all-zero samples, try flipping MIC_LR_RIGHT to true:
//   1) Physically tie the INMP441 L/R pin to 3.3 V
//   2) Set MIC_LR_RIGHT true below and re-flash
// The INMP441 outputs LEFT channel when L/R is low/float, RIGHT when L/R is high.
#define MIC_LR_RIGHT    false   // false = left channel (L/R low/float), true = right channel (L/R → 3.3V)

// Print raw hex every N frames (1 = every frame) to see if any non-zero data arrives
#define RAW_PRINT_EVERY 10


// ── Bit-shift tuning ───────────────────────────────────────────────────────────
// The INMP441 outputs 24-bit audio in a 32-bit I2S word.
// Depending on the ESP32 I2S driver version the data lands in different bit positions:
//
//   Left-justified  (canonical I2S): audio in bits [31:8]  → shift right by 8
//   Right-justified (some drivers):  audio in bits [23:0]  → shift right by 0
//
// If touch/tap works but quiet speech reads zero, lower this value.
// Start at 0; if everything clips/saturates, increase toward 8.
#define MIC_RSHIFT  0

// ─── I2S init ─────────────────────────────────────────────────────────────────
static bool initMic() {
  Serial.printf("[test_mic] I2S pins — WS=%d  SCK=%d  SD=%d\n",
                MIC_WS, MIC_SCK, MIC_SD);

  const i2s_config_t cfg = {
    .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate          = SAMPLE_RATE,
    .bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format       = MIC_LR_RIGHT ? I2S_CHANNEL_FMT_ONLY_RIGHT : I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count        = 4,
    .dma_buf_len          = FRAME_SAMPLES,
    .use_apll             = false,
    .tx_desc_auto_clear   = false,
    .fixed_mclk           = 0,
  };
  const i2s_pin_config_t pins = {
    .bck_io_num   = MIC_SCK,
    .ws_io_num    = MIC_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num  = MIC_SD,
  };

  if (i2s_driver_install(I2S_NUM_1, &cfg, 0, nullptr) != ESP_OK) {
    Serial.println("[test_mic] FAIL — i2s_driver_install error");
    return false;
  }
  if (i2s_set_pin(I2S_NUM_1, &pins) != ESP_OK) {
    Serial.println("[test_mic] FAIL — i2s_set_pin error");
    i2s_driver_uninstall(I2S_NUM_1);
    return false;
  }
  i2s_start(I2S_NUM_1);
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("[test_mic] starting");

  if (!initMic()) {
    Serial.println("[test_mic] Halting. Reset to retry.");
    for (;;) delay(1000);
  }
  Serial.printf("[test_mic] INMP441 ready — channel: %s  rshift=%d\n",
                MIC_LR_RIGHT ? "RIGHT (L/R→3.3V)" : "LEFT  (L/R float/GND)", MIC_RSHIFT);
  Serial.println("[test_mic] rms            peak         energy              level");
}

static int32_t samples[FRAME_SAMPLES];
static uint32_t frameCount = 0;

void loop() {
  size_t bytesRead = 0;
  esp_err_t err = i2s_read(I2S_NUM_1, samples, sizeof(samples), &bytesRead, portMAX_DELAY);

  if (err != ESP_OK) {
    Serial.printf("[test_mic] i2s_read error: %d\n", err);
    return;
  }
  if (bytesRead == 0) {
    Serial.println("[test_mic] i2s_read returned 0 bytes — check wiring");
    delay(100);
    return;
  }

  int     count    = (int)(bytesRead / sizeof(int32_t));
  int64_t energy   = 0;
  int32_t peak     = 0;
  int     nonZero  = 0;

  for (int i = 0; i < count; i++) {
    if (samples[i] != 0) nonZero++;
    int32_t s = samples[i] >> MIC_RSHIFT;
    if (s < 0) s = -s;
    if (s > peak) peak = s;
    energy += (int64_t)s * s;
  }
  energy /= count;
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] RAW[0..3]: 0xFFFFFFFF 0xFFFFFFFF 0xFFFFFFFF 0xFFFFFFFF  non-zero=320/320
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
  [test_mic] rms=         1  peak=        1  energy=                 1  [------------------------------]
    
  // ── Raw diagnostic ────────────────────────────────────────────────────────
  frameCount++;
  if (frameCount % RAW_PRINT_EVERY == 1) {
    Serial.printf("[test_mic] RAW hex [0..3]: 0x%08X 0x%08X 0x%08X 0x%08X  non-zero=%d/%d\n",
                  (uint32_t)samples[0], (uint32_t)samples[1],
                  (uint32_t)samples[2], (uint32_t)samples[3],
                  nonZero, count);

    // Print first 16 samples as signed decimal (after rshift) so the
    // waveform shape is visible — makes it easy to spot stuck-at-zero,
    // rail clipping, or correct bipolar audio swing.
    const int DUMP_N = 16;
    Serial.print("[test_mic] RAW dec [0..15]: ");
    for (int i = 0; i < DUMP_N && i < count; i++) {
      int32_t s = samples[i] >> MIC_RSHIFT;
      Serial.print(s);
      if (i < DUMP_N - 1 && i < count - 1) Serial.print(", ");
    }
    Serial.println();

    if (nonZero == 0) {
      Serial.println("[test_mic] *** ALL ZEROS — try one of:");
      Serial.println("[test_mic]   A) Tie INMP441 L/R pin to 3.3V, set MIC_LR_RIGHT true, reflash.");
      Serial.println("[test_mic]   B) Confirm WS/SCK are toggling with a scope or 2nd multimeter in AC mode.");
      Serial.println("[test_mic]   C) On classic ESP32 (not S3), GPIO 42 is invalid — use GPIO 15 for WS.");
    } else if (nonZero < count / 2) {
      Serial.println("[test_mic] *** MOSTLY ZEROS — possible channel mismatch or clocking issue.");
    }
  }

  float rms = sqrtf((float)energy);

  // ── ASCII level bar (log scale) ───────────────────────────────────────────
  const int BAR_WIDTH = 30;
  float logRms = (rms > 1.0f) ? log10f(rms) : 0.0f;
  float logMax = 7.0f;  // log10(10M) ≈ max for 24-bit audio
  int bars = (int)(logRms / logMax * BAR_WIDTH);
  if (bars > BAR_WIDTH) bars = BAR_WIDTH;

  char bar[BAR_WIDTH + 1];
  for (int i = 0; i < BAR_WIDTH; i++) bar[i] = (i < bars) ? '#' : '-';
  bar[BAR_WIDTH] = '\0';

  const char* tag = (energy > BARK_ENERGY) ? "  *** BARK? ***" : "";
  Serial.printf("[test_mic] rms=%10.0f  peak=%9d  energy=%18lld  [%s]%s\n",
                rms, peak, energy, bar, tag);
}


