import React, { useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { launchImageLibrary } from 'react-native-image-picker';
import { useDogStore } from '../store/dogStore';
import { COLORS, RADIUS, SPACING } from '../components/theme';
import {
  DogPersonalityTrait,
  DogVoiceStyle,
  VOICE_STYLE_DESCRIPTIONS,
} from '../types';
import { useBluetooth } from '../hooks/useBluetooth';

const { width: SCREEN_W } = Dimensions.get('window');

const STEPS = ['welcome', 'collar_check', 'name', 'details', 'personality', 'voice', 'photo', 'done'];
const TOTAL_STEPS = STEPS.length;

const PERSONALITY_OPTIONS: { id: DogPersonalityTrait; label: string; emoji: string }[] = [
  { id: 'playful', label: 'Playful', emoji: '🎾' },
  { id: 'lazy', label: 'Lazy', emoji: '🛋️' },
  { id: 'food_obsessed', label: 'Food-obsessed', emoji: '🍖' },
  { id: 'anxious', label: 'A little anxious', emoji: '😰' },
  { id: 'adventurous', label: 'Adventurous', emoji: '🌍' },
  { id: 'cuddly', label: 'Cuddly', emoji: '🤗' },
  { id: 'stubborn', label: 'Stubborn', emoji: '🐏' },
  { id: 'goofy', label: 'Goofy', emoji: '🤪' },
  { id: 'loyal', label: 'Fiercely loyal', emoji: '🫂' },
  { id: 'curious', label: 'Curious', emoji: '🔍' },
];

const VOICE_OPTIONS: { id: DogVoiceStyle; emoji: string }[] = [
  { id: 'bouncy_excited', emoji: '⚡' },
  { id: 'wise_calm', emoji: '🧘' },
  { id: 'silly_goofy', emoji: '🤡' },
  { id: 'sweet_loving', emoji: '💕' },
  { id: 'dramatic_diva', emoji: '💅' },
];

export default function OnboardingScreen() {
  const [stepIndex, setStepIndex] = useState(0);
  const [hasCollar, setHasCollar] = useState<boolean | null>(null);
  const slideAnim = useRef(new Animated.Value(0)).current;

  const { dogProfile, updateDogProfile, completeOnboarding, setBleStatus } = useDogStore();
  const { startScan } = useBluetooth();
  const bleStatus = useDogStore(s => s.bleStatus);

  const goNext = () => {
    const nextIndex = Math.min(stepIndex + 1, TOTAL_STEPS - 1);
    Animated.sequence([
      Animated.timing(slideAnim, { toValue: -SCREEN_W, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      setStepIndex(nextIndex);
      slideAnim.setValue(SCREEN_W);
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, speed: 14 }).start();
    });
  };

  const goPrev = () => {
    if (stepIndex === 0) return;
    const prevIndex = stepIndex - 1;
    Animated.sequence([
      Animated.timing(slideAnim, { toValue: SCREEN_W, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      setStepIndex(prevIndex);
      slideAnim.setValue(-SCREEN_W);
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, speed: 14 }).start();
    });
  };

  const finish = () => {
    completeOnboarding();
  };

  const step = STEPS[stepIndex];
  const progress = (stepIndex + 1) / TOTAL_STEPS;

  return (
    <SafeAreaView style={styles.container}>
      {/* Progress bar */}
      <View style={styles.progressBar}>
        <Animated.View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>

      {/* Back button */}
      {stepIndex > 0 && stepIndex < TOTAL_STEPS - 1 && (
        <Pressable onPress={goPrev} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
      )}

      <Animated.View style={[styles.stepContainer, { transform: [{ translateX: slideAnim }] }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

            {step === 'welcome' && (
              <WelcomeStep onNext={() => { setHasCollar(null); goNext(); }} />
            )}
            {step === 'collar_check' && (
              <CollarCheckStep
                hasCollar={hasCollar}
                onSetHasCollar={v => setHasCollar(v)}
                onNext={goNext}
              />
            )}
            {step === 'name' && (
              <NameStep
                name={dogProfile.name}
                onChangeName={name => updateDogProfile({ name })}
                onNext={goNext}
              />
            )}
            {step === 'details' && (
              <DetailsStep
                breed={dogProfile.breed}
                age={dogProfile.age}
                additionalContext={dogProfile.additionalContext}
                onUpdate={patch => updateDogProfile(patch)}
                onNext={goNext}
              />
            )}
            {step === 'personality' && (
              <PersonalityStep
                selected={dogProfile.personalityTraits}
                onToggle={trait => {
                  const current = dogProfile.personalityTraits;
                  const updated = current.includes(trait)
                    ? current.filter(t => t !== trait)
                    : [...current, trait];
                  updateDogProfile({ personalityTraits: updated });
                }}
                onNext={goNext}
              />
            )}
            {step === 'voice' && (
              <VoiceStep
                selected={dogProfile.voiceStyle}
                onSelect={v => updateDogProfile({ voiceStyle: v })}
                onNext={goNext}
              />
            )}
            {step === 'photo' && (
              <PhotoStep
                photoUri={dogProfile.photoUri}
                onPickPhoto={() =>
                  launchImageLibrary({ mediaType: 'photo', quality: 0.8 }, res => {
                    if (res.assets?.[0]?.uri) {
                      updateDogProfile({ photoUri: res.assets[0].uri! });
                    }
                  })
                }
                onNext={goNext}
              />
            )}
            {step === 'done' && (
              <DoneStep
                dogName={dogProfile.name}
                hasCollar={hasCollar}
                bleStatus={bleStatus}
                onScan={startScan}
                onFinish={finish}
              />
            )}

          </ScrollView>
        </KeyboardAvoidingView>
      </Animated.View>
    </SafeAreaView>
  );
}

// ── Step sub-components ────────────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.bigEmoji}>🐾</Text>
      <Text style={styles.heading}>Meet Merlin.</Text>
      <Text style={styles.subheading}>
        The collar that lets your dog speak.
      </Text>
      <Text style={styles.body}>
        A tiny speaker + motion sensor turns your dog's wiggles, barks, and naps into their very own voice — powered by AI running entirely on your phone.
      </Text>
      <PrimaryButton label="Let's go →" onPress={onNext} />
      <Pressable onPress={() => Linking.openURL('https://thanksmerlin.com')}>
        <Text style={styles.link}>Learn more at thanksmerlin.com</Text>
      </Pressable>
    </View>
  );
}

function CollarCheckStep({
  hasCollar,
  onSetHasCollar,
  onNext,
}: {
  hasCollar: boolean | null;
  onSetHasCollar: (v: boolean) => void;
  onNext: () => void;
}) {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.bigEmoji}>📦</Text>
      <Text style={styles.heading}>Do you have your Merlin collar?</Text>
      <Text style={styles.body}>
        You can still set up your dog's profile and explore AI features while you wait for your collar to arrive.
      </Text>

      <View style={styles.choiceRow}>
        <ChoiceCard
          emoji="✅"
          label="Yes, I have it!"
          selected={hasCollar === true}
          onPress={() => onSetHasCollar(true)}
        />
        <ChoiceCard
          emoji="🛒"
          label="Not yet"
          selected={hasCollar === false}
          onPress={() => onSetHasCollar(false)}
        />
      </View>

      {hasCollar === false && (
        <View style={styles.shopCard}>
          <Text style={styles.shopText}>
            Order yours at thanksmerlin.com — ships in 1–3 days 🚀
          </Text>
          <Pressable onPress={() => Linking.openURL('https://thanksmerlin.com')}>
            <Text style={styles.link}>Shop now →</Text>
          </Pressable>
        </View>
      )}

      {hasCollar !== null && (
        <PrimaryButton label="Continue →" onPress={onNext} />
      )}
    </View>
  );
}

