#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* Phone → collar audio (CHAR_AUDIO_TX write handler feeds these). */
int  audio_out_init(void);
void audio_out_stream_begin(uint16_t total_chunks, uint16_t sample_rate, uint8_t encoding);
void audio_out_stream_data(uint16_t seq, const uint8_t *data, size_t len);
void audio_out_stream_end(void);
/* Local self-test: play a 1 kHz beep for `ms` milliseconds. */
void audio_out_beep(uint32_t ms);
/* True while the speaker is playing (or holding the clock between clips). */
bool audio_out_is_playing(void);
