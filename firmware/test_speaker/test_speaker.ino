/**
 * test_speaker.ino — I2S amplifier / DAC standalone test
 *
 * Compatible with MAX98357A, PCM5102A, and similar I2S DAC/amplifier boards.
 *
 * Wiring:
 *   DIN  (data in)   → GPIO 48
 *   BCLK (bit clock) → GPIO 47
 *   LRC  (word sel)  → GPIO 21
 *   VIN  / VDD       → 3.3 V or 5 V (check your module's datasheet)
 *   GND              → GND
 *   SD (shutdown)    → 3.3 V to enable (MAX98357A) — leave NC if not present
 *
 * What you should hear:
 *   1. A 440 Hz sine tone (A4) for 1 second
 *   2. A 880 Hz sine tone (A5) for 1 second
 *   3. A descending sweep 1000 → 200 Hz over 2 seconds
 *   4. Silence for 1 second
 *   Then repeats.
 *
 * Serial output at 115200 baud shows which tone is playing and peak sample value.
 *
 * Flash target: any ESP32-S3 or ESP32 board with GPIO 47/48 available.
 *   (GPIO 47/48 are only on ESP32-S3; if using plain ESP32 re-map the pins below.)
 */

#include <driver/i2s.h>
#include <driver/gpio.h>
#include <math.h>

// ─── Pin config ───────────────────────────────────────────────────────────────
#define SPEAKER_DIN   48   // I2S data out to amplifier
#define SPEAKER_BCLK  47   // I2S bit clock
#define SPEAKER_LRC   21   // I2S left/right (word select)

// ─── Audio config ─────────────────────────────────────────────────────────────
#define SAMPLE_RATE    44100
#define BITS           I2S_BITS_PER_SAMPLE_16BIT
#define AMPLITUDE      32000   // 0..32767; cranked up for debug
#define BUF_SAMPLES     256    // samples per DMA write

// Use I2S peripheral 0 (peripheral 1 is reserved for the INMP441 mic in the main firmware)
#define I2S_PORT       I2S_NUM_0

// ─── GPIO wiggle test ─────────────────────────────────────────────────────────
// Drives each I2S pin HIGH then LOW so you can probe with a multimeter or scope.
// If a pin stays at 0 V the entire time, it may be damaged or mis-mapped.
static void wigglePins() {
  Serial.println("[test_speaker] GPIO wiggle: each pin goes HIGH for 2 s then LOW");
  const int pins[] = { SPEAKER_DIN, SPEAKER_BCLK, SPEAKER_LRC };
  const char* names[] = { "DIN", "BCLK", "LRC" };
  for (int p = 0; p < 3; p++) {
    gpio_reset_pin((gpio_num_t)pins[p]);
    gpio_set_direction((gpio_num_t)pins[p], GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)pins[p], 1);
    Serial.printf("[test_speaker]   GPIO %d (%s) = HIGH\n", pins[p], names[p]);
    delay(2000);
    gpio_set_level((gpio_num_t)pins[p], 0);
    Serial.printf("[test_speaker]   GPIO %d (%s) = LOW\n", pins[p], names[p]);
    delay(500);
  }
  Serial.println("[test_speaker] GPIO wiggle done — handing pins to I2S driver");
}

// ─── I2S init ─────────────────────────────────────────────────────────────────
static bool initSpeaker() {
  Serial.printf("[test_speaker] I2S pins — DIN=%d  BCLK=%d  LRC=%d\n",
                SPEAKER_DIN, SPEAKER_BCLK, SPEAKER_LRC);

  const i2s_config_t cfg = {
    .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate          = SAMPLE_RATE,
    .bits_per_sample      = BITS,
    .channel_format       = I2S_CHANNEL_FMT_RIGHT_LEFT,   // stereo (L+R identical)
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count        = 8,
    .dma_buf_len          = BUF_SAMPLES,
    .use_apll             = false,
    .tx_desc_auto_clear   = true,   // silence on underrun
    .fixed_mclk           = 0,
  };
  const i2s_pin_config_t pins = {
    .bck_io_num   = SPEAKER_BCLK,
    .ws_io_num    = SPEAKER_LRC,
    .data_out_num = SPEAKER_DIN,
    .data_in_num  = I2S_PIN_NO_CHANGE,
  };

  if (i2s_driver_install(I2S_PORT, &cfg, 0, nullptr) != ESP_OK) {
    Serial.println("[test_speaker] FAIL — i2s_driver_install error");
    return false;
  }
  if (i2s_set_pin(I2S_PORT, &pins) != ESP_OK) {
    Serial.println("[test_speaker] FAIL — i2s_set_pin error");
    i2s_driver_uninstall(I2S_PORT);
    return false;
  }
  i2s_start(I2S_PORT);
  return true;
}