function NameStep({
  name,
  onChangeName,
  onNext,
}: {
  name: string;
  onChangeName: (n: string) => void;
  onNext: () => void;
}) {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.bigEmoji}>🐶</Text>
      <Text style={styles.heading}>What's your dog's name?</Text>
      <TextInput
        style={styles.textInput}
        value={name}
        onChangeText={onChangeName}
        placeholder="Buddy, Luna, Max..."
        placeholderTextColor={COLORS.textMuted}
        autoCapitalize="words"
        returnKeyType="done"
        autoFocus
      />
      <PrimaryButton label="That's their name! →" onPress={onNext} disabled={!name.trim()} />
    </View>
  );
}

function DetailsStep({
  breed,
  age,
  additionalContext,
  onUpdate,
  onNext,
}: {
  breed: string;
  age: string;
  additionalContext: string;
  onUpdate: (patch: { breed?: string; age?: string; additionalContext?: string }) => void;
  onNext: () => void;
}) {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.bigEmoji}>📋</Text>
      <Text style={styles.heading}>Tell us about them</Text>

      <Text style={styles.inputLabel}>Breed</Text>
      <TextInput
        style={styles.textInput}
        value={breed}
        onChangeText={v => onUpdate({ breed: v })}
        placeholder="Golden Retriever, Mutt, etc."
        placeholderTextColor={COLORS.textMuted}
      />

      <Text style={styles.inputLabel}>Age</Text>
      <TextInput
        style={styles.textInput}
        value={age}
        onChangeText={v => onUpdate({ age: v })}
        placeholder="2 years, 8 months..."
        placeholderTextColor={COLORS.textMuted}
      />

      <Text style={styles.inputLabel}>Anything else? (optional)</Text>
      <TextInput
        style={[styles.textInput, styles.textArea]}
        value={additionalContext}
        onChangeText={v => onUpdate({ additionalContext: v })}
        placeholder="Rescue pup, scared of thunderstorms, obsessed with the mail carrier..."
        placeholderTextColor={COLORS.textMuted}
        multiline
        numberOfLines={3}
      />

      <PrimaryButton label="Next →" onPress={onNext} />
    </View>
  );
}

