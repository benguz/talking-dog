/*
 * Speaker path: BLE AUDIO_TX packets → ring buffer → μ-law decode + 2× upsample
 * → I2S20 (16 kHz, 16-bit, stereo) → MAX98357A.
 *
 * Playback starts once AUDIO_PREBUFFER bytes have arrived (or the end marker
 * comes first), pads with silence on underrun, and drains after the end marker.
 */
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/i2s.h>
#include <zephyr/sys/ring_buffer.h>
#include <zephyr/logging/log.h>

#include "collar_config.h"
#include "audio_out.h"
#include "ulaw.h"
#include "adpcm.h"

LOG_MODULE_REGISTER(audio_out, LOG_LEVEL_INF);

static const struct device *const i2s_dev = DEVICE_DT_GET(DT_NODELABEL(i2s20));
K_MEM_SLAB_DEFINE_STATIC(spk_slab, SPK_BLOCK_BYTES, SPK_BLOCK_COUNT, 4);

RING_BUF_DECLARE(rx_ring, AUDIO_RX_RING_BYTES);
static K_SEM_DEFINE(data_sem, 0, 1);

enum enc { ENC_ULAW = 1, ENC_PCM8 = 2, ENC_ADPCM = 3 /* IMA ADPCM, 2 samples/byte */ };
static struct adpcm_state adpcm;
static volatile bool stream_open;      /* header seen, end marker not yet */
static volatile bool stream_eof;
static volatile uint16_t stream_sr = 8000;
static volatile uint8_t stream_enc = ENC_ULAW;
static uint16_t expected_chunks, rx_chunks, last_seq;
static uint32_t dropped_bytes, underruns;
static int64_t stream_t0_ms;
static uint32_t stream_rx_bytes;

static volatile uint32_t beep_ms;
static volatile bool playing;

bool audio_out_is_playing(void)
{
	return playing;
}

/* ── I2S helpers ────────────────────────────────────────────────────────────── */
static int i2s_setup(void)
{
	struct i2s_config cfg = {
		.word_size = 16,
		.channels = 2,
		.format = I2S_FMT_DATA_FORMAT_I2S,
		.options = I2S_OPT_BIT_CLK_MASTER | I2S_OPT_FRAME_CLK_MASTER,
		.frame_clk_freq = SPK_SAMPLE_RATE,
		.mem_slab = &spk_slab,
		.block_size = SPK_BLOCK_BYTES,
		.timeout = 200,
	};
	return i2s_configure(i2s_dev, I2S_DIR_TX, &cfg);
}

/* Gain + soft limiter: ×SPK_GAIN_X10/10, then peaks above the knee are
 * compressed toward full scale with a smooth rational curve (never hard clip). */
static inline int16_t apply_gain(int16_t s)
{
	int32_t v = ((int32_t)s * SPK_GAIN_X10) / 10;
	int32_t a = v < 0 ? -v : v;
	if (a > SPK_LIMIT_KNEE) {
		const int32_t head = 32767 - SPK_LIMIT_KNEE;
		int32_t over = a - SPK_LIMIT_KNEE;
		a = SPK_LIMIT_KNEE + (over * head) / (over + head);
	}
	return (int16_t)(v < 0 ? -a : a);
}

/* Fill one block from the ring buffer; returns number of source bytes consumed. */
static size_t fill_block(int16_t *frames /* SPK_BLOCK_FRAMES*2 */)
{
	const int up = (stream_sr >= 16000) ? 1 : 2;   /* 8 kHz → repeat each sample */
	const int spb = (stream_enc == ENC_ADPCM) ? 2 : 1; /* samples per source byte */
	const size_t need = SPK_BLOCK_FRAMES / up / spb;
	uint8_t src[SPK_BLOCK_FRAMES];
	size_t got = ring_buf_get(&rx_ring, src, need);
	size_t f = 0;

	for (size_t i = 0; i < got; i++) {
		for (int k = 0; k < spb; k++) {
			int16_t s;
			if (stream_enc == ENC_ADPCM) {
				s = adpcm_decode_nibble(&adpcm, (k == 0) ? (src[i] & 0x0F) : (src[i] >> 4));
			} else if (stream_enc == ENC_PCM8) {
				s = (int16_t)((int8_t)src[i] << 8);
			} else {
				s = ulaw_decode(src[i]);
			}
			s >>= SPK_GAIN_SHIFT;
			s = apply_gain(s);
			for (int r = 0; r < up; r++) {
				frames[f++] = s;   /* L */
				frames[f++] = s;   /* R */
			}
		}
	}
	if (got < need) {
		memset(&frames[f], 0, (SPK_BLOCK_FRAMES * 2 - f) * sizeof(int16_t));
		if (got == 0 && !stream_eof) {
			underruns++;
		}
	}
	return got;
}

