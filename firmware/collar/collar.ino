/**
 * Talking Dog Collar Firmware
 * Hardware: AI-Thinker ESP32-CAM + MPU-6050 (I2C) + INMP441 (I2S)
 *
 * Signal pipeline
 * ───────────────
 *   Core 0, Task imuTask  : polls MPU-6050 at 100 Hz
 *                           → sliding-window spike detector
 *                           → posts event to eventQueue
 *
 *   Core 0, Task micTask  : reads INMP441 via I2S in 20 ms frames
 *                           → RMS energy onset detector
 *                           → posts EVT_BARK to eventQueue
 *
 *   Core 1, loop()        : dequeues events
 *                           → fires charTrigger BLE notify (existing app handler)
 *                           → captures JPEG from ESP32-CAM
 *                           → streams JPEG over charCamera in BLE_CHUNK_PAYLOAD-byte chunks
 *                           → streams raw MEMS packet at ~50 Hz for live display
 *
 * BLE camera protocol (charCamera notifications)
 * ───────────────────────────────────────────────
 *   Header  [0x01, event_type, total_len (4B big-endian)]            6 bytes
 *   Chunk   [0x02, seq_hi, seq_lo, ...data (BLE_CHUNK_PAYLOAD B)]  180 bytes max
 *   EOF     [0x03]                                                    1 byte
 *
 * Libraries required (install via Arduino Library Manager / platformio.ini)
 *   - ESP32 Arduino core (espressif/arduino-esp32 >= 2.0.0)
 *   - Built-in: Wire, driver/i2s, esp_camera, BLEDevice
 */

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

// ─── Module enable flags ──────────────────────────────────────────────────────
// Set any of these to false to skip initialising that module and its task.
// Useful when hardware is missing or being debugged in isolation.
static const bool USE_CAMERA = false;
static const bool USE_IMU    = true;
static const bool USE_MIC    = false;

#include <Wire.h>
#include <driver/i2s.h>
#include <esp_camera.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ─── Forward declarations ─────────────────────────────────────────────────────
static void imuTask(void* param);
static void micTask(void* param);
static void sendEventAndFrame(uint8_t eventType);
static bool initCamera();
static bool initIMU();
static bool initMic();
static void streamMemsPacket();

// ─── BLE globals ──────────────────────────────────────────────────────────────
static BLEServer*         bleServer   = nullptr;
static BLECharacteristic* charMems    = nullptr;
static BLECharacteristic* charTrigger = nullptr;
static BLECharacteristic* charCamera  = nullptr;
static BLECharacteristic* charStatus  = nullptr;

static volatile bool bleConnected = false;

// ─── Cross-task event queue ───────────────────────────────────────────────────
// Simple single-slot queue protected by a critical section.
// If two events fire simultaneously, the higher-priority one wins (first writer wins).
static volatile bool    eventPending = false;
static volatile uint8_t pendingEvent = 0;
static portMUX_TYPE     eventMux     = portMUX_INITIALIZER_UNLOCKED;

static inline void postEvent(uint8_t evt) {
  portENTER_CRITICAL(&eventMux);
  if (!eventPending) {           // don't overwrite an unprocessed event
    eventPending = true;
    pendingEvent = evt;
  }
  portEXIT_CRITICAL(&eventMux);
}

// ─── Shared MEMS packet (written by imuTask, read by loop) ───────────────────
struct __attribute__((packed)) MemsPacket {
  int16_t ax, ay, az;
  int16_t gx, gy, gz;
};
static volatile MemsPacket latestMems = {};
static portMUX_TYPE        memsMux    = portMUX_INITIALIZER_UNLOCKED;

// ─── BLE server callbacks ─────────────────────────────────────────────────────
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    bleConnected = true;
    Serial.println("[BLE] phone connected");
    // Update status characteristic
    uint8_t ok = 0x01;
    charStatus->setValue(&ok, 1);
    charStatus->notify();
  }
  void onDisconnect(BLEServer*) override {
    bleConnected = false;
    Serial.println("[BLE] disconnected — restarting advertising");
    bleServer->startAdvertising();
  }
};

