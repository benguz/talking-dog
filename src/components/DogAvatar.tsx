import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { DogState } from '../types';
import { COLORS, RADIUS } from './theme';

interface DogAvatarProps {
  state: DogState;
  photoUri: string | null;
  avatarUri: string | null;
  size?: number;
}

export default function DogAvatar({
  state,
  photoUri,
  avatarUri,
  size = 160,
}: DogAvatarProps) {
  const float = useRef(new Animated.Value(0)).current;
  const bounce = useRef(new Animated.Value(1)).current;
  const shake = useRef(new Animated.Value(0)).current;

  // ── Animations per state ──────────────────────────────────────────────────

  useEffect(() => {
    float.stopAnimation();
    bounce.stopAnimation();
    shake.stopAnimation();

    if (state === 'idle' || state === 'calm' || state === 'speaking') {
      // Gentle float
      Animated.loop(
        Animated.sequence([
          Animated.timing(float, { toValue: -8, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(float, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ).start();
    } else if (state === 'wagging') {
      // Gentle rock
      Animated.loop(
        Animated.sequence([
          Animated.timing(shake, { toValue: 6, duration: 200, useNativeDriver: true }),
          Animated.timing(shake, { toValue: -6, duration: 200, useNativeDriver: true }),
          Animated.timing(shake, { toValue: 0, duration: 200, useNativeDriver: true }),
        ]),
      ).start();
    } else if (state === 'excited') {
      // Bouncing
      Animated.loop(
        Animated.sequence([
          Animated.timing(bounce, { toValue: 1.12, duration: 200, useNativeDriver: true }),
          Animated.timing(bounce, { toValue: 0.94, duration: 150, useNativeDriver: true }),
          Animated.timing(bounce, { toValue: 1, duration: 100, useNativeDriver: true }),
        ]),
      ).start();
    } else if (state === 'sleeping') {
      // Very slow float
      Animated.loop(
        Animated.sequence([
          Animated.timing(float, { toValue: -4, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(float, { toValue: 0, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ).start();
    } else if (state === 'alert') {
      // Quick stiff shake
      Animated.loop(
        Animated.sequence([
          Animated.timing(shake, { toValue: 4, duration: 80, useNativeDriver: true }),
          Animated.timing(shake, { toValue: -4, duration: 80, useNativeDriver: true }),
          Animated.timing(shake, { toValue: 0, duration: 80, useNativeDriver: true }),
          Animated.delay(400),
        ]),
      ).start();
    }
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const stateColor = STATE_COLORS[state] ?? COLORS.accent;
  const imageUri = avatarUri ?? photoUri;

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.avatarWrapper,
          {
            transform: [
              { translateY: float },
              { scale: bounce },
              { translateX: shake },
            ],
          },
        ]}>
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={[styles.photo, { width: size, height: size, borderRadius: size / 2, borderColor: stateColor }]}
          />
        ) : (
          <View style={[styles.placeholder, { width: size, height: size, borderRadius: size / 2 }]}>
            <Text style={[styles.emoji, { fontSize: size * 0.55 }]}>{STATE_EMOJIS[state]}</Text>
          </View>
        )}

        {/* State badge */}
        <View style={[styles.badge, { backgroundColor: stateColor }]}>
          <Text style={styles.badgeText}>{STATE_LABELS[state]}</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const STATE_COLORS: Record<DogState, string> = {
  idle: COLORS.accent,
  wagging: COLORS.wagging,
  excited: COLORS.excited,
  sleeping: COLORS.sleeping,
  alert: COLORS.alert,
  speaking: COLORS.speaking,
  calm: COLORS.calm,
};

const STATE_EMOJIS: Record<DogState, string> = {
  idle: '🐶',
  wagging: '🐕',
  excited: '🐕‍🦺',
  sleeping: '😴',
  alert: '👀',
  speaking: '💬',
  calm: '😌',
};

const STATE_LABELS: Record<DogState, string> = {
  idle: 'chilling',
  wagging: 'tail wagging!',
  excited: 'so excited!!',
  sleeping: 'zzz...',
  alert: 'on alert!',
  speaking: 'talking...',
  calm: 'relaxed',
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  avatarWrapper: {
    alignItems: 'center',
  },
  photo: {
    borderWidth: 3,
    borderColor: 'transparent',
  },
  placeholder: {
    backgroundColor: COLORS.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: COLORS.border,
  },
  emoji: {
    textAlign: 'center',
  },
  badge: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: RADIUS.full,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
