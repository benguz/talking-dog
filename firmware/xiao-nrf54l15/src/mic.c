/*
 * Onboard PDM microphone (XIAO nRF54L15 Sense) → 16 kHz PCM → 2:1 decimate
 * → μ-law 8 kHz → MIC notifications, 20 ms (160 B) per packet.
 * Only active while the phone has subscribed to the MIC characteristic.
 * Compiled out unless COLLAR_MIC=1.
 */
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "collar_config.h"
#include "mic.h"

LOG_MODULE_REGISTER(mic, LOG_LEVEL_INF);

#if COLLAR_MIC
#include <zephyr/device.h>
#include <zephyr/audio/dmic.h>
#include "ble.h"
#include "ulaw.h"
#include "audio_out.h"

static const struct device *const dmic_dev = DEVICE_DT_GET(DT_NODELABEL(pdm20));
K_MEM_SLAB_DEFINE_STATIC(mic_slab, MIC_BLOCK_BYTES, MIC_BLOCK_COUNT, 4);

static struct pcm_stream_cfg stream = {
	.pcm_width = 16,
	.mem_slab = &mic_slab,
};
static struct dmic_cfg cfg = {
	.io = {
		.min_pdm_clk_freq = 1000000,
		.max_pdm_clk_freq = 3500000,
		.min_pdm_clk_dc = 40,
		.max_pdm_clk_dc = 60,
	},
	.streams = &stream,
	.channel = {
		.req_num_streams = 1,
		.req_num_chan = 1,
	},
};

static void mic_thread(void *a, void *b, void *c)
{
	bool running = false;
	uint32_t sent = 0, errs = 0;

	for (;;) {
		bool want = ble_mic_subscribed();

		if (want && !running) {
			int err = dmic_trigger(dmic_dev, DMIC_TRIGGER_START);
			if (err) {
				LOG_ERR("dmic START failed (%d)", err);
				k_sleep(K_MSEC(500));
				continue;
			}
			running = true;
			sent = errs = 0;
			LOG_INF("mic streaming started");
		} else if (!want && running) {
			dmic_trigger(dmic_dev, DMIC_TRIGGER_STOP);
			running = false;
			LOG_INF("mic streaming stopped (%u packets, %u errors)", sent, errs);
		}

		if (!running) {
			k_sleep(K_MSEC(100));
			continue;
		}

		void *block;
		size_t size;
		int err = dmic_read(dmic_dev, 0, &block, &size, 100);
		if (err) {
			if (++errs % 50 == 1) {
				LOG_WRN("dmic_read failed (%d)", err);
			}
			continue;
		}

		const int16_t *pcm = block;
		size_t n = size / 2;               /* 16-bit samples */
		uint8_t ulaw[MIC_BLOCK_SAMPLES / 2];
		size_t m = 0;
		for (size_t i = 0; i + 1 < n && m < sizeof(ulaw); i += 2) {
			ulaw[m++] = ulaw_encode((int16_t)(((int32_t)pcm[i] + pcm[i + 1]) / 2));
		}
		k_mem_slab_free(&mic_slab, block);

		/* The phone ignores mic audio while the collar speaks (it would
		 * only hear itself), so don't spend BLE airtime on it: the speech
		 * stream needs every connection event it can get. */
		if (audio_out_is_playing()) {
			continue;
		}

		err = ble_notify_mic(ulaw, m);
		if (err == 0) {
			sent++;
		} else if (err == -EMSGSIZE) {
			if (++errs % 100 == 1) {
				LOG_WRN("MTU too small for %u B mic packets — app must request MTU ≥ 165", m + 2);
			}
		} else if (err != -ENOTCONN && err != -ENOMEM) {
			errs++;
		}
		/* -ENOMEM = TX queue full: just drop this 20 ms and keep going */
	}
}
K_THREAD_DEFINE(mic_tid, 2048, mic_thread, NULL, NULL, NULL, 6, 0, -1);

int mic_init(void)
{
	if (!device_is_ready(dmic_dev)) {
		LOG_ERR("PDM20 not ready");
		return -ENODEV;
	}
	cfg.channel.req_chan_map_lo = dmic_build_channel_map(0, 0, PDM_CHAN_LEFT);
	stream.pcm_rate = MIC_PCM_RATE;
	stream.block_size = MIC_BLOCK_BYTES;

	int err = dmic_configure(dmic_dev, &cfg);
	if (err) {
		LOG_ERR("dmic_configure failed (%d)", err);
		return err;
	}
	k_thread_start(mic_tid);
	LOG_INF("PDM mic ready: %u Hz → μ-law 8 kHz, %u B per BLE packet", MIC_PCM_RATE,
		MIC_BLOCK_SAMPLES / 2 + 2);
	return 0;
}
#else
int mic_init(void)
{
	LOG_INF("mic disabled (COLLAR_MIC=0; build env collar-sense for the Sense's onboard mic)");
	return 0;
}
#endif