function PersonalityStep({
  selected,
  onToggle,
  onNext,
}: {
  selected: DogPersonalityTrait[];
  onToggle: (t: DogPersonalityTrait) => void;
  onNext: () => void;
}) {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.bigEmoji}>✨</Text>
      <Text style={styles.heading}>What's their vibe?</Text>
      <Text style={styles.body}>Pick all that apply.</Text>

      <View style={styles.chipGrid}>
        {PERSONALITY_OPTIONS.map(opt => (
          <Pressable
            key={opt.id}
            onPress={() => onToggle(opt.id)}
            style={[styles.chip, selected.includes(opt.id) && styles.chipSelected]}>
            <Text style={styles.chipEmoji}>{opt.emoji}</Text>
            <Text style={[styles.chipLabel, selected.includes(opt.id) && styles.chipLabelSelected]}>
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <PrimaryButton label="That's them! →" onPress={onNext} disabled={selected.length === 0} />
    </View>
  );
}

function VoiceStep({
  selected,
  onSelect,
  onNext,
}: {
  selected: DogVoiceStyle;
  onSelect: (v: DogVoiceStyle) => void;
  onNext: () => void;
}) {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.bigEmoji}>🎙️</Text>
      <Text style={styles.heading}>Choose their voice style</Text>

      {VOICE_OPTIONS.map(opt => {
        const [title, desc] = VOICE_STYLE_DESCRIPTIONS[opt.id].split(' — ');
        return (
          <Pressable
            key={opt.id}
            onPress={() => onSelect(opt.id)}
            style={[styles.voiceCard, selected === opt.id && styles.voiceCardSelected]}>
            <Text style={styles.voiceEmoji}>{opt.emoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.voiceTitle, selected === opt.id && styles.voiceTitleSelected]}>
                {title}
              </Text>
              <Text style={styles.voiceDesc}>{desc}</Text>
            </View>
            {selected === opt.id && <Text style={styles.checkmark}>✓</Text>}
          </Pressable>
        );
      })}

      <PrimaryButton label="Perfect! →" onPress={onNext} />
    </View>
  );
}

function PhotoStep({
  photoUri,
  onPickPhoto,
  onNext,
}: {
  photoUri: string | null;
  onPickPhoto: () => void;
  onNext: () => void;
}) {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.bigEmoji}>📸</Text>
      <Text style={styles.heading}>Add a photo</Text>
      <Text style={styles.body}>
        We'll use this as their avatar — and soon, to create a custom illustrated portrait with AI.
      </Text>

      <Pressable onPress={onPickPhoto} style={styles.photoPickerBox}>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={styles.photoPreview} />
        ) : (
          <>
            <Text style={styles.photoPickerIcon}>🐾</Text>
            <Text style={styles.photoPickerLabel}>Tap to choose a photo</Text>
          </>
        )}
      </Pressable>

      <PrimaryButton label={photoUri ? 'Love it! →' : 'Skip for now →'} onPress={onNext} />
    </View>
  );
}