static void fill_beep(int16_t *frames, uint32_t *phase)
{
	for (int i = 0; i < SPK_BLOCK_FRAMES; i++) {
		/* 1 kHz square-ish tone at low amplitude */
		int16_t s = ((*phase / (SPK_SAMPLE_RATE / 2000)) & 1) ? 3000 : -3000;
		(*phase)++;
		frames[2 * i] = s;
		frames[2 * i + 1] = s;
	}
}

static int write_block(void *block)
{
	int err = i2s_write(i2s_dev, block, SPK_BLOCK_BYTES);
	if (err) {
		k_mem_slab_free(&spk_slab, block);
	}
	return err;
}

/* ── Playback thread ────────────────────────────────────────────────────────── */
static void audio_thread(void *a, void *b, void *c)
{
	for (;;) {
		/* Wait until there is something worth playing */
		k_sem_take(&data_sem, K_FOREVER);
		bool beep = beep_ms > 0;
		if (!beep && ring_buf_size_get(&rx_ring) < AUDIO_PREBUFFER && !stream_eof) {
			continue;
		}

		/* After DRAIN the driver stays busy until its last block plays
		 * (≤ SPK_BLOCK_COUNT × 10 ms); configure() fails until then. */
		int cfg_err = -EIO;
		for (int tries = 0; tries < 30 && cfg_err; tries++) {
			cfg_err = i2s_setup();
			if (cfg_err) {
				k_sleep(K_MSEC(10));
			}
		}
		if (cfg_err) {
			LOG_ERR("i2s_configure failed (%d) — dropping clip", cfg_err);
			ring_buf_reset(&rx_ring);
			continue;
		}
		LOG_INF("playback start (%s, %u B buffered, sr %u)", beep ? "beep" : "stream",
			ring_buf_size_get(&rx_ring), stream_sr);
		playing = true;

		uint32_t phase = 0;
		int32_t beep_left = beep ? (int32_t)beep_ms * (SPK_SAMPLE_RATE / 1000) : 0;
		int queued = 0;
		bool started = false;
		int err = 0;
		int64_t idle_since = 0;   /* when the last clip ran dry (0 = playing) */

		for (;;) {
			void *block;
			if (k_mem_slab_alloc(&spk_slab, &block, K_MSEC(200))) {
				LOG_WRN("slab alloc timeout");
				break;
			}
			bool done;
			if (beep) {
				fill_beep(block, &phase);
				beep_left -= SPK_BLOCK_FRAMES;
				done = beep_left <= 0;
			} else {
				size_t got;
				if (idle_since != 0 && !stream_eof &&
				    ring_buf_size_get(&rx_ring) < AUDIO_PREBUFFER) {
					/* Next clip is arriving: let it pre-buffer briefly
					 * (silence meanwhile) so its first packets don't
					 * get eaten faster than they land. */
					memset(block, 0, SPK_BLOCK_BYTES);
					got = 0;
					done = false;
					goto write_it;
				}
				got = fill_block(block);
				if (got > 0) {
					idle_since = 0;
					done = false;
				} else if (stream_eof && ring_buf_is_empty(&rx_ring)) {
					/* Clip finished. Sentences arrive as separate clips, so
					 * keep the I2S clock running on silence for a moment:
					 * the next one then starts seamlessly instead of
					 * paying a drain + reconfigure + pre-buffer gap. */
					int64_t now = k_uptime_get();
					if (idle_since == 0) {
						idle_since = now;
					}
					done = (now - idle_since) >= AUDIO_KEEPALIVE_MS;
				} else {
					done = false; /* underrun mid-clip: silence, keep going */
				}
			}
write_it:
			err = write_block(block);
			if (err) {
				LOG_ERR("i2s_write failed (%d)", err);
				break;
			}
			queued++;
			if (!started && queued >= 2) {
				err = i2s_trigger(i2s_dev, I2S_DIR_TX, I2S_TRIGGER_START);
				if (err) {
					LOG_ERR("i2s START failed (%d)", err);
					break;
				}
				started = true;
			}
			if (done) {
				break;
			}
		}

		playing = false;
		if (started) {
			i2s_trigger(i2s_dev, I2S_DIR_TX, err ? I2S_TRIGGER_DROP : I2S_TRIGGER_DRAIN);
		}
		if (beep) {
			beep_ms = 0;
		}
		LOG_INF("playback done (blocks=%d underruns=%u dropped=%u)", queued, underruns,
			dropped_bytes);
		underruns = 0;
	}
}
K_THREAD_DEFINE(audio_tid, 2048, audio_thread, NULL, NULL, NULL, 5, 0, 0);

