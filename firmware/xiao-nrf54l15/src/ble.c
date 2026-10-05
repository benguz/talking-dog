/*
 * BLE GATT service for the Talking Dog collar.
 *
 * Service COLLAR_SVC_UUID
 *   MEMS     notify        12 B  [ax,ay,az,gx,gy,gz] int16 LE            (collar → phone)
 *   AUDIO_TX write/wwr     phone → speaker. Packets:
 *              header  [0xFF,0xFF, chunksHi,chunksLo, srHi,srLo, enc]
 *                      enc 1 = μ-law, 2 = signed 8-bit PCM, 3 = IMA ADPCM (16 kHz, 8 kB/s)
 *              data    [seqHi,seqLo, ...audio]                          any length ≤ MTU-3
 *              end     [0xFF,0xFE]
 *   TRIGGER  notify         1 B  event code                             (collar → phone)
 *   STATUS   read/notify    read: [0x01=ready, lastAudioPktLen BE16, attMtu BE16]; notify: [status]
 *   MIC      notify        [seqHi,seqLo, ...μ-law 8 kHz]                (collar → phone)
 */
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/sys/byteorder.h>

#include "collar_config.h"
#include "ble.h"
#include "audio_out.h"

LOG_MODULE_REGISTER(ble, LOG_LEVEL_INF);

#define UUID_SVC     BT_UUID_DECLARE_128(COLLAR_SVC_UUID_VAL)
#define UUID_MEMS    BT_UUID_DECLARE_128(COLLAR_MEMS_UUID_VAL)
#define UUID_AUDIO   BT_UUID_DECLARE_128(COLLAR_AUDIO_UUID_VAL)
#define UUID_TRIGGER BT_UUID_DECLARE_128(COLLAR_TRIGGER_UUID_VAL)
#define UUID_STATUS  BT_UUID_DECLARE_128(COLLAR_STATUS_UUID_VAL)
#define UUID_MIC     BT_UUID_DECLARE_128(COLLAR_MIC_UUID_VAL)

static struct bt_conn *cur_conn;
static uint8_t status_val = 0x00;
static uint16_t last_audio_pkt_len;   /* lets the app probe its real max packet size */
static bool mems_subscribed, trigger_subscribed, mic_subscribed;
static uint16_t mic_seq;

/* ── AUDIO_TX write handler ─────────────────────────────────────────────────── */
static ssize_t audio_write(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			   const void *buf, uint16_t len, uint16_t offset, uint8_t flags)
{
	const uint8_t *p = buf;

	if (offset != 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
	}
	if (len < 2) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}
	last_audio_pkt_len = len;

	if (p[0] == 0xFF && p[1] == 0xFF) {
		if (len < 7) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		uint16_t chunks = sys_get_be16(&p[2]);
		uint16_t sr     = sys_get_be16(&p[4]);
		audio_out_stream_begin(chunks, sr, p[6]);
	} else if (p[0] == 0xFF && p[1] == 0xFE) {
		audio_out_stream_end();
	} else {
		audio_out_stream_data(sys_get_be16(p), p + 2, len - 2);
	}
	return len;
}

/* Read: [status, last audio packet length BE16, negotiated ATT MTU BE16]. Notify: [status]. */
static ssize_t status_read(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			   void *buf, uint16_t len, uint16_t offset)
{
	uint16_t mtu = conn ? bt_gatt_get_mtu(conn) : 23;
	uint8_t v[5] = { status_val, last_audio_pkt_len >> 8, last_audio_pkt_len & 0xFF,
			 mtu >> 8, mtu & 0xFF };
	return bt_gatt_attr_read(conn, attr, buf, len, offset, v, sizeof(v));
}

static void mems_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	mems_subscribed = (value == BT_GATT_CCC_NOTIFY);
	LOG_INF("MEMS notifications %s", mems_subscribed ? "ON" : "off");
}
static void trigger_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	trigger_subscribed = (value == BT_GATT_CCC_NOTIFY);
	LOG_INF("TRIGGER notifications %s", trigger_subscribed ? "ON" : "off");
}
static void status_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	LOG_INF("STATUS notifications %s", value == BT_GATT_CCC_NOTIFY ? "ON" : "off");
}
static void mic_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	mic_subscribed = (value == BT_GATT_CCC_NOTIFY);
	mic_seq = 0;
	LOG_INF("MIC stream %s", mic_subscribed ? "ON" : "off");
}

