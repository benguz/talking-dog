import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BleStatus,
  ChatMessage,
  CollarTrigger,
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

  // ── Persistence ─────────────────────────────────────────────
  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<DogStore>;
      set({
        hasCompletedOnboarding: saved.hasCompletedOnboarding ?? false,
        dogProfile: { ...DEFAULT_DOG_PROFILE, ...(saved.dogProfile ?? {}) },
        messages: saved.messages ?? [],
      });
    } catch {
      // ignore parse errors
    }
  },
  persist: async () => {
    const { hasCompletedOnboarding, dogProfile, messages } = get();
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ hasCompletedOnboarding, dogProfile, messages }),
    );
  },
}));
