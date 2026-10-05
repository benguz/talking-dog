import { Platform } from 'react-native';

/**
 * Light, friendly palette inspired by thanksmerlin.com:
 * cream background, white surfaces, black primary CTAs, subtle
 * black-tinted borders, with a warm amber accent for dog moments.
 */
export const COLORS = {
  // Cream canvas + white cards
  background: '#FAF9F6',
  surface: '#FFFFFF',
  surfaceElevated: '#F4F2ED',
  border: 'rgba(0, 0, 0, 0.10)',
  borderStrong: 'rgba(0, 0, 0, 0.18)',

  // Warm amber for selection / dog accents
  accent: '#E07B00',
  accentSoft: 'rgba(224, 123, 0, 0.10)',
  accentDark: '#A85A00',

  // Black is the primary (matches thanksmerlin CTA buttons)
  primary: '#0A0A0A',
  primarySoft: 'rgba(0, 0, 0, 0.06)',

  // Text — black with opacity ramps
  text: '#0A0A0A',
  textSecondary: 'rgba(0, 0, 0, 0.72)',
  textMuted: 'rgba(0, 0, 0, 0.50)',
  textInverse: '#FFFFFF',

  // Status
  success: '#16A34A',
  warning: '#D97706',
  error: '#DC2626',
  info: '#2563EB',

  // Dog state colors (tuned for light bg)
  wagging: '#E07B00',
  excited: '#DC2626',
  sleeping: '#4F46E5',
  alert: '#EA580C',
  calm: '#059669',
  speaking: '#0A0A0A',
};

const HEADING_FAMILY = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia',
});

export const FONTS = {
  heading: {
    fontFamily: HEADING_FAMILY,
    fontWeight: '700' as const,
  },
  body: {
    fontFamily: undefined,
    fontWeight: '400' as const,
  },
  medium: {
    fontFamily: undefined,
    fontWeight: '600' as const,
  },
};

export const HEADING_FONT_FAMILY = HEADING_FAMILY;

export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 999,
};

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};
