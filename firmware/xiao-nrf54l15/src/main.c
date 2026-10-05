/*
 * Talking Dog collar — Seeed XIAO nRF54L15 (Zephyr)
 *
 *   BLE   : advertises "DogCollarTest"; see ble.c for the GATT layout
 *   IMU   : MPU-6050 on D4/D5 → MEMS notifications + trigger events
 *   Audio : phone → AUDIO_TX → MAX98357A on D0/D1/D2
 *   Mic   : onboard PDM (Sense only, COLLAR_MIC=1) → MIC notifications
 *
 * Boot self-test: short beep on the speaker, LED blinks while advertising,
 * solid while connected. Press the user button for another beep.
 */
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/logging/log.h>

#include "collar_config.h"
#include "ble.h"
#include "audio_out.h"
#include "imu.h"
#include "mic.h"

LOG_MODULE_REGISTER(collar, LOG_LEVEL_INF);

static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
static const struct gpio_dt_spec btn = GPIO_DT_SPEC_GET(DT_ALIAS(sw0), gpios);
static struct gpio_callback btn_cb;

static void on_button(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
	audio_out_beep(150);
}

int main(void)
{
	LOG_INF("============================================");
	LOG_INF("Talking Dog collar — XIAO nRF54L15  (mic=%s)", COLLAR_MIC ? "on" : "off");

	if (gpio_is_ready_dt(&led)) {
		gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	}
	if (gpio_is_ready_dt(&btn)) {
		gpio_pin_configure_dt(&btn, GPIO_INPUT);
		gpio_pin_interrupt_configure_dt(&btn, GPIO_INT_EDGE_TO_ACTIVE);
		gpio_init_callback(&btn_cb, on_button, BIT(btn.pin));
		gpio_add_callback(btn.port, &btn_cb);
	}

	int spk = audio_out_init();
	int imu = imu_init();
	int mic = mic_init();
	int ble = ble_init();

	LOG_INF("init: speaker=%s imu=%s mic=%s ble=%s",
		spk ? "FAIL" : "ok", imu ? "FAIL" : "ok", mic ? "FAIL" : "ok", ble ? "FAIL" : "ok");
	LOG_INF("============================================");

	if (!spk) {
		audio_out_beep(120);
	}

	uint32_t tick = 0;
	for (;;) {
		bool conn = ble_connected();
		if (gpio_is_ready_dt(&led)) {
			gpio_pin_set_dt(&led, conn ? 1 : (tick % 10 == 0));
		}
		if (tick % 300 == 0) {   /* every 30 s */
			LOG_INF("uptime %llu s  ble=%s", k_uptime_get() / 1000,
				conn ? "connected" : "advertising");
		}
		tick++;
		k_sleep(K_MSEC(100));
	}
	return 0;
}
