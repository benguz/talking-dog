#pragma once
#include <stdint.h>
/* IMA ADPCM (DVI4): 4 bits/sample. 16 kHz speech at 8 kB/s.
 * Byte layout: low nibble = first sample, high nibble = second. */

struct adpcm_state {
	int16_t predictor;
	int8_t index;
};

static const int8_t adpcm_index_table[16] = {
	-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
};

static const int16_t adpcm_step_table[89] = {
	7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
	50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
	253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
	1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
	3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
	11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
	32767,
};

static inline void adpcm_reset(struct adpcm_state *s)
{
	s->predictor = 0;
	s->index = 0;
}

static inline int16_t adpcm_decode_nibble(struct adpcm_state *s, uint8_t nib)
{
	int step = adpcm_step_table[s->index];
	int diff = step >> 3;
	if (nib & 4) diff += step;
	if (nib & 2) diff += step >> 1;
	if (nib & 1) diff += step >> 2;
	int pred = s->predictor + ((nib & 8) ? -diff : diff);
	if (pred > 32767) pred = 32767;
	if (pred < -32768) pred = -32768;
	s->predictor = (int16_t)pred;
	int idx = s->index + adpcm_index_table[nib];
	s->index = (int8_t)(idx < 0 ? 0 : idx > 88 ? 88 : idx);
	return s->predictor;
}