/* ── Stream API (called from the BT RX thread) ──────────────────────────────── */
void audio_out_stream_begin(uint16_t total_chunks, uint16_t sample_rate, uint8_t encoding)
{
	expected_chunks = total_chunks;
	rx_chunks = 0;
	last_seq = 0xFFFF;
	dropped_bytes = 0;
	stream_sr = sample_rate ? sample_rate : 8000;
	stream_enc = encoding ? encoding : ENC_ULAW;
	adpcm_reset(&adpcm);
	stream_eof = false;
	stream_open = true;
	stream_t0_ms = k_uptime_get();
	stream_rx_bytes = 0;
	LOG_INF("audio stream: %u chunks, %u Hz, enc %u", total_chunks, stream_sr, stream_enc);
}

void audio_out_stream_data(uint16_t seq, const uint8_t *data, size_t len)
{
	if (seq == 0x7FFF) {
		return;   /* app's packet-size probe: not audio */
	}
	if (!stream_open) {
		/* App may send data without a header — accept it with defaults. */
		audio_out_stream_begin(0, 8000, ENC_ULAW);
	}
	if (last_seq != 0xFFFF && seq != (uint16_t)(last_seq + 1)) {
		LOG_WRN("seq gap: got %u after %u", seq, last_seq);
	}
	last_seq = seq;
	rx_chunks++;

	size_t put = ring_buf_put(&rx_ring, data, len);
	stream_rx_bytes += len;
	if (put < len) {
		dropped_bytes += len - put;
	}
	if (ring_buf_size_get(&rx_ring) >= AUDIO_PREBUFFER) {
		k_sem_give(&data_sem);
	}
}

void audio_out_stream_end(void)
{
	if (!stream_open) {
		return;
	}
	stream_open = false;
	stream_eof = true;
	int64_t ms = k_uptime_get() - stream_t0_ms;
	LOG_INF("audio stream end: %u/%u chunks, %u B in %lld ms (%u B/pkt, %.1f kB/s; need 8.0), %u B buffered",
		rx_chunks, expected_chunks, stream_rx_bytes, ms,
		rx_chunks ? stream_rx_bytes / rx_chunks : 0,
		ms ? (double)stream_rx_bytes / (double)ms : 0.0, ring_buf_size_get(&rx_ring));
	k_sem_give(&data_sem);
}

void audio_out_beep(uint32_t ms)
{
	beep_ms = ms;
	k_sem_give(&data_sem);
}

int audio_out_init(void)
{
	if (!device_is_ready(i2s_dev)) {
		LOG_ERR("I2S20 not ready — check overlay");
		return -ENODEV;
	}
	int err = i2s_setup();
	if (err) {
		LOG_ERR("i2s_configure failed (%d)", err);
		return err;
	}
	LOG_INF("I2S20 ready: %u Hz, 16-bit stereo, BCLK=D0 LRC=D1 DIN=D2", SPK_SAMPLE_RATE);
	return 0;
}
