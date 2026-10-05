#pragma once
#include <stdint.h>
/* ITU-T G.711 μ-law <-> 16-bit linear PCM (matches app AudioService.encodeUlaw) */

static inline int16_t ulaw_decode(uint8_t u)
{
	u = ~u;
	int sign = u & 0x80;
	int exponent = (u >> 4) & 0x07;
	int mantissa = u & 0x0F;
	int sample = ((mantissa << 3) + 0x84) << exponent;
	sample -= 0x84;
	return (int16_t)(sign ? -sample : sample);
}

static inline uint8_t ulaw_encode(int16_t pcm)
{
	const int BIAS = 0x84, CLIP = 32635;
	int sign = (pcm >> 8) & 0x80;
	if (sign) pcm = -pcm;
	if (pcm > CLIP) pcm = CLIP;
	pcm += BIAS;
	int exponent = 7;
	for (int mask = 0x4000; (pcm & mask) == 0 && exponent > 0; exponent--, mask >>= 1) {}
	int mantissa = (pcm >> (exponent + 3)) & 0x0F;
	return (uint8_t)~(sign | (exponent << 4) | mantissa);
}