// ─── setup() ─────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("[collar] ============================================");
  Serial.println("[collar] Talking Dog Collar — booting");
  Serial.printf( "[collar] modules enabled: camera=%s  imu=%s  mic=%s\n",
                 USE_CAMERA ? "YES" : "NO",
                 USE_IMU    ? "YES" : "NO",
                 USE_MIC    ? "YES" : "NO");
  Serial.printf( "[collar] free heap at boot: %u bytes\n", ESP.getFreeHeap());

  // ── Camera ────────────────────────────────────────────────────────────────
  if (USE_CAMERA) {
    Serial.println("[camera] initialising...");
    if (!initCamera()) {
      Serial.println("[camera] FAILED — check OV2640 ribbon and PWDN wiring");
    } else {
      sensor_t* s = esp_camera_sensor_get();
      Serial.printf("[camera] ready  sensor PID=0x%04X  frame=%s  quality=%d\n",
                    s ? s->id.PID : 0,
                    (CAM_FRAMESIZE == FRAMESIZE_VGA)  ? "VGA"  :
                    (CAM_FRAMESIZE == FRAMESIZE_QVGA) ? "QVGA" : "other",
                    JPEG_QUALITY);
    }
  } else {
    Serial.println("[camera] SKIPPED (USE_CAMERA=false)");
  }

  // ── IMU ────────────────────────────────────────────────────────────────────
  if (USE_IMU) {
    Serial.printf("[IMU] initialising on I2C bus 1  SDA=%d SCL=%d addr=0x%02X...\n",
                  IMU_SDA, IMU_SCL, MPU6050_ADDR);
    if (!initIMU()) {
      Serial.println("[IMU] FAILED — check SDA/SCL wiring and pull-up resistors");
    } else {
      Serial.printf("[IMU] ready  poll=%d Hz  window=%d ms  spike=%.1fg  wag=%.1fg\n",
                    IMU_POLL_HZ, IMU_WINDOW_MS, IMU_SPIKE_G, IMU_WAG_G);
    }
  } else {
    Serial.println("[IMU] SKIPPED (USE_IMU=false)");
  }

  // ── Microphone ────────────────────────────────────────────────────────────
  if (USE_MIC) {
    Serial.printf("[mic] initialising INMP441  WS=%d SCK=%d SD=%d...\n",
                  MIC_WS, MIC_SCK, MIC_SD);
    if (!initMic()) {
      Serial.println("[mic] FAILED — check WS/SCK/SD wiring");
    } else {
      Serial.printf("[mic] ready  sample_rate=%d Hz  frame=%d samples  bark_energy=%lld\n",
                    MIC_SAMPLE_RATE, MIC_FRAME_SAMPLES, (long long)MIC_ENERGY_BARK);
    }
  } else {
    Serial.println("[mic] SKIPPED (USE_MIC=false)");
  }

  Serial.printf("[collar] free heap after peripherals: %u bytes\n", ESP.getFreeHeap());

  // ── BLE setup ──────────────────────────────────────────────────────────────
  Serial.println("[BLE] initialising...");
  BLEDevice::init(BLE_DEVICE_NAME);
  // Request larger MTU so JPEG transfers are faster
  BLEDevice::setMTU(517);

  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());

  BLEService* svc = bleServer->createService(BLEUUID(SERVICE_UUID), 32);

  charMems = svc->createCharacteristic(
    CHAR_MEMS_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  charMems->addDescriptor(new BLE2902());
  Serial.println("[BLE] MEMS characteristic registered");

  charTrigger = svc->createCharacteristic(
    CHAR_TRIGGER_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  charTrigger->addDescriptor(new BLE2902());
  Serial.println("[BLE] Trigger characteristic registered");

  charCamera = svc->createCharacteristic(
    CHAR_CAMERA_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  charCamera->addDescriptor(new BLE2902());
  Serial.println("[BLE] Camera characteristic registered");

  charStatus = svc->createCharacteristic(
    CHAR_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  charStatus->addDescriptor(new BLE2902());
  Serial.println("[BLE] Status characteristic registered");

  svc->start();
  Serial.println("[BLE] service started");

  BLEAdvertising* adv = bleServer->getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->start();
  Serial.printf("[BLE] advertising as \"%s\"  service=%s\n",
                BLE_DEVICE_NAME, SERVICE_UUID);

  // ── Start sensor tasks on core 0 ───────────────────────────────────────────
  // loop() runs on core 1 (Arduino default); sensors get their own core.
  if (USE_IMU) {
    xTaskCreatePinnedToCore(imuTask, "imu", 4096, nullptr, 2, nullptr, 0);
    Serial.println("[IMU] task started on core 0");
  }
  if (USE_MIC) {
    xTaskCreatePinnedToCore(micTask, "mic", 8192, nullptr, 1, nullptr, 0);
    Serial.println("[mic] task started on core 0");
  }

  Serial.printf("[collar] free heap at loop start: %u bytes\n", ESP.getFreeHeap());
  Serial.println("[collar] ============================================");
  Serial.println("[collar] running");
}

// ─── loop() — event consumer + MEMS streamer ─────────────────────────────────
static unsigned long lastMemsNotify  = 0;
static unsigned long lastHeapLogMs   = 0;
static uint32_t      loopEventCount  = 0;
static uint32_t      loopMemsCount   = 0;

void loop() {
  // Consume any pending event from the sensor tasks
  if (eventPending) {
    uint8_t evt;
    portENTER_CRITICAL(&eventMux);
    evt          = pendingEvent;
    eventPending = false;
    portEXIT_CRITICAL(&eventMux);

    loopEventCount++;
    Serial.printf("[loop] event #%u received: 0x%02X (%s)\n",
                  loopEventCount, evt,
                  evt == EVT_WAG_START ? "WAG_START" :
                  evt == EVT_WAG_STOP  ? "WAG_STOP"  :
                  evt == EVT_BARK      ? "BARK"       :
                  evt == EVT_EXCITED   ? "EXCITED"    :
                  evt == EVT_CALM      ? "CALM"       :
                  evt == EVT_SLEEPING  ? "SLEEPING"   :
                  evt == EVT_ALERT     ? "ALERT"      : "UNKNOWN");
    sendEventAndFrame(evt);
  }

  // Stream raw MEMS at ~50 Hz for live avatar animation in the app
  if (USE_IMU && bleConnected && (millis() - lastMemsNotify) >= 20) {
    streamMemsPacket();
    lastMemsNotify = millis();
    loopMemsCount++;
  }

  // Periodic heap log every 30 s so we can spot memory leaks
  if (millis() - lastHeapLogMs >= 30000) {
    lastHeapLogMs = millis();
    Serial.printf("[collar] uptime=%lus  heap=%u B  events=%u  mems_notifies=%u  ble=%s\n",
                  millis() / 1000, ESP.getFreeHeap(),
                  loopEventCount, loopMemsCount,
                  bleConnected ? "connected" : "advertising");
  }

  delay(5);
}

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
  cfg.frame_size    = CAM_FRAMESIZE;
  cfg.jpeg_quality  = JPEG_QUALITY;
  cfg.fb_count      = 2;             // double-buffer: one capturing while one is being sent
  cfg.grab_mode     = CAMERA_GRAB_LATEST;

  return esp_camera_init(&cfg) == ESP_OK;
}

// ─── IMU init (MPU-6050 on secondary I2C bus) ────────────────────────────────
static TwoWire imuWire(1);  // I2C bus 1 — avoids camera's bus 0 (SIOD=26, SIOC=27)

static bool initIMU() {
  imuWire.begin(IMU_SDA, IMU_SCL, 400000);

  // Wake up: write 0 to PWR_MGMT_1 (register 0x6B)
  imuWire.beginTransmission(MPU6050_ADDR);
  imuWire.write(0x6B);
  imuWire.write(0x00);
  if (imuWire.endTransmission(true) != 0) return false;

  // Accelerometer full-scale = ±8 g  (ACCEL_CONFIG register 0x1C, AFS_SEL=2 → 0x10)
  imuWire.beginTransmission(MPU6050_ADDR);
  imuWire.write(0x1C); imuWire.write(0x10);
  imuWire.endTransmission(true);

  // Gyroscope full-scale = ±500 °/s (GYRO_CONFIG  register 0x1B, FS_SEL=1 → 0x08)
  imuWire.beginTransmission(MPU6050_ADDR);
  imuWire.write(0x1B); imuWire.write(0x08);
  imuWire.endTransmission(true);

  // Low-pass filter: ~44 Hz bandwidth (DLPF_CFG=3, register 0x1A)
  imuWire.beginTransmission(MPU6050_ADDR);
  imuWire.write(0x1A); imuWire.write(0x03);
  imuWire.endTransmission(true);

  return true;
}

// ─── Mic init (INMP441 on I2S peripheral 1) ──────────────────────────────────
static bool initMic() {
  const i2s_config_t cfg = {
    .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate          = MIC_SAMPLE_RATE,
    .bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count        = 4,
    .dma_buf_len          = MIC_FRAME_SAMPLES,
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
  if (i2s_driver_install(I2S_NUM_1, &cfg, 0, nullptr) != ESP_OK) return false;
  if (i2s_set_pin(I2S_NUM_1, &pins) != ESP_OK) {
    i2s_driver_uninstall(I2S_NUM_1);
    return false;
  }
  i2s_start(I2S_NUM_1);
  return true;
}

// ─── IMU task ─────────────────────────────────────────────────────────────────
// Runs at IMU_POLL_HZ on core 0.
// Maintains a circular sliding window of acceleration magnitudes and
// classifies motion based on how the current sample deviates from the mean.
//
// Classification logic:
//   |delta| > IMU_SPIKE_G      → EVT_EXCITED   (jump, sudden lunge)
//   |delta| > IMU_WAG_G        → EVT_WAG_START  (rhythmic tail wag / trot)
//   delta    < -IMU_WAG_DROP_G → EVT_WAG_STOP
//   mag      < IMU_STILL_G     → EVT_SLEEPING   (dog is motionless)
//
static void imuTask(void* param) {
  const TickType_t period = pdMS_TO_TICKS(1000 / IMU_POLL_HZ);

  float    window[IMU_WINDOW_SIZE] = {};
  int      winIdx      = 0;
  float    winSum      = 0.0f;
  int      winCount    = 0;
  uint32_t lastEventMs = 0;
  uint32_t readErrors  = 0;
  uint32_t sampleCount = 0;

  Serial.printf("[IMU] task running on core %d  period=%d ms\n",
                xPortGetCoreID(), 1000 / IMU_POLL_HZ);

  for (;;) {
    TickType_t wake = xTaskGetTickCount();

    // Read accel + temp (skipped) + gyro — 14 bytes from register 0x3B
    imuWire.beginTransmission(MPU6050_ADDR);
    imuWire.write(0x3B);
    imuWire.endTransmission(false);
    uint8_t n = imuWire.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)14, (uint8_t)true);
    if (n < 14) {
      readErrors++;
      if (readErrors % 100 == 1) {
        Serial.printf("[IMU] WARNING — read failed (got %u/14 bytes); total errors: %u\n",
                      n, readErrors);
      }
      vTaskDelayUntil(&wake, period);
      continue;
    }

    int16_t ax = (int16_t)((imuWire.read() << 8) | imuWire.read());
    int16_t ay = (int16_t)((imuWire.read() << 8) | imuWire.read());
    int16_t az = (int16_t)((imuWire.read() << 8) | imuWire.read());
    imuWire.read(); imuWire.read(); // temperature — discard
    int16_t gx = (int16_t)((imuWire.read() << 8) | imuWire.read());
    int16_t gy = (int16_t)((imuWire.read() << 8) | imuWire.read());
    int16_t gz = (int16_t)((imuWire.read() << 8) | imuWire.read());
    sampleCount++;

    // Update shared MEMS packet for BLE streaming
    portENTER_CRITICAL(&memsMux);
    latestMems.ax = ax; latestMems.ay = ay; latestMems.az = az;
    latestMems.gx = gx; latestMems.gy = gy; latestMems.gz = gz;
    portEXIT_CRITICAL(&memsMux);

    // Convert to g — ±8 g range → 4096 counts/g
    float aX  = ax / IMU_ACCEL_SCALE;
    float aY  = ay / IMU_ACCEL_SCALE;
    float aZ  = az / IMU_ACCEL_SCALE;
    float mag = sqrtf(aX*aX + aY*aY + aZ*aZ);

    // Update sliding window
    winSum -= window[winIdx];
    window[winIdx] = mag;
    winSum += mag;
    winIdx = (winIdx + 1) % IMU_WINDOW_SIZE;
    if (winCount < IMU_WINDOW_SIZE) winCount++;

    // Log raw values every ~5 s while window is filling (diagnostic aid)
    if (winCount < IMU_WINDOW_SIZE && sampleCount % (IMU_POLL_HZ * 5) == 0) {
      Serial.printf("[IMU] filling window (%d/%d)  ax=%d ay=%d az=%d mag=%.3fg\n",
                    winCount, IMU_WINDOW_SIZE, ax, ay, az, mag);
    }

    // Need a full window before we trust the mean
    if (winCount < IMU_WINDOW_SIZE) {
      vTaskDelayUntil(&wake, period);
      continue;
    }

    float mean  = winSum / IMU_WINDOW_SIZE;
    float delta = mag - mean;
    uint32_t now = millis();

    if ((now - lastEventMs) > (uint32_t)IMU_COOLDOWN_MS) {
      uint8_t evt = 0;

      if      (delta >  IMU_SPIKE_G)    evt = EVT_EXCITED;
      else if (delta >  IMU_WAG_G)      evt = EVT_WAG_START;
      else if (delta < -IMU_WAG_DROP_G) evt = EVT_WAG_STOP;
      else if (mag   <  IMU_STILL_G)    evt = EVT_SLEEPING;

      if (evt) {
        Serial.printf("[IMU] event 0x%02X  mag=%.3fg  mean=%.3fg  delta=%+.3fg\n",
                      evt, mag, mean, delta);
        postEvent(evt);
        lastEventMs = now;
      }
    }

    vTaskDelayUntil(&wake, period);
  }
}

// ─── Mic task ─────────────────────────────────────────────────────────────────
// Runs continuously on core 0, blocking on i2s_read().
// INMP441 delivers 24-bit audio left-justified in a 32-bit word (top 24 bits valid).
// We right-shift by 8 to get a signed 24-bit value, then compute mean-square energy.
//
static void micTask(void* param) {
  static int32_t samples[MIC_FRAME_SAMPLES];
  size_t   bytesRead      = 0;
  uint32_t lastEventMs    = 0;
  uint32_t frameCount     = 0;
  uint32_t i2sErrors      = 0;
  int64_t  peakEnergyEver = 0;

  Serial.printf("[mic] task running on core %d\n", xPortGetCoreID());

  for (;;) {
    esp_err_t err = i2s_read(
      I2S_NUM_1, samples, sizeof(samples), &bytesRead, portMAX_DELAY);

    if (err != ESP_OK) {
      i2sErrors++;
      if (i2sErrors % 50 == 1) {
        Serial.printf("[mic] WARNING — i2s_read error %d (total errors: %u)\n",
                      err, i2sErrors);
      }
      continue;
    }
    if (bytesRead == 0) continue;

    frameCount++;
    int     count  = (int)(bytesRead / sizeof(int32_t));
    int64_t energy = 0;
    for (int i = 0; i < count; i++) {
      int32_t s = samples[i] >> 8;   // 24-bit signed sample
      energy += (int64_t)s * s;
    }
    energy /= count;  // mean square

    if (energy > peakEnergyEver) peakEnergyEver = energy;

    // Log peak energy every ~5 s (250 frames at 20 ms each) for threshold tuning
    if (frameCount % 250 == 0) {
      Serial.printf("[mic] frame=%u  last_energy=%lld  peak_ever=%lld  bark_threshold=%lld\n",
                    frameCount, energy, peakEnergyEver, (long long)MIC_ENERGY_BARK);
    }

    uint32_t now = millis();
    if (energy > MIC_ENERGY_BARK && (now - lastEventMs) > (uint32_t)MIC_COOLDOWN_MS) {
      postEvent(EVT_BARK);
      lastEventMs = now;
      Serial.printf("[mic] BARK detected  energy=%lld  threshold=%lld\n",
                    energy, (long long)MIC_ENERGY_BARK);
    }
  }
}

// ─── BLE MEMS streaming ───────────────────────────────────────────────────────
static void streamMemsPacket() {
  MemsPacket pkt;
  portENTER_CRITICAL(&memsMux);
  pkt.ax = latestMems.ax; pkt.ay = latestMems.ay; pkt.az = latestMems.az;
  pkt.gx = latestMems.gx; pkt.gy = latestMems.gy; pkt.gz = latestMems.gz;
  portEXIT_CRITICAL(&memsMux);

  charMems->setValue((uint8_t*)&pkt, sizeof(pkt));
  charMems->notify();
}

// ─── Camera capture + BLE chunked send ───────────────────────────────────────
// Called from loop() (core 1) so it doesn't block the sensor tasks.
//
// Protocol:
//   1. Notify charTrigger [event_type]  — fires existing app handler immediately
//   2. Notify charCamera  [0x01, event_type, total_len(4B big-endian)]  — header
//   3. Notify charCamera  [0x02, seq_hi, seq_lo, ...data]               — chunks
//   4. Notify charCamera  [0x03]                                         — EOF
//
// The app reassembles the JPEG from chunks and passes (event_type, jpeg) to the model.
//
static void sendEventAndFrame(uint8_t eventType) {
  Serial.printf("[event] 0x%02X — firing trigger notify\n", eventType);

  // 1. Fire trigger notify immediately so the app reacts without waiting for the JPEG
  charTrigger->setValue(&eventType, 1);
  charTrigger->notify();

  if (!bleConnected) {
    Serial.println("[event] BLE not connected — skipping camera capture");
    return;
  }

  if (!USE_CAMERA) {
    Serial.println("[event] camera disabled — skipping frame capture");
    return;
  }

  // 2. Capture JPEG frame
  Serial.println("[camera] capturing frame...");
  uint32_t t0 = millis();
  camera_fb_t* fb = esp_camera_fb_get();
  uint32_t captureMs = millis() - t0;
  if (!fb) {
    Serial.println("[camera] fb_get FAILED — null framebuffer");
    return;
  }
  Serial.printf("[camera] %zu bytes JPEG captured in %u ms\n", fb->len, captureMs);

  // 3. Header packet
  uint8_t header[6] = {
    0x01,
    eventType,
    (uint8_t)(fb->len >> 24),
    (uint8_t)(fb->len >> 16),
    (uint8_t)(fb->len >>  8),
    (uint8_t)(fb->len      ),
  };
  charCamera->setValue(header, sizeof(header));
  charCamera->notify();
  delay(BLE_CHUNK_DELAY_MS);

  // 4. Data chunks
  uint16_t seq    = 0;
  size_t   offset = 0;

  while (offset < fb->len) {
    size_t chunkLen = fb->len - offset;
    if (chunkLen > (size_t)BLE_CHUNK_PAYLOAD) chunkLen = BLE_CHUNK_PAYLOAD;

    uint8_t pkt[3 + BLE_CHUNK_PAYLOAD];
    pkt[0] = 0x02;
    pkt[1] = (uint8_t)(seq >> 8);
    pkt[2] = (uint8_t)(seq     );
    memcpy(pkt + 3, fb->buf + offset, chunkLen);

    charCamera->setValue(pkt, 3 + chunkLen);
    charCamera->notify();

    offset += chunkLen;
    seq++;
    delay(BLE_CHUNK_DELAY_MS);
  }

  // 5. EOF
  uint8_t eof = 0x03;
  charCamera->setValue(&eof, 1);
  charCamera->notify();

  size_t jpegLen = fb->len;
  esp_camera_fb_return(fb);
  Serial.printf("[camera] transfer complete — %u chunks  %zu bytes  evt=0x%02X\n",
                seq, jpegLen, eventType);
}
