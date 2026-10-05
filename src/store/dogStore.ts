import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AppSettings,
  BleStatus,
  ChatMessage,
  CollarTrigger,
  DEFAULT_APP_SETTINGS,
  DogProfile,
  DogState,
  LLMStatus,
  ManualTrigger,
  OnboardingStep,
  MemsData,
} from '../types';

const STORAGE_KEY = '@talking_dog_store';

interface DogStore {
  // ── Onboarding ─────────────────────────────────────────────
  hasCompletedOnboarding: boolean;
  currentOnboardingStep: OnboardingStep;
  setOnboardingStep: (step: OnboardingStep) => void;
  completeOnboarding: () => void;
  resetOnboarding: () => void;

  // ── Dog Profile ────────────────────────────────────────────
  dogProfile: DogProfile;
  updateDogProfile: (patch: Partial<DogProfile>) => void;

  // ── BLE / Collar ───────────────────────────────────────────
  bleStatus: BleStatus;
  connectedDeviceId: string | null;
  collarBattery: number | null;
  lastMemsData: MemsData | null;
  dogState: DogState;
  setBleStatus: (status: BleStatus) => void;
  setConnectedDevice: (deviceId: string | null) => void;
  setCollarBattery: (level: number) => void;
  setLastMemsData: (data: MemsData) => void;
  setDogState: (state: DogState) => void;

  // ── LLM ───────────────────────────────────────────────────
  llmStatus: LLMStatus;
  isGenerating: boolean;
  setLLMStatus: (status: LLMStatus) => void;
  setIsGenerating: (v: boolean) => void;

  // ── Conversation ───────────────────────────────────────────
  messages: ChatMessage[];
  addMessage: (msg: ChatMessage) => void;
  clearMessages: () => void;

  // ── Active trigger ─────────────────────────────────────────
  activeTrigger: CollarTrigger | ManualTrigger | null;
  setActiveTrigger: (trigger: CollarTrigger | ManualTrigger | null) => void;

  // ── Developer settings ─────────────────────────────────────
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;

  // ── Persistence ────────────────────────────────────────────
  hydrate: () => Promise<void>;
  persist: () => Promise<void>;
}

const DEFAULT_DOG_PROFILE: DogProfile = {
  name: '',
  breed: '',
  age: '',
  photoUri: null,
  avatarUri: null,
  personalityTraits: [],
  voiceStyle: 'bouncy_excited',
  additionalContext: '',
  ownerNames: '',
  bio: '',
  lifeStory: '',
  favoriteSnacks: '',
};

export const useDogStore = create<DogStore>((set, get) => ({
  // ── Onboarding ──────────────────────────────────────────────
  hasCompletedOnboarding: false,
  currentOnboardingStep: 'welcome',
  setOnboardingStep: step => set({ currentOnboardingStep: step }),
  completeOnboarding: () => {
    set({ hasCompletedOnboarding: true });
    get().persist();
  },
  resetOnboarding: () => {
    set({
      hasCompletedOnboarding: false,
      currentOnboardingStep: 'welcome',
      dogProfile: { ...DEFAULT_DOG_PROFILE },
      messages: [],
      settings: { ...DEFAULT_APP_SETTINGS },
      bleStatus: 'idle',
      connectedDeviceId: null,
      collarBattery: null,
      lastMemsData: null,
      dogState: 'idle',
      llmStatus: 'not_loaded',
      isGenerating: false,
      activeTrigger: null,
    });
    get().persist();
  },

  // ── Dog Profile ─────────────────────────────────────────────
  dogProfile: DEFAULT_DOG_PROFILE,
  updateDogProfile: patch => {
    set(s => ({ dogProfile: { ...s.dogProfile, ...patch } }));
    get().persist();
  },

  // ── BLE / Collar ────────────────────────────────────────────
  bleStatus: 'idle',
  connectedDeviceId: null,
  collarBattery: null,
  lastMemsData: null,
  dogState: 'idle',
  setBleStatus: status => set({ bleStatus: status }),
  setConnectedDevice: deviceId => set({ connectedDeviceId: deviceId }),
  setCollarBattery: level => set({ collarBattery: level }),
  setLastMemsData: data => set({ lastMemsData: data }),
  setDogState: state => set({ dogState: state }),

  // ── LLM ────────────────────────────────────────────────────
  llmStatus: 'not_loaded',
  isGenerating: false,
  setLLMStatus: status => set({ llmStatus: status }),
  setIsGenerating: v => set({ isGenerating: v }),

  // ── Conversation ────────────────────────────────────────────
  messages: [],
  addMessage: msg => set(s => ({ messages: [...s.messages.slice(-49), msg] })),
  clearMessages: () => set({ messages: [] }),

  // ── Active trigger ──────────────────────────────────────────
  activeTrigger: null,
  setActiveTrigger: trigger => set({ activeTrigger: trigger }),

  // ── Developer settings ──────────────────────────────────────
  settings: DEFAULT_APP_SETTINGS,
  updateSettings: patch => {
    set(s => ({ settings: { ...s.settings, ...patch } }));
    get().persist();
  },

  // ── Persistence ─────────────────────────────────────────────
  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<DogStore>;
      const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, ...(saved.settings ?? {}) };
      // The on-device provider is hidden from the UI for now. Coerce any
      // legacy persisted value back to 'backend' so users who toggled it
      // before this change aren't stuck on a dead path with no way to switch.
      if (settings.modelProvider !== 'backend') settings.modelProvider = 'backend';
      set({
        hasCompletedOnboarding: saved.hasCompletedOnboarding ?? false,
        dogProfile: { ...DEFAULT_DOG_PROFILE, ...(saved.dogProfile ?? {}) },
        messages: saved.messages ?? [],
        settings,
      });
    } catch {
      // ignore parse errors
    }
  },
  persist: async () => {
    const { hasCompletedOnboarding, dogProfile, messages, settings } = get();
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ hasCompletedOnboarding, dogProfile, messages, settings }),
    );
  },
}));
