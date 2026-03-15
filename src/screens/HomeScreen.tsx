import React, { useCallback, useEffect, useRef } from 'react';
import {
  Animated,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDogStore } from '../store/dogStore';
import { useBluetooth } from '../hooks/useBluetooth';
import { useLLM } from '../hooks/useLLM';
import DogAvatar from '../components/DogAvatar';
import ConversationBubble from '../components/ConversationBubble';
import TriggerButton from '../components/TriggerButton';
import { COLORS, RADIUS, SPACING } from '../components/theme';
import { CollarTrigger, ManualTrigger } from '../types';

const MANUAL_TRIGGERS: {
  trigger: ManualTrigger;
  emoji: string;
  label: string;
}[] = [
  { trigger: ManualTrigger.TREATS, emoji: '🍖', label: 'Treats' },
  { trigger: ManualTrigger.PLAY, emoji: '🎾', label: 'Play?' },
  { trigger: ManualTrigger.WHATS_UP, emoji: '🐾', label: "What's up?" },
  { trigger: ManualTrigger.GOOD_DOG, emoji: '⭐', label: 'Good dog!' },
  { trigger: ManualTrigger.WHATS_WRONG, emoji: '🤔', label: "What's wrong?" },
];

export default function HomeScreen() {
  const {
    dogProfile,
    dogState,
    bleStatus,
    messages,
    isGenerating,
    llmStatus,
    setDogState,
  } = useDogStore();

  const { generateResponse } = useLLM();
  const flatListRef = useRef<FlatList>(null);

  // ── Collar trigger handler ────────────────────────────────────────────────

  const handleCollarTrigger = useCallback(
    (trigger: CollarTrigger) => {
      // Update visual state immediately
      if (trigger === CollarTrigger.WAG_START) setDogState('wagging');
      if (trigger === CollarTrigger.EXCITED) setDogState('excited');
      if (trigger === CollarTrigger.SLEEPING) setDogState('sleeping');
      if (trigger === CollarTrigger.ALERT) setDogState('alert');
      if (trigger === CollarTrigger.CALM || trigger === CollarTrigger.WAG_STOP) setDogState('calm');

      // Only generate speech for meaningful triggers, not every mems update
      const shouldSpeak = [
        CollarTrigger.WAG_START,
        CollarTrigger.BARK,
        CollarTrigger.EXCITED,
        CollarTrigger.SLEEPING,
        CollarTrigger.ALERT,
      ].includes(trigger);

      if (shouldSpeak && !isGenerating && llmStatus === 'ready') {
        generateResponse(trigger);
      }
    },
    [isGenerating, llmStatus, generateResponse, setDogState],
  );

  const { startScan } = useBluetooth({ onTrigger: handleCollarTrigger });

  // Auto-scroll to latest message
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  const handleManualTrigger = (trigger: ManualTrigger) => {
    if (isGenerating) return;
    if (llmStatus !== 'ready') {
      // Show a prompt to load the model
      return;
    }
    generateResponse(trigger);
  };

  const isConnected = bleStatus === 'connected';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>hey there 👋</Text>
          <Text style={styles.headerTitle}>
            {dogProfile.name ? `${dogProfile.name} is here` : 'Your dog is here'}
          </Text>
        </View>
        <CollarStatusBadge status={bleStatus} onConnect={startScan} />
      </View>

      {/* Dog Avatar */}
      <View style={styles.avatarSection}>
        <DogAvatar
          state={dogState}
          photoUri={dogProfile.photoUri}
          avatarUri={dogProfile.avatarUri}
          size={140}
        />
      </View>

      {/* LLM Status */}
      {llmStatus !== 'ready' && (
        <LLMStatusBanner status={llmStatus} />
      )}

      {/* Conversation */}
      <View style={styles.conversationContainer}>
        {messages.length === 0 ? (
          <EmptyConversation dogName={dogProfile.name} isConnected={isConnected} />
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={m => m.id}
            renderItem={({ item }) => (
              <ConversationBubble message={item} dogName={dogProfile.name} />
            )}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.messageList}
          />
        )}
      </View>

      {/* Manual trigger buttons */}
      <View style={styles.triggersSection}>
        <Text style={styles.triggersLabel}>Ask them something</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.triggersRow}>
          {MANUAL_TRIGGERS.map(({ trigger, emoji, label }) => (
            <TriggerButton
              key={trigger}
              emoji={emoji}
              label={label}
              onPress={() => handleManualTrigger(trigger)}
              disabled={isGenerating || llmStatus !== 'ready'}
            />
          ))}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function CollarStatusBadge({
  status,
  onConnect,
}: {
  status: string;
  onConnect: () => void;
}) {
  const isConnected = status === 'connected';
  const isScanning = status === 'scanning' || status === 'connecting';

  return (
    <Pressable onPress={isConnected ? undefined : onConnect} style={styles.collarBadge}>
      <View style={[styles.collarDot, { backgroundColor: STATUS_COLORS[status] ?? COLORS.textMuted }]} />
      <Text style={styles.collarBadgeText}>
        {isConnected
          ? 'Collar on'
          : isScanning
          ? 'Connecting...'
          : 'Connect collar'}
      </Text>
    </Pressable>
  );
}

const STATUS_COLORS: Record<string, string> = {
  connected: COLORS.success,
  scanning: COLORS.warning,
  connecting: COLORS.warning,
  error: COLORS.error,
  disconnected: COLORS.textMuted,
  idle: COLORS.textMuted,
};

function LLMStatusBanner({ status }: { status: string }) {
  if (status === 'not_loaded') {
    return (
      <View style={styles.llmBanner}>
        <Text style={styles.llmBannerText}>
          ⚙️  Drop a GGUF model into Documents/ to enable AI speech. See README.
        </Text>
      </View>
    );
  }
  if (status === 'loading') {
    return (
      <View style={[styles.llmBanner, { borderColor: COLORS.warning }]}>
        <Text style={styles.llmBannerText}>⏳  Loading AI model…</Text>
      </View>
    );
  }
  return null;
}

function EmptyConversation({
  dogName,
  isConnected,
}: {
  dogName: string;
  isConnected: boolean;
}) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyEmoji}>💬</Text>
      <Text style={styles.emptyTitle}>
        {dogName ? `${dogName} hasn't spoken yet` : 'Nothing yet'}
      </Text>
      <Text style={styles.emptyBody}>
        {isConnected
          ? 'Waiting for the collar to pick up some action…'
          : 'Connect the collar to listen in, or use the buttons below to start a conversation!'}
      </Text>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  greeting: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontWeight: '500',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.text,
  },
  collarBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.surfaceElevated,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  collarDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  collarBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  avatarSection: {
    alignItems: 'center',
    paddingVertical: SPACING.md,
  },
  llmBanner: {
    marginHorizontal: SPACING.lg,
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.md,
    padding: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.error,
    marginBottom: SPACING.sm,
  },
  llmBannerText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    textAlign: 'center',
  },
  conversationContainer: {
    flex: 1,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  messageList: {
    paddingVertical: SPACING.md,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  emptyEmoji: { fontSize: 48 },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  triggersSection: {
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: SPACING.sm,
  },
  triggersLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: SPACING.lg,
  },
  triggersRow: {
    paddingHorizontal: SPACING.lg,
    gap: SPACING.sm,
  },
});
