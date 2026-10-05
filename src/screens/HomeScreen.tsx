import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDogStore } from '../store/dogStore';
import { useBluetooth } from '../hooks/useBluetooth';
import { useLLM } from '../hooks/useLLM';
import DogAvatar from '../components/DogAvatar';
import ConversationBubble from '../components/ConversationBubble';
import { COLORS, HEADING_FONT_FAMILY, RADIUS, SPACING } from '../components/theme';
import { CollarTrigger, ManualTrigger } from '../types';
import { cameraService } from '../services/CameraService';
import { LiveVideoView } from '../components/LiveVideoView';

const QUICK_TRIGGERS: { trigger: ManualTrigger; emoji: string; label: string; humanText: string }[] = [
  { trigger: ManualTrigger.TREATS, emoji: '🍖', label: 'Treats', humanText: 'Treats! 🍖' },
  { trigger: ManualTrigger.PLAY, emoji: '🎾', label: 'Play?', humanText: 'Want to play? 🎾' },
  { trigger: ManualTrigger.WHATS_UP, emoji: '🐾', label: "What's up?", humanText: "What's up? 🐾" },
];

export default function HomeScreen() {
  const {
    dogProfile,
    dogState,
    bleStatus,
    messages,
    isGenerating,
    llmStatus,
    settings,
    setDogState,
    addMessage,
    updateSettings,
  } = useDogStore();
  const liveVideo = settings.liveVideoEnabled;

  const { generateResponse, generateResponseToText, startVoice, stopVoice } = useLLM();
  const flatListRef = useRef<FlatList>(null);
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  // Base64-encoded JPEG attached to the next outgoing message (no data: prefix).
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null);

  // ── Keyboard-aware avatar shrink ──────────────────────────────────────────
  const avatarHeight = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => {
      Animated.timing(avatarHeight, { toValue: 0, duration: 250, useNativeDriver: false }).start();
    });
    const hide = Keyboard.addListener('keyboardWillHide', () => {
      Animated.timing(avatarHeight, { toValue: 1, duration: 250, useNativeDriver: false }).start();
    });
    return () => { show.remove(); hide.remove(); };
  }, [avatarHeight]);

  const avatarSectionStyle = {
    overflow: 'hidden' as const,
    height: avatarHeight.interpolate({ inputRange: [0, 1], outputRange: [0, 200] }),
    opacity: avatarHeight,
  };

  // ── Collar trigger handler ────────────────────────────────────────────────

  const handleCollarTrigger = useCallback(
    async (trigger: CollarTrigger) => {
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

      if (!shouldSpeak || isGenerating || llmStatus !== 'ready') return;

      const currentSettings = useDogStore.getState().settings;
      let imageBase64: string | undefined;

      if (currentSettings.cameraEnabled) {
        if (currentSettings.cameraSource === 'collar') {
          imageBase64 = cameraService.getLastCollarFrame() ?? undefined;
        } else {
          // Phone camera: open the native camera UI to snap a quick photo.
          const captured = await cameraService.captureFromPhone();
          imageBase64 = captured ?? undefined;
        }
      }

      generateResponse(trigger, imageBase64);
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

  const handleManualTrigger = (trigger: ManualTrigger, humanText: string) => {
    if (isGenerating || llmStatus !== 'ready') return;
    addMessage({ id: `human_${Date.now()}`, role: 'human', text: humanText, timestamp: Date.now() });
    const photo = pendingPhoto ?? undefined;
    setPendingPhoto(null);
    generateResponse(trigger, photo);
  };

  const handleSendText = () => {
    const text = inputText.trim();
    if ((!text && !pendingPhoto) || isGenerating || llmStatus !== 'ready') return;
    setInputText('');
    const photo = pendingPhoto ?? undefined;
    setPendingPhoto(null);
    if (text) {
      generateResponseToText(text, photo);
    } else {
      // Photo-only: use a neutral trigger so the dog reacts to what it sees.
      addMessage({ id: `human_${Date.now()}`, role: 'human', text: '📷', timestamp: Date.now() });
      generateResponse(ManualTrigger.WHATS_UP, photo);
    }
  };

  const handleCameraAttach = async () => {
    if (isGenerating) return;
    const currentSettings = useDogStore.getState().settings;
    if (currentSettings.cameraSource === 'collar') {
      const frame = cameraService.getLastCollarFrame();
      if (frame) setPendingPhoto(frame);
    } else {
      const b64 = await cameraService.captureFromPhone();
      if (b64) setPendingPhoto(b64);
    }
  };

  const handleVoicePressIn = async () => {
    if (isGenerating || llmStatus !== 'ready') return;
    const ok = await startVoice();
    if (ok) setIsRecording(true);
  };

  const handleVoicePressOut = () => {
    // Always call stopVoice even when isRecording is still false. During the
    // first-press sendrecv upgrade (reconnectWithVoice), the button remains in
    // the "not recording" visual state for ~1s. If the user releases early,
    // the early-return guard would skip stopVoice, leaving pressActiveRef=true
    // so the upgrade continues and attaches the mic even though the press is
    // over — getting voiceState stuck at 'recording' and breaking every
    // subsequent press. stopVoice resets pressActiveRef and cancels any
    // in-flight capture safely.
    setIsRecording(false);
    stopVoice();
  };

  const isConnected = bleStatus === 'connected';
  const hasText = inputText.trim().length > 0;
  // Voice input is only wired for the realtime backend path. The on-device
  // LLM has no audio-in plumbing, so we just hide the mic in that mode.
  const showMicButton = !hasText && !pendingPhoto && settings.modelProvider === 'backend';
  const sendDisabled = (!hasText && !pendingPhoto) || isGenerating || llmStatus !== 'ready';
  const micDisabled = isGenerating || llmStatus !== 'ready';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardAvoid}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>
            {dogProfile.name ? `${dogProfile.name} is here!` : 'Your dog is here!'}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => updateSettings({ liveVideoEnabled: !liveVideo })}
            hitSlop={8}
            style={({ pressed }) => [
              styles.videoToggle,
              liveVideo && styles.videoToggleActive,
              pressed && styles.pillPressed,
            ]}>
            <Text style={styles.videoToggleText}>{liveVideo ? '📹 Live' : '📹'}</Text>
          </Pressable>
          <CollarStatusBadge status={bleStatus} onConnect={startScan} />
        </View>
      </View>

      {liveVideo ? (
        /* Live video: the preview fills the screen; the last few messages
           float over the bottom of it. Frames from the last 5 s ride along
           with every generation. */
        <LiveVideoView
          position={settings.liveVideoCamera}
          onFlip={() =>
            updateSettings({ liveVideoCamera: settings.liveVideoCamera === 'back' ? 'front' : 'back' })
          }
          onClose={() => updateSettings({ liveVideoEnabled: false })}>
          <View style={styles.videoOverlay} pointerEvents="box-none">
            {llmStatus !== 'ready' && <LLMStatusBanner status={llmStatus} />}
            {messages.slice(-3).map(m => (
              <View key={m.id} style={styles.videoBubble}>
                <ConversationBubble message={m} dogName={dogProfile.name} />
              </View>
            ))}
          </View>
        </LiveVideoView>
      ) : (
        <>
      {/* Dog Avatar */}
      <Animated.View style={[styles.avatarSection, avatarSectionStyle]}>
        <DogAvatar
          state={dogState}
          photoUri={dogProfile.photoUri}
          avatarUri={dogProfile.avatarUri}
          size={140}
        />
      </Animated.View>

      {/* AI status (only shown when not ready) */}
      {llmStatus !== 'ready' && (
        <LLMStatusBanner status={llmStatus} />
      )}
        </>
      )}

      {/* Conversation */}
      <View style={[styles.conversationContainer, liveVideo && styles.conversationHidden]}>
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

      {/* Input area */}
      <View style={styles.inputArea}>
        {/* Quick-trigger pills */}
        <View style={styles.pillsRow}>
          {QUICK_TRIGGERS.map(({ trigger, emoji, label, humanText }) => (
            <Pressable
              key={trigger}
              onPress={() => handleManualTrigger(trigger, humanText)}
              disabled={isGenerating || llmStatus !== 'ready'}
              style={({ pressed }) => [
                styles.pill,
                (isGenerating || llmStatus !== 'ready') && styles.pillDisabled,
                pressed && styles.pillPressed,
              ]}>
              <Text style={styles.pillText}>{emoji} {label}</Text>
            </Pressable>
          ))}
        </View>

        {/* Pending photo preview */}
        {pendingPhoto && (
          <View style={styles.photoPreviewRow}>
            <Image
              source={{ uri: `data:image/jpeg;base64,${pendingPhoto}` }}
              style={styles.photoPreview}
            />
            <Pressable onPress={() => setPendingPhoto(null)} style={styles.photoRemoveBtn} hitSlop={8}>
              <Text style={styles.photoRemoveBtnText}>✕</Text>
            </Pressable>
            <Text style={styles.photoPreviewLabel}>📷 Photo attached</Text>
          </View>
        )}

        {/* Text input + send/mic */}
        <View style={styles.textRow}>
          {settings.cameraEnabled && (
            <Pressable
              onPress={handleCameraAttach}
              disabled={isGenerating}
              hitSlop={8}
              style={({ pressed }) => [
                styles.cameraBtn,
                pendingPhoto && styles.cameraBtnActive,
                isGenerating && styles.cameraBtnDisabled,
                pressed && styles.cameraBtnPressed,
              ]}>
              <Text style={styles.cameraBtnText}>📷</Text>
            </Pressable>
          )}
          <TextInput
            style={styles.textInput}
            value={inputText}
            onChangeText={setInputText}
            placeholder={isRecording ? 'Listening…' : 'Say something to your dog…'}
            placeholderTextColor={COLORS.textMuted}
            returnKeyType="send"
            onSubmitEditing={handleSendText}
            editable={!isGenerating && !isRecording && llmStatus === 'ready'}
            multiline={false}
          />
          {showMicButton ? (
            <Pressable
              onPressIn={handleVoicePressIn}
              onPressOut={handleVoicePressOut}
              disabled={micDisabled}
              hitSlop={8}
              style={({ pressed }) => [
                styles.sendBtn,
                micDisabled && styles.sendBtnDisabled,
                (pressed || isRecording) && styles.micBtnActive,
              ]}>
              <MicGlyph active={isRecording} disabled={micDisabled} />
            </Pressable>
          ) : (
            <Pressable
              onPress={handleSendText}
              disabled={sendDisabled}
              style={({ pressed }) => [
                styles.sendBtn,
                sendDisabled && styles.sendBtnDisabled,
                pressed && styles.sendBtnPressed,
              ]}>
              <Text style={styles.sendBtnText}>↑</Text>
            </Pressable>
          )}
        </View>
      </View>
      </KeyboardAvoidingView>
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
          AI is offline. Check your connection or pick a model in Settings.
        </Text>
      </View>
    );
  }
  if (status === 'loading') {
    return (
      <View style={[styles.llmBanner, { borderColor: COLORS.warning }]}>
        <Text style={styles.llmBannerText}>Warming up the AI…</Text>
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View style={[styles.llmBanner, { borderColor: COLORS.error }]}>
        <Text style={styles.llmBannerText}>AI hit an error. Pull down or try again.</Text>
      </View>
    );
  }
  return null;
}

