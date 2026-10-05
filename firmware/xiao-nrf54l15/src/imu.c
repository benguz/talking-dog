/*
 * MPU-6050 on xiao_i2c (I2C22, D4 = SDA, D5 = SCL), polled at IMU_POLL_HZ.
 * Streams raw MEMS packets at MEMS_NOTIFY_HZ and runs the sliding-window
 * spike detector ported from the ESP32 firmware.
 */
#include <math.h>
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/logging/log.h>

#include "collar_config.h"
#include "imu.h"
#include "ble.h"

LOG_MODULE_REGISTER(imu, LOG_LEVEL_INF);

static const struct device *const i2c_dev = DEVICE_DT_GET(DT_NODELABEL(i2c22));

#define REG_SMPLRT_DIV   0x19
#define REG_CONFIG       0x1A
#define REG_GYRO_CONFIG  0x1B
#define REG_ACCEL_CONFIG 0x1C
#define REG_ACCEL_XOUT_H 0x3B
#define REG_PWR_MGMT_1   0x6B
#define REG_WHO_AM_I     0x75

static int reg_write(uint8_t reg, uint8_t val)
{
	return i2c_reg_write_byte(i2c_dev, MPU6050_ADDR, reg, val);
}

static void imu_thread(void *a, void *b, void *c)
{
	float window[IMU_WINDOW_SIZE] = { 0 };
	int win_idx = 0, win_count = 0;
	float win_sum = 0.0f;
	int64_t last_event_ms = 0;
	uint32_t samples = 0, errors = 0;
	const int notify_every = IMU_POLL_HZ / MEMS_NOTIFY_HZ;

	for (;;) {
		int64_t t0 = k_uptime_get();
		uint8_t raw[14];
		int err = i2c_burst_read(i2c_dev, MPU6050_ADDR, REG_ACCEL_XOUT_H, raw, sizeof(raw));
		if (err) {
			if (++errors % 100 == 1) {
				LOG_WRN("read failed (%d), total errors %u", err, errors);
			}
			k_sleep(K_MSEC(1000 / IMU_POLL_HZ));
			continue;
		}
		int16_t accel[3] = { (int16_t)((raw[0] << 8) | raw[1]),
				     (int16_t)((raw[2] << 8) | raw[3]),
				     (int16_t)((raw[4] << 8) | raw[5]) };
		int16_t gyro[3]  = { (int16_t)((raw[8] << 8) | raw[9]),
				     (int16_t)((raw[10] << 8) | raw[11]),
				     (int16_t)((raw[12] << 8) | raw[13]) };
		samples++;

		if (samples % notify_every == 0) {
			ble_notify_mems(accel, gyro);
		}

		float ax = accel[0] / IMU_ACCEL_SCALE, ay = accel[1] / IMU_ACCEL_SCALE,
		      az = accel[2] / IMU_ACCEL_SCALE;
		float mag = sqrtf(ax * ax + ay * ay + az * az);

		win_sum -= window[win_idx];
		window[win_idx] = mag;
		win_sum += mag;
		win_idx = (win_idx + 1) % IMU_WINDOW_SIZE;
		if (win_count < IMU_WINDOW_SIZE) {
			win_count++;
		}

		if (samples % (IMU_POLL_HZ * 5) == 0) {
			LOG_INF("ax=%d ay=%d az=%d gx=%d gy=%d gz=%d |a|=%.3f g", accel[0], accel[1],
				accel[2], gyro[0], gyro[1], gyro[2], (double)mag);
		}

		if (win_count == IMU_WINDOW_SIZE) {
			float mean = win_sum / IMU_WINDOW_SIZE;
			float delta = mag - mean;
			int64_t now = k_uptime_get();
			if (now - last_event_ms > IMU_COOLDOWN_MS) {
				uint8_t evt = 0;
				if (delta > IMU_SPIKE_G)          evt = EVT_EXCITED;
				else if (delta > IMU_WAG_G)       evt = EVT_WAG_START;
				else if (delta < -IMU_WAG_DROP_G) evt = EVT_WAG_STOP;
				else if (mag < IMU_STILL_G)       evt = EVT_SLEEPING;
				if (evt) {
					LOG_INF("event 0x%02x  |a|=%.3f mean=%.3f delta=%+.3f", evt,
						(double)mag, (double)mean, (double)delta);
					ble_notify_trigger(evt);
					last_event_ms = now;
				}
			}
		}

		int64_t elapsed = k_uptime_get() - t0;
		int64_t period = 1000 / IMU_POLL_HZ;
		k_sleep(K_MSEC(elapsed < period ? period - elapsed : 1));
	}
}
K_THREAD_DEFINE(imu_tid, 2048, imu_thread, NULL, NULL, NULL, 7, 0, -1 /* start manually */);

int imu_init(void)
{
	if (!device_is_ready(i2c_dev)) {
		LOG_ERR("I2C22 not ready");
		return -ENODEV;
	}
	uint8_t who = 0;
	int err = i2c_reg_read_byte(i2c_dev, MPU6050_ADDR, REG_WHO_AM_I, &who);
	if (err) {
		LOG_ERR("MPU-6050 not found at 0x%02x (%d) — check SDA=D4 SCL=D5 VCC GND, AD0 to GND",
			MPU6050_ADDR, err);
		return err;
	}
	LOG_INF("MPU-6050 WHO_AM_I = 0x%02x (expect 0x68)", who);

	reg_write(REG_PWR_MGMT_1, 0x00);   /* wake, internal 8 MHz clock */
	k_sleep(K_MSEC(10));
	reg_write(REG_PWR_MGMT_1, 0x01);   /* PLL with X gyro ref (more stable) */
	reg_write(REG_SMPLRT_DIV, 9);      /* 1 kHz / (1+9) = 100 Hz */
	reg_write(REG_CONFIG, 0x03);       /* DLPF ~44 Hz */
	reg_write(REG_GYRO_CONFIG, 0x08);  /* ±500 °/s */
	reg_write(REG_ACCEL_CONFIG, 0x10); /* ±8 g */

	k_thread_start(imu_tid);
	LOG_INF("IMU thread running at %d Hz, MEMS notify at %d Hz", IMU_POLL_HZ, MEMS_NOTIFY_HZ);
	return 0;
}
