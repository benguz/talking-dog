export const COLORS = {
  // Dark warm background
  background: '#0F0D12',
  surface: '#1A1621',
  surfaceElevated: '#221E2E',
  border: '#2E2840',

  // Accent — warm amber/golden
  accent: '#F5A623',
  accentSoft: '#F5A62330',
  accentDark: '#C07800',

  // Paw purple
  primary: '#8B5CF6',
  primarySoft: '#8B5CF620',

  // Text
  text: '#F5F0FF',
  textSecondary: '#B8AFCC',
  textMuted: '#6B6480',

  // Status
  success: '#4ADE80',
  warning: '#FBBF24',
  error: '#F87171',
  info: '#60A5FA',

  // Dog state colors
  wagging: '#F59E0B',
  excited: '#EF4444',
  sleeping: '#6366F1',
  alert: '#F97316',
  calm: '#34D399',
  speaking: '#8B5CF6',
};

export const FONTS = {
  heading: {
    fontFamily: 'System',
    fontWeight: '800' as const,
  },
  body: {
    fontFamily: 'System',
    fontWeight: '400' as const,
  },
  medium: {
    fontFamily: 'System',
    fontWeight: '600' as const,
  },
};

export const RADIUS = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
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
