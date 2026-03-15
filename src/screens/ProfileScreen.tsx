import React, { useState } from 'react';
import {
  Alert,
  Image,
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
import { useBluetooth } from '../hooks/useBluetooth';
import { COLORS, RADIUS, SPACING } from '../components/theme';
import {
  DogPersonalityTrait,
  DogVoiceStyle,
  VOICE_STYLE_DESCRIPTIONS,
} from '../types';

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

const VOICE_OPTIONS: Array<{ id: DogVoiceStyle; emoji: string }> = [
  { id: 'bouncy_excited', emoji: '⚡' },
  { id: 'wise_calm', emoji: '🧘' },
  { id: 'silly_goofy', emoji: '🤡' },
  { id: 'sweet_loving', emoji: '💕' },
  { id: 'dramatic_diva', emoji: '💅' },
];

export default function ProfileScreen() {
  const { dogProfile, updateDogProfile, bleStatus, llmStatus, clearMessages } = useDogStore();
  const { startScan, disconnect } = useBluetooth();
  const [expanded, setExpanded] = useState<string | null>('identity');

  const isConnected = bleStatus === 'connected';

  const handlePickPhoto = () => {
    launchImageLibrary({ mediaType: 'photo', quality: 0.8 }, res => {
      if (res.assets?.[0]?.uri) {
        updateDogProfile({ photoUri: res.assets[0].uri! });
      }
    });
  };

  const toggleSection = (key: string) => {
    setExpanded(prev => (prev === key ? null : key));
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>My Dog</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Avatar */}
        <Pressable onPress={handlePickPhoto} style={styles.avatarSection}>
          {dogProfile.photoUri ? (
            <Image source={{ uri: dogProfile.photoUri }} style={styles.photo} />
          ) : (
            <View style={styles.photoPlaceholder}>
              <Text style={styles.photoEmoji}>🐾</Text>
            </View>
          )}
          <View style={styles.editBadge}>
            <Text style={styles.editBadgeText}>Edit photo</Text>
          </View>
          <Text style={styles.dogName}>{dogProfile.name || 'Your dog'}</Text>
          <Text style={styles.dogBreed}>{dogProfile.breed || 'Unknown breed'} · {dogProfile.age || '?'}</Text>
        </Pressable>

        {/* Collar status card */}
        <SectionCard>
          <View style={styles.collarRow}>
            <View>
              <Text style={styles.sectionTitle}>Merlin Collar</Text>
              <Text style={styles.sectionSubtitle}>
                {isConnected ? '✅ Connected' : '⚫ Not connected'}
              </Text>
            </View>
            <Pressable
              onPress={isConnected ? disconnect : startScan}
              style={[styles.collarBtn, isConnected && styles.collarBtnConnected]}>
              <Text style={styles.collarBtnText}>
                {bleStatus === 'scanning' ? 'Scanning…' : isConnected ? 'Disconnect' : 'Connect'}
              </Text>
            </Pressable>
          </View>
        </SectionCard>

        {/* AI model status */}
        <SectionCard>
          <View style={styles.collarRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>AI Model</Text>
              <Text style={styles.sectionSubtitle}>
                {llmStatus === 'ready'
                  ? '✅ Loaded and ready'
                  : llmStatus === 'loading'
                  ? '⏳ Loading...'
                  : '⚠️  Not loaded — drop a GGUF model into Documents/'}
              </Text>
            </View>
          </View>
        </SectionCard>

        {/* Identity section */}
        <AccordionSection
          title="Identity"
          expanded={expanded === 'identity'}
          onToggle={() => toggleSection('identity')}>
          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            style={styles.input}
            value={dogProfile.name}
            onChangeText={v => updateDogProfile({ name: v })}
            placeholder="Buddy, Luna, Max..."
            placeholderTextColor={COLORS.textMuted}
          />
          <Text style={styles.fieldLabel}>Breed</Text>
          <TextInput
            style={styles.input}
            value={dogProfile.breed}
            onChangeText={v => updateDogProfile({ breed: v })}
            placeholder="Golden Retriever, Mutt..."
            placeholderTextColor={COLORS.textMuted}
          />
          <Text style={styles.fieldLabel}>Age</Text>
          <TextInput
            style={styles.input}
            value={dogProfile.age}
            onChangeText={v => updateDogProfile({ age: v })}
            placeholder="2 years, 8 months..."
            placeholderTextColor={COLORS.textMuted}
          />
          <Text style={styles.fieldLabel}>Notes</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={dogProfile.additionalContext}
            onChangeText={v => updateDogProfile({ additionalContext: v })}
            placeholder="Rescue pup, scared of thunderstorms..."
            placeholderTextColor={COLORS.textMuted}
            multiline
          />
        </AccordionSection>

        {/* Personality section */}
        <AccordionSection
          title="Personality"
          expanded={expanded === 'personality'}
          onToggle={() => toggleSection('personality')}>
          <View style={styles.chipGrid}>
            {PERSONALITY_OPTIONS.map(opt => {
              const isSelected = dogProfile.personalityTraits.includes(opt.id);
              return (
                <Pressable
                  key={opt.id}
                  onPress={() => {
                    const current = dogProfile.personalityTraits;
                    updateDogProfile({
                      personalityTraits: isSelected
                        ? current.filter(t => t !== opt.id)
                        : [...current, opt.id],
                    });
                  }}
                  style={[styles.chip, isSelected && styles.chipSelected]}>
                  <Text style={styles.chipEmoji}>{opt.emoji}</Text>
                  <Text style={[styles.chipLabel, isSelected && styles.chipLabelSelected]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </AccordionSection>

        {/* Voice section */}
        <AccordionSection
          title="Voice Style"
          expanded={expanded === 'voice'}
          onToggle={() => toggleSection('voice')}>
          {VOICE_OPTIONS.map(opt => {
            const [title, desc] = VOICE_STYLE_DESCRIPTIONS[opt.id].split(' — ');
            const isSelected = dogProfile.voiceStyle === opt.id;
            return (
              <Pressable
                key={opt.id}
                onPress={() => updateDogProfile({ voiceStyle: opt.id })}
                style={[styles.voiceCard, isSelected && styles.voiceCardSelected]}>
                <Text style={styles.voiceEmoji}>{opt.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.voiceTitle, isSelected && styles.voiceTitleSelected]}>
                    {title}
                  </Text>
                  <Text style={styles.voiceDesc}>{desc}</Text>
                </View>
                {isSelected && <Text style={styles.checkmark}>✓</Text>}
              </Pressable>
            );
          })}
        </AccordionSection>

        {/* Danger zone */}
        <SectionCard>
          <Pressable
            onPress={() =>
              Alert.alert(
                'Clear conversation?',
                'This will delete all messages.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Clear', style: 'destructive', onPress: clearMessages },
                ],
              )
            }
            style={styles.dangerBtn}>
            <Text style={styles.dangerBtnText}>Clear conversation history</Text>
          </Pressable>
        </SectionCard>

      </ScrollView>
    </SafeAreaView>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function AccordionSection({
  title,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <Pressable onPress={onToggle} style={styles.accordionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.accordionChevron}>{expanded ? '▲' : '▼'}</Text>
      </Pressable>
      {expanded && <View style={styles.accordionBody}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  title: { fontSize: 24, fontWeight: '800', color: COLORS.text },
  scroll: { padding: SPACING.lg, gap: SPACING.md, paddingBottom: SPACING.xxl },
  avatarSection: { alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm },
  photo: { width: 100, height: 100, borderRadius: 50, borderWidth: 3, borderColor: COLORS.accent },
  photoPlaceholder: {
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: COLORS.surfaceElevated,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: COLORS.border,
  },
  photoEmoji: { fontSize: 44 },
  editBadge: {
    backgroundColor: COLORS.accentSoft, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm, paddingVertical: 3,
  },
  editBadgeText: { fontSize: 12, color: COLORS.accent, fontWeight: '600' },
  dogName: { fontSize: 22, fontWeight: '800', color: COLORS.text },
  dogBreed: { fontSize: 14, color: COLORS.textMuted },
  card: {
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.sm,
  },
  collarRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  collarBtn: {
    backgroundColor: COLORS.primary, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  collarBtnConnected: { backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: COLORS.border },
  collarBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  sectionSubtitle: { fontSize: 13, color: COLORS.textMuted, marginTop: 2 },
  accordionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  accordionChevron: { fontSize: 12, color: COLORS.textMuted },
  accordionBody: { gap: SPACING.sm, marginTop: SPACING.sm },
  fieldLabel: { fontSize: 11, fontWeight: '700', color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.8 },
  input: {
    backgroundColor: COLORS.surfaceElevated, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    fontSize: 15, color: COLORS.text, borderWidth: 1, borderColor: COLORS.border,
  },
  textArea: { height: 80, textAlignVertical: 'top' },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: COLORS.surfaceElevated, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderWidth: 1.5, borderColor: COLORS.border,
  },
  chipSelected: { borderColor: COLORS.accent, backgroundColor: COLORS.accentSoft },
  chipEmoji: { fontSize: 14 },
  chipLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  chipLabelSelected: { color: COLORS.accent },
  voiceCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: COLORS.surfaceElevated, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1.5, borderColor: COLORS.border,
  },
  voiceCardSelected: { borderColor: COLORS.accent, backgroundColor: COLORS.accentSoft },
  voiceEmoji: { fontSize: 24 },
  voiceTitle: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  voiceTitleSelected: { color: COLORS.accent },
  voiceDesc: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },
  checkmark: { fontSize: 16, color: COLORS.accent, fontWeight: '800' },
  dangerBtn: {
    padding: SPACING.md, borderRadius: RADIUS.md,
    backgroundColor: '#F8717120', alignItems: 'center',
  },
  dangerBtnText: { color: COLORS.error, fontSize: 14, fontWeight: '700' },
});
