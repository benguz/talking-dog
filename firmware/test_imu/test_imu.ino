/**
 * test_imu.ino — MPU-6050 standalone test
 *
 * Wiring (I2C bus 1, same as main firmware):
 *   SDA → GPIO 16
 *   SCL → GPIO 17
 *   VCC → 3.3 V
 *   GND → GND
 *   AD0 → GND  (sets I2C address to 0x68)
 *
 * Expected Serial output at 115200 baud:
 *   WHO_AM_I = 0x68  ← proves the chip is alive on the bus
 *   accel/gyro readings scrolling at ~10 Hz
 *   "SPIKE" printed whenever a large acceleration is detected
 *
 * Flash target: any ESP32 board.
 */

#include <Wire.h>

// ─── Pin / address config ─────────────────────────────────────────────────────
#define IMU_SDA       16
#define IMU_SCL       17
#define MPU6050_ADDR  0x68

// ─── MPU-6050 register addresses ──────────────────────────────────────────────
#define REG_SMPLRT_DIV   0x19
#define REG_CONFIG       0x1A
#define REG_GYRO_CFG     0x1B
#define REG_ACCEL_CFG    0x1C
#define REG_PWR_MGMT_1   0x6B
#define REG_WHO_AM_I     0x75
#define REG_ACCEL_XOUT_H 0x3B

// ─── Thresholds ───────────────────────────────────────────────────────────────
#define ACCEL_SCALE   4096.0f   // counts/g  (AFS_SEL=2, ±8 g)
#define SPIKE_G       2.5f      // g magnitude that triggers "SPIKE" print

static TwoWire imuWire(1);

// Write one byte to an MPU-6050 register; returns false on NACK.
static bool writeReg(uint8_t reg, uint8_t val) {
  imuWire.beginTransmission(MPU6050_ADDR);
  imuWire.write(reg);
  imuWire.write(val);
  return imuWire.endTransmission(true) == 0;
}

// Read one byte from an MPU-6050 register.
static uint8_t readReg(uint8_t reg) {
  imuWire.beginTransmission(MPU6050_ADDR);
  imuWire.write(reg);
  imuWire.endTransmission(false);
  imuWire.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)1, (uint8_t)true);
  return imuWire.available() ? imuWire.read() : 0xFF;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("[test_imu] starting");
  Serial.printf("[test_imu] SDA=%d  SCL=%d  addr=0x%02X\n",
                IMU_SDA, IMU_SCL, MPU6050_ADDR);

  imuWire.begin(IMU_SDA, IMU_SCL, 400000);

  // ── WHO_AM_I sanity check ──────────────────────────────────────────────────
  uint8_t whoAmI = readReg(REG_WHO_AM_I);
  Serial.printf("[test_imu] WHO_AM_I = 0x%02X  (expect 0x68)\n", whoAmI);
  if (whoAmI != 0x68) {
    Serial.println("[test_imu] FAIL — wrong WHO_AM_I. Check wiring and pull-ups.");
    Serial.println("[test_imu] Halting. Reset to retry.");
    for (;;) delay(1000);
  }
  Serial.println("[test_imu] WHO_AM_I OK");

  // ── Wake up + configure ────────────────────────────────────────────────────
  if (!writeReg(REG_PWR_MGMT_1, 0x00)) {
    Serial.println("[test_imu] FAIL — could not write PWR_MGMT_1");
    for (;;) delay(1000);
  }
  delay(50);  // let clocks stabilise

  writeReg(REG_ACCEL_CFG, 0x10);  // ±8 g  (AFS_SEL=2)
  writeReg(REG_GYRO_CFG,  0x08);  // ±500 °/s (FS_SEL=1)
  writeReg(REG_CONFIG,    0x03);  // DLPF ~44 Hz
  writeReg(REG_SMPLRT_DIV, 9);   // 1 kHz / (9+1) = 100 Hz ODR

  Serial.println("[test_imu] configured — streaming at ~10 Hz");
  Serial.println("[test_imu] ax(g)   ay(g)   az(g)   mag(g)   gx   gy   gz");
}

void loop() {
  // ── Burst-read accel + temp (skip) + gyro (14 bytes from 0x3B) ────────────
  imuWire.beginTransmission(MPU6050_ADDR);
  imuWire.write(REG_ACCEL_XOUT_H);
  imuWire.endTransmission(false);
  uint8_t n = imuWire.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)14, (uint8_t)true);

  if (n < 14) {
    Serial.println("[test_imu] read FAILED — not enough bytes returned");
    delay(200);
    return;
  }

  int16_t ax = (int16_t)((imuWire.read() << 8) | imuWire.read());
  int16_t ay = (int16_t)((imuWire.read() << 8) | imuWire.read());
  int16_t az = (int16_t)((imuWire.read() << 8) | imuWire.read());
  imuWire.read(); imuWire.read();  // temperature — discard
  int16_t gx = (int16_t)((imuWire.read() << 8) | imuWire.read());
  int16_t gy = (int16_t)((imuWire.read() << 8) | imuWire.read());
  int16_t gz = (int16_t)((imuWire.read() << 8) | imuWire.read());

  float aX  = ax / ACCEL_SCALE;
  float aY  = ay / ACCEL_SCALE;
  float aZ  = az / ACCEL_SCALE;
  float mag = sqrtf(aX*aX + aY*aY + aZ*aZ);

  Serial.printf("[test_imu] %+6.3f  %+6.3f  %+6.3f  mag=%5.3f   gyro=%6d %6d %6d",
                aX, aY, aZ, mag, gx, gy, gz);

  if (mag > SPIKE_G) {
    Serial.printf("  *** SPIKE (%.2f g) ***", mag);
  }
  Serial.println();

  delay(100);  // ~10 Hz
}
