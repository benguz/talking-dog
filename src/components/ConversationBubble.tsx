import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChatMessage } from '../types';
import { COLORS, RADIUS, SPACING } from './theme';

interface Props {
  message: ChatMessage;
  dogName: string;
}

export default function ConversationBubble({ message, dogName }: Props) {
  const isDog = message.role === 'dog';

  return (
    <View style={[styles.row, isDog ? styles.rowDog : styles.rowHuman]}>
      {isDog && (
        <View style={styles.avatarDot}>
          <Text style={styles.avatarEmoji}>🐾</Text>
        </View>
      )}
      <View style={[styles.bubble, isDog ? styles.bubbleDog : styles.bubbleHuman]}>
        {isDog && (
          <Text style={styles.speakerLabel}>{dogName || 'Your Dog'}</Text>
        )}
        <Text style={[styles.text, isDog ? styles.textDog : styles.textHuman]}>
          {message.text}
        </Text>
        <Text style={styles.timestamp}>
          {formatTime(message.timestamp)}
        </Text>
      </View>
    </View>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    alignItems: 'flex-end',
  },
  rowDog: {
    justifyContent: 'flex-start',
  },
  rowHuman: {
    justifyContent: 'flex-end',
  },
  avatarDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.sm,
    flexShrink: 0,
  },
  avatarEmoji: {
    fontSize: 16,
  },
  bubble: {
    maxWidth: '75%',
    borderRadius: RADIUS.lg,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  bubbleDog: {
    backgroundColor: COLORS.surfaceElevated,
    borderBottomLeftRadius: 4,
  },
  bubbleHuman: {
    backgroundColor: COLORS.primary,
    borderBottomRightRadius: 4,
  },
  speakerLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.accent,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  text: {
    fontSize: 15,
    lineHeight: 22,
  },
  textDog: {
    color: COLORS.text,
  },
  textHuman: {
    color: '#fff',
  },
  timestamp: {
    fontSize: 10,
    color: COLORS.textMuted,
    marginTop: 4,
    alignSelf: 'flex-end',
  },
});