function DoneStep({
  dogName,
  hasCollar,
  bleStatus,
  onScan,
  onFinish,
}: {
  dogName: string;
  hasCollar: boolean | null;
  bleStatus: string;
  onScan: () => void;
  onFinish: () => void;
}) {
  const isConnected = bleStatus === 'connected';
  const isScanning = bleStatus === 'scanning' || bleStatus === 'connecting';

  return (
    <View style={styles.stepContent}>
      <Text style={styles.bigEmoji}>{isConnected ? '🎉' : '🐾'}</Text>
      <Text style={styles.heading}>
        {isConnected ? 'You\'re all set!' : `${dogName || 'Your dog'} is ready!`}
      </Text>

      {hasCollar && !isConnected && (
        <>
          <Text style={styles.body}>
            Make sure your Merlin collar is powered on, then tap below to pair it.
          </Text>
          <Pressable
            onPress={onScan}
            disabled={isScanning}
            style={[styles.bleButton, isScanning && styles.bleButtonScanning]}>
            <Text style={styles.bleButtonText}>
              {isScanning ? '🔍 Searching...' : '📡 Connect Collar'}
            </Text>
          </Pressable>

          {bleStatus === 'error' && (
            <Text style={styles.errorText}>Couldn't find the collar. Make sure it's on and nearby.</Text>
          )}
        </>
      )}

      {!hasCollar && (
        <Text style={styles.body}>
          Your collar is on its way! In the meantime, you can explore all the AI features and set up {dogName || 'your dog'}'s profile.
        </Text>
      )}

      <PrimaryButton
        label={isConnected ? 'Start talking! 🐾' : 'Go to the app →'}
        onPress={onFinish}
      />
    </View>
  );
}

// ── Reusable UI primitives ─────────────────────────────────────────────────────

function PrimaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.primaryBtn, disabled && styles.primaryBtnDisabled]}>
      <Text style={styles.primaryBtnText}>{label}</Text>
    </Pressable>
  );
}

function ChoiceCard({
  emoji,
  label,
  selected,
  onPress,
}: {
  emoji: string;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.choiceCard, selected && styles.choiceCardSelected]}>
      <Text style={styles.choiceEmoji}>{emoji}</Text>
      <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  progressBar: {
    height: 3,
    backgroundColor: COLORS.border,
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.sm,
    borderRadius: RADIUS.full,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.accent,
    borderRadius: RADIUS.full,
  },
  backBtn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    alignSelf: 'flex-start',
  },
  backBtnText: {
    color: COLORS.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  stepContainer: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    paddingBottom: SPACING.xxl,
  },
  stepContent: {
    flex: 1,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.xl,
    gap: SPACING.md,
    alignItems: 'center',
  },
  bigEmoji: {
    fontSize: 64,
    textAlign: 'center',
    marginBottom: SPACING.sm,
  },
  heading: {
    fontSize: 28,
    fontWeight: '800',
    color: COLORS.text,
    textAlign: 'center',
  },
  subheading: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  body: {
    fontSize: 16,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
  },
  link: {
    color: COLORS.accent,
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  primaryBtn: {
    width: '100%',
    backgroundColor: COLORS.accent,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  primaryBtnDisabled: {
    opacity: 0.4,
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  textInput: {
    width: '100%',
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    fontSize: 16,
    color: COLORS.text,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  textArea: {
    height: 90,
    textAlignVertical: 'top',
  },
  inputLabel: {
    alignSelf: 'flex-start',
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: -SPACING.sm,
  },
  chipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    justifyContent: 'center',
    width: '100%',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  chipSelected: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  chipEmoji: { fontSize: 16 },
  chipLabel: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  chipLabelSelected: { color: COLORS.accent },
  voiceCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  voiceCardSelected: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  voiceEmoji: { fontSize: 28 },
  voiceTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  voiceTitleSelected: { color: COLORS.accent },
  voiceDesc: { fontSize: 12, color: COLORS.textMuted, marginTop: 2, lineHeight: 16 },
  checkmark: { fontSize: 18, color: COLORS.accent, fontWeight: '800' },
  photoPickerBox: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 2,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photoPreview: {
    width: '100%',
    height: '100%',
    borderRadius: 100,
  },
  photoPickerIcon: { fontSize: 48 },
  photoPickerLabel: { color: COLORS.textMuted, fontSize: 13, marginTop: 8 },
  choiceRow: {
    flexDirection: 'row',
    gap: SPACING.md,
    width: '100%',
  },
  choiceCard: {
    flex: 1,
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.lg,
    paddingVertical: SPACING.lg,
    alignItems: 'center',
    gap: SPACING.sm,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  choiceCardSelected: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  choiceEmoji: { fontSize: 32 },
  choiceLabel: { fontSize: 14, fontWeight: '700', color: COLORS.textSecondary },
  choiceLabelSelected: { color: COLORS.accent },
  shopCard: {
    width: '100%',
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    gap: SPACING.xs,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  shopText: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' },
  bleButton: {
    width: '100%',
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.full,
    alignItems: 'center',
  },
  bleButtonScanning: { opacity: 0.7 },
  bleButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  errorText: { color: COLORS.error, fontSize: 13, textAlign: 'center' },
});