BT_GATT_SERVICE_DEFINE(collar_svc,
	BT_GATT_PRIMARY_SERVICE(UUID_SVC),

	BT_GATT_CHARACTERISTIC(UUID_MEMS, BT_GATT_CHRC_NOTIFY, BT_GATT_PERM_NONE,
			       NULL, NULL, NULL),
	BT_GATT_CCC(mems_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

	BT_GATT_CHARACTERISTIC(UUID_AUDIO,
			       BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
			       BT_GATT_PERM_WRITE, NULL, audio_write, NULL),

	BT_GATT_CHARACTERISTIC(UUID_TRIGGER, BT_GATT_CHRC_NOTIFY, BT_GATT_PERM_NONE,
			       NULL, NULL, NULL),
	BT_GATT_CCC(trigger_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

	BT_GATT_CHARACTERISTIC(UUID_STATUS, BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ, status_read, NULL, &status_val),
	BT_GATT_CCC(status_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

	BT_GATT_CHARACTERISTIC(UUID_MIC, BT_GATT_CHRC_NOTIFY, BT_GATT_PERM_NONE,
			       NULL, NULL, NULL),
	BT_GATT_CCC(mic_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

/* Attribute indices into collar_svc.attrs (service decl = 0, each char = decl+value, CCC = +1) */
#define ATTR_MEMS_VAL     2
#define ATTR_TRIGGER_VAL  7
#define ATTR_STATUS_VAL   10
#define ATTR_MIC_VAL      13

/* ── Advertising ────────────────────────────────────────────────────────────── */
static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME, sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};
static const struct bt_data sd[] = {
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, COLLAR_SVC_UUID_VAL),
};

static void start_adv(void)
{
	int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
	if (err && err != -EALREADY) {
		LOG_ERR("adv start failed (%d)", err);
	} else {
		LOG_INF("advertising as \"%s\"", CONFIG_BT_DEVICE_NAME);
	}
}

static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		LOG_ERR("connection failed (0x%02x)", err);
		/* advertising restarts from recycled() once the conn object is freed */
		return;
	}
	char addr[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));
	LOG_INF("connected: %s", addr);

	cur_conn = bt_conn_ref(conn);
	status_val = 0x01;
	bt_gatt_notify(conn, &collar_svc.attrs[ATTR_STATUS_VAL], &status_val, 1);
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	LOG_INF("disconnected (0x%02x)", reason);
	if (cur_conn) {
		bt_conn_unref(cur_conn);
		cur_conn = NULL;
	}
	mems_subscribed = trigger_subscribed = mic_subscribed = false;
	audio_out_stream_end();
	/*
	 * Don't call bt_le_adv_start() here: the connection object is still
	 * allocated until the stack recycles it, and connectable advertising
	 * would fail with -ENOMEM (LED keeps blinking, phone sees nothing).
	 * recycled() below runs once the slot is free.
	 */
}

static void recycled(void)
{
	LOG_INF("connection slot recycled — advertising again");
	start_adv();
}

static void le_param_updated(struct bt_conn *conn, uint16_t interval, uint16_t latency,
			     uint16_t timeout)
{
	LOG_INF("conn params: interval %u.%02u ms, latency %u, timeout %u ms",
		(interval * 125) / 100, (interval * 125) % 100, latency, timeout * 10);
}

BT_CONN_CB_DEFINE(conn_cbs) = {
	.connected = connected,
	.disconnected = disconnected,
	.recycled = recycled,
	.le_param_updated = le_param_updated,
};

static void mtu_updated(struct bt_conn *conn, uint16_t tx, uint16_t rx)
{
	LOG_INF("MTU updated: tx %u rx %u (audio payload up to %u B/packet)", tx, rx, tx - 3);
}
static struct bt_gatt_cb gatt_cbs = { .att_mtu_updated = mtu_updated };

/* ── Public API ─────────────────────────────────────────────────────────────── */
int ble_init(void)
{
	int err = bt_enable(NULL);
	if (err) {
		LOG_ERR("bt_enable failed (%d)", err);
		return err;
	}
	bt_gatt_cb_register(&gatt_cbs);
	start_adv();
	return 0;
}

bool ble_connected(void)      { return cur_conn != NULL; }
bool ble_mic_subscribed(void) { return cur_conn != NULL && mic_subscribed; }

void ble_notify_mems(const int16_t accel[3], const int16_t gyro[3])
{
	if (!cur_conn || !mems_subscribed) {
		return;
	}
	int16_t pkt[6] = { sys_cpu_to_le16(accel[0]), sys_cpu_to_le16(accel[1]),
			   sys_cpu_to_le16(accel[2]), sys_cpu_to_le16(gyro[0]),
			   sys_cpu_to_le16(gyro[1]),  sys_cpu_to_le16(gyro[2]) };
	bt_gatt_notify(cur_conn, &collar_svc.attrs[ATTR_MEMS_VAL], pkt, sizeof(pkt));
}

void ble_notify_trigger(uint8_t evt)
{
	if (!cur_conn || !trigger_subscribed) {
		return;
	}
	bt_gatt_notify(cur_conn, &collar_svc.attrs[ATTR_TRIGGER_VAL], &evt, 1);
}

void ble_notify_status(uint8_t status)
{
	status_val = status;
	if (cur_conn) {
		bt_gatt_notify(cur_conn, &collar_svc.attrs[ATTR_STATUS_VAL], &status_val, 1);
	}
}

int ble_notify_mic(const uint8_t *ulaw, size_t len)
{
	if (!cur_conn || !mic_subscribed) {
		return -ENOTCONN;
	}
	uint16_t max = bt_gatt_get_mtu(cur_conn) - 3;
	if (len + 2 > max) {
		return -EMSGSIZE;
	}
	uint8_t pkt[2 + 244];
	sys_put_be16(mic_seq++, pkt);
	memcpy(pkt + 2, ulaw, len);
	return bt_gatt_notify(cur_conn, &collar_svc.attrs[ATTR_MIC_VAL], pkt, len + 2);
}