/**
 * Minimal microphone glyph drawn with Views so it sits cleanly inside the
 * round send button without pulling in an icon library. Tints invert when
 * the button is active (recording) or disabled to match the parent state.
 */
function MicGlyph({ active, disabled }: { active: boolean; disabled: boolean }) {
  const tint = disabled
    ? COLORS.textMuted
    : active
    ? COLORS.background
    : COLORS.background;
  return (
    <View style={styles.micGlyph}>
      <View style={[styles.micCapsule, { backgroundColor: tint }]} />
      <View style={[styles.micArm, { borderColor: tint }]} />
      <View style={[styles.micStand, { backgroundColor: tint }]} />
    </View>
  );
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
  keyboardAvoid: {
    flex: 1,
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
    fontSize: 24,
    fontFamily: HEADING_FONT_FAMILY,
    fontWeight: '700',
    color: COLORS.text,
    letterSpacing: -0.3,
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
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    marginBottom: SPACING.sm,
  },
  llmBannerText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
  conversationContainer: {
    flex: 1,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  conversationHidden: {
    flex: 0,
    height: 0,
    overflow: 'hidden',
    borderTopWidth: 0,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  videoToggle: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primarySoft,
  },
  videoToggleActive: {
    backgroundColor: '#ff3b30',
  },
  videoToggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.text,
  },
  videoOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: SPACING.sm,
    paddingBottom: SPACING.sm,
    gap: 4,
  },
  videoBubble: {
    opacity: 0.95,
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
  inputArea: {
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.md,
    gap: SPACING.sm,
  },
  pillsRow: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  pillDisabled: { opacity: 0.4 },
  pillPressed: { backgroundColor: COLORS.primarySoft },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  textRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  textInput: {
    flex: 1,
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    fontSize: 15,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: COLORS.border },
  sendBtnPressed: { opacity: 0.75 },
  sendBtnText: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.background,
  },
  micBtnActive: {
    backgroundColor: COLORS.error,
  },
  cameraBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraBtnActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  cameraBtnDisabled: { opacity: 0.4 },
  cameraBtnPressed: { opacity: 0.7 },
  cameraBtnText: { fontSize: 18 },
  photoPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.xs,
  },
  photoPreview: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  photoRemoveBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoRemoveBtnText: { fontSize: 10, color: COLORS.textMuted, fontWeight: '700' },
  photoPreviewLabel: { fontSize: 12, color: COLORS.textSecondary, fontWeight: '600' },
  micGlyph: {
    width: 18,
    height: 20,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  micCapsule: {
    width: 8,
    height: 11,
    borderRadius: 4,
    marginTop: 1,
  },
  micArm: {
    position: 'absolute',
    bottom: 4,
    width: 14,
    height: 7,
    borderWidth: 1.5,
    borderTopWidth: 0,
    borderRadius: 7,
    backgroundColor: 'transparent',
  },
  micStand: {
    position: 'absolute',
    bottom: 0,
    width: 8,
    height: 1.5,
    borderRadius: 1,
  },
});
