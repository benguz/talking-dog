/**
 * test_camera.ino — ESP32-CAM standalone test
 *
 * Module: AI-Thinker ESP32-CAM (OV2640 sensor, built-in pins)
 *
 * Expected Serial output at 115200 baud:
 *   Camera init result
 *   Per-capture line: frame size, capture time, whether the JPEG header is valid
 *   Counts captured frames; prints a summary every 10 captures
 *
 * Notes:
 *   - Flash the board with the correct partition scheme (e.g. "Huge APP")
 *     to ensure enough flash space for the camera frame buffer.
 *   - GPIO 4 controls the on-board LED flash; it is driven briefly during
 *     each capture so you can visually confirm the shutter.
 *
 * Flash target: AI-Thinker ESP32-CAM (board manager: "AI Thinker ESP32-CAM").
 */

#include <esp_camera.h>

// ─── AI-Thinker ESP32-CAM pin map ─────────────────────────────────────────────
#define CAM_PWDN    32
#define CAM_RESET   -1
#define CAM_XCLK     0
#define CAM_SIOD    26
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

#define FLASH_LED_PIN  4   // on-board white LED flash

// ─── Config ───────────────────────────────────────────────────────────────────
#define JPEG_QUALITY   12           // 0=best/largest, 63=worst; 12 ≈ 15-40 KB
#define FRAME_SIZE     FRAMESIZE_VGA  // 640×480; try FRAMESIZE_QVGA for faster captures

// ─── Camera init ──────────────────────────────────────────────────────────────
static bool initCamera() {
  camera_config_t cfg = {};
  cfg.ledc_channel  = LEDC_CHANNEL_0;
  cfg.ledc_timer    = LEDC_TIMER_0;
  cfg.pin_d0        = CAM_Y2;
  cfg.pin_d1        = CAM_Y3;
  cfg.pin_d2        = CAM_Y4;
  cfg.pin_d3        = CAM_Y5;
  cfg.pin_d4        = CAM_Y6;
  cfg.pin_d5        = CAM_Y7;
  cfg.pin_d6        = CAM_Y8;
  cfg.pin_d7        = CAM_Y9;
  cfg.pin_xclk      = CAM_XCLK;
  cfg.pin_pclk      = CAM_PCLK;
  cfg.pin_vsync     = CAM_VSYNC;
  cfg.pin_href      = CAM_HREF;
  cfg.pin_sccb_sda  = CAM_SIOD;
  cfg.pin_sccb_scl  = CAM_SIOC;
  cfg.pin_pwdn      = CAM_PWDN;
  cfg.pin_reset     = CAM_RESET;
  cfg.xclk_freq_hz  = 20000000;
  cfg.pixel_format  = PIXFORMAT_JPEG;
  cfg.frame_size    = FRAME_SIZE;
  cfg.jpeg_quality  = JPEG_QUALITY;
  cfg.fb_count      = 2;
  cfg.grab_mode     = CAMERA_GRAB_LATEST;
  return esp_camera_init(&cfg) == ESP_OK;
}

// JPEG SOI marker sanity check (first two bytes must be 0xFF 0xD8)
static bool isValidJpeg(const uint8_t* buf, size_t len) {
  return len >= 4 && buf[0] == 0xFF && buf[1] == 0xD8;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("[test_camera] starting");
  Serial.printf("[test_camera] frame size config: %s   JPEG quality: %d\n",
                (FRAME_SIZE == FRAMESIZE_VGA) ? "VGA (640x480)" :
                (FRAME_SIZE == FRAMESIZE_QVGA) ? "QVGA (320x240)" : "other",
                JPEG_QUALITY);

  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);

  if (!initCamera()) {
    Serial.println("[test_camera] FAIL — esp_camera_init failed. Check board selection and wiring.");
    Serial.println("[test_camera] Halting. Reset to retry.");
    for (;;) delay(1000);
  }

  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    Serial.printf("[test_camera] sensor PID=0x%04X\n", s->id.PID);
  }
  Serial.println("[test_camera] camera ready — capturing every 1 s");
  Serial.println("[test_camera]  #   bytes    ms   valid?");
}

static uint32_t captureCount  = 0;
static uint32_t failCount     = 0;
static uint64_t totalBytes    = 0;
static uint64_t totalMs       = 0;

void loop() {
  // Brief flash during capture so you can see it working
  digitalWrite(FLASH_LED_PIN, HIGH);
  uint32_t t0 = millis();

  camera_fb_t* fb = esp_camera_fb_get();
  uint32_t elapsed = millis() - t0;
  digitalWrite(FLASH_LED_PIN, LOW);

  captureCount++;

  if (!fb) {
    failCount++;
    Serial.printf("[test_camera] %4u  FAIL (fb_get returned null)\n", captureCount);
    delay(1000);
    return;
  }

  bool valid = isValidJpeg(fb->buf, fb->len);
  if (!valid) failCount++;

  totalBytes += fb->len;
  totalMs    += elapsed;

  Serial.printf("[test_camera] %4u  %6zu B  %3u ms  %s\n",
                captureCount, fb->len, elapsed, valid ? "OK" : "INVALID JPEG");

  esp_camera_fb_return(fb);

  // Summary every 10 captures
  if (captureCount % 10 == 0) {
    Serial.printf("[test_camera] --- summary: %u captures, %u failures, "
                  "avg %.0f B, avg %llu ms ---\n",
                  captureCount, failCount,
                  (float)totalBytes / captureCount,
                  totalMs / captureCount);
  }

  delay(1000);
}