// ─── Tone generator ───────────────────────────────────────────────────────────
// Writes `durationMs` milliseconds of a sine wave at `freqHz`.
// Applies a 5 ms linear fade-in/out to avoid clicks.
static void playTone(float freqHz, uint32_t durationMs) {
  const uint32_t totalSamples = (uint32_t)((float)SAMPLE_RATE * durationMs / 1000.0f);
  const uint32_t fadeSamples  = SAMPLE_RATE * 5 / 1000;  // 5 ms fade
  static int16_t buf[BUF_SAMPLES * 2];                    // stereo interleaved

  Serial.printf("[test_speaker] playing %.0f Hz for %u ms  (%u samples)\n",
                freqHz, durationMs, totalSamples);

  float phase = 0.0f;
  const float phaseInc = 2.0f * (float)M_PI * freqHz / (float)SAMPLE_RATE;

  int32_t peak = 0;
  uint32_t written = 0;
  while (written < totalSamples) {
    uint32_t chunk = BUF_SAMPLES;
    if (written + chunk > totalSamples) chunk = totalSamples - written;

    for (uint32_t i = 0; i < chunk; i++) {
      float env = 1.0f;
      uint32_t pos = written + i;
      if (pos < fadeSamples)
        env = (float)pos / (float)fadeSamples;
      else if (pos > totalSamples - fadeSamples)
        env = (float)(totalSamples - pos) / (float)fadeSamples;

      int16_t s = (int16_t)(sinf(phase) * AMPLITUDE * env);
      buf[i * 2]     = s;  // left
      buf[i * 2 + 1] = s;  // right
      if (s > peak) peak = s;
      phase += phaseInc;
      if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
    }

    size_t bytesWritten = 0;
    size_t bytesExpected = chunk * sizeof(int16_t) * 2;
    esp_err_t err = i2s_write(I2S_PORT, buf, bytesExpected, &bytesWritten, portMAX_DELAY);
    if (written == 0) {
      // First chunk only: dump a few samples and the write result
      Serial.printf("[test_speaker] first i2s_write: err=%d  written=%u / expected=%u\n",
                    err, bytesWritten, bytesExpected);
      Serial.printf("[test_speaker] sample[0]=%d  sample[1]=%d  sample[127]=%d\n",
                    buf[0], buf[1], buf[127]);
    }
    if (bytesWritten != bytesExpected) {
      Serial.printf("[test_speaker] WARN short write: got %u expected %u\n",
                    bytesWritten, bytesExpected);
    }
    written += chunk;
  }
  Serial.printf("[test_speaker] done — peak sample: %d\n", (int)peak);
}

// Write silence for `durationMs` ms.
static void playSilence(uint32_t durationMs) {
  const uint32_t totalSamples = (uint32_t)((float)SAMPLE_RATE * durationMs / 1000.0f);
  static int16_t zeroBuf[BUF_SAMPLES * 2] = {};

  Serial.printf("[test_speaker] silence for %u ms\n", durationMs);

  uint32_t written = 0;
  while (written < totalSamples) {
    uint32_t chunk = BUF_SAMPLES;
    if (written + chunk > totalSamples) chunk = totalSamples - written;
    size_t bytesWritten = 0;
    i2s_write(I2S_PORT, zeroBuf, chunk * sizeof(int16_t) * 2, &bytesWritten, portMAX_DELAY);
    written += chunk;
  }
}

// Sweep linearly from startHz to endHz over durationMs.
static void playSweep(float startHz, float endHz, uint32_t durationMs) {
  const uint32_t totalSamples = (uint32_t)((float)SAMPLE_RATE * durationMs / 1000.0f);
  static int16_t buf[BUF_SAMPLES * 2];

  Serial.printf("[test_speaker] sweep %.0f → %.0f Hz over %u ms\n",
                startHz, endHz, durationMs);

  float phase = 0.0f;
  uint32_t written = 0;

  while (written < totalSamples) {
    uint32_t chunk = BUF_SAMPLES;
    if (written + chunk > totalSamples) chunk = totalSamples - written;

    for (uint32_t i = 0; i < chunk; i++) {
      float t       = (float)(written + i) / (float)totalSamples;
      float freqHz  = startHz + (endHz - startHz) * t;
      float phaseInc = 2.0f * (float)M_PI * freqHz / (float)SAMPLE_RATE;

      int16_t s = (int16_t)(sinf(phase) * AMPLITUDE);
      buf[i * 2]     = s;
      buf[i * 2 + 1] = s;
      phase += phaseInc;
      if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
    }

    size_t bytesWritten = 0;
    i2s_write(I2S_PORT, buf, chunk * sizeof(int16_t) * 2, &bytesWritten, portMAX_DELAY);
    written += chunk;
  }
  Serial.println("[test_speaker] sweep done");
}

static uint32_t loopCount = 0;

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("[test_speaker] starting");
  Serial.printf("[test_speaker] sample rate: %d Hz   amplitude: %d / 32767\n",
                SAMPLE_RATE, AMPLITUDE);
  Serial.println("[test_speaker] *** Start with volume LOW — amplitude tunable at top ***");

  wigglePins();

  if (!initSpeaker()) {
    Serial.println("[test_speaker] Halting. Reset to retry.");
    for (;;) delay(1000);
  }
  Serial.println("[test_speaker] I2S ready");
}

void loop() {
  loopCount++;
  Serial.printf("[test_speaker] --- loop %u ---\n", loopCount);

  playTone(440.0f, 1000);   // A4
  playTone(880.0f, 1000);   // A5
  playSweep(1000.0f, 200.0f, 2000);
  playSilence(1000);
}
