#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

int  ble_init(void);
bool ble_connected(void);
bool ble_mic_subscribed(void);
void ble_notify_mems(const int16_t accel[3], const int16_t gyro[3]);
void ble_notify_trigger(uint8_t evt);
void ble_notify_status(uint8_t status);
/* Send one mic chunk; returns 0 or -errno. Packet = [seqHi, seqLo, ...ulaw] */
int  ble_notify_mic(const uint8_t *ulaw, size_t len);
