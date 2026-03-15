// ─── BLE / Collar ────────────────────────────────────────────────────────────

export const COLLAR_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
export const CHAR_MEMS_DATA = '12345678-1234-5678-1234-56789abcdef1'; // notify: MPU-6050 packets
export const CHAR_AUDIO_TX = '12345678-1234-5678-1234-56789abcdef2'; // write: audio chunks → collar speaker
export const CHAR_TRIGGER = '12345678-1234-5678-1234-56789abcdef3'; // notify: collar → phone trigger events
export const CHAR_STATUS = '12345678-1234-5678-1234-56789abcdef4'; // read/notify: collar status

export const COLLAR_NAME_PREFIX = 'TalkingDog';

/** Trigger codes the collar sends to the phone (uint8) */
export enum CollarTrigger {
  WAG_START = 0x01,
  WAG_STOP = 0x02,
  BARK = 0x03,
  EXCITED = 0x04,
  CALM = 0x05,
  SLEEPING = 0x06,
  ALERT = 0x07,
}

/** Human-readable trigger descriptions for prompt construction */
export const TRIGGER_DESCRIPTIONS: Record<CollarTrigger, string> = {
  [CollarTrigger.WAG_START]: 'tail is wagging — feeling happy',
  [CollarTrigger.WAG_STOP]: 'stopped wagging — settling down',
  [CollarTrigger.BARK]: 'just barked at something',
  [CollarTrigger.EXCITED]: 'is super excited and bouncing around',
  [CollarTrigger.CALM]: 'is feeling calm and relaxed',
  [CollarTrigger.SLEEPING]: 'is getting sleepy',
  [CollarTrigger.ALERT]: 'heard something and is on alert',
};

/** MPU-6050 parsed data (12 bytes: 3×int16 accel + 3×int16 gyro) */
export interface MemsData {
  ax: number; // ±2g range, raw int16
  ay: number;
  az: number;
  gx: number; // ±250°/s range, raw int16
  gy: number;
  gz: number;
  timestamp: number; // ms since epoch when received
}

export type BleStatus =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

// ─── Audio ───────────────────────────────────────────────────────────────────

/** Header sent before streaming audio to collar (20 bytes total) */
export interface AudioStreamHeader {
  totalChunks: number;
  sampleRate: number; // 8000 Hz for BLE bandwidth
  encoding: 'mulaw' | 'pcm8';
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

export type LLMStatus = 'not_loaded' | 'loading' | 'ready' | 'generating' | 'error';

export interface ChatMessage {
  id: string;
  role: 'dog' | 'human';
  text: string;
  trigger?: CollarTrigger | ManualTrigger;
  timestamp: number;
}

/** Manual triggers initiated by the user tapping a button */
export enum ManualTrigger {
  TREATS = 'TREATS',
  PLAY = 'PLAY',
  WHATS_UP = 'WHATS_UP',
  GOOD_DOG = 'GOOD_DOG',
  WHATS_WRONG = 'WHATS_WRONG',
}

export const MANUAL_TRIGGER_PROMPTS: Record<ManualTrigger, string> = {
  [ManualTrigger.TREATS]: 'The human is asking you about your favorite treats',
  [ManualTrigger.PLAY]: 'The human is asking if you want to play',
  [ManualTrigger.WHATS_UP]: "The human is checking in and asking what's up with you",
  [ManualTrigger.GOOD_DOG]: 'The human just told you that you are a good dog',
  [ManualTrigger.WHATS_WRONG]: 'The human is worried and asking if something is wrong',
};

// ─── Dog Profile ──────────────────────────────────────────────────────────────

export type DogPersonalityTrait =
  | 'playful'
  | 'lazy'
  | 'food_obsessed'
  | 'anxious'
  | 'adventurous'
  | 'cuddly'
  | 'stubborn'
  | 'goofy'
  | 'loyal'
  | 'curious';

export type DogVoiceStyle =
  | 'bouncy_excited'
  | 'wise_calm'
  | 'silly_goofy'
  | 'sweet_loving'
  | 'dramatic_diva';

export const VOICE_STYLE_DESCRIPTIONS: Record<DogVoiceStyle, string> = {
  bouncy_excited: 'Bouncy & Excited — energetic, uses lots of exclamation points, easily distracted',
  wise_calm: 'Wise & Calm — thoughtful, measured responses, philosophical about dog life',
  silly_goofy: 'Silly & Goofy — makes puns, gets confused easily, very loveable',
  sweet_loving: 'Sweet & Loving — affectionate, sentimental, always supportive',
  dramatic_diva: 'Dramatic Diva — over-the-top reactions, everything is the BEST or WORST ever',
};

export interface DogProfile {
  name: string;
  breed: string;
  age: string; // "2 years" etc
  photoUri: string | null;
  avatarUri: string | null; // AI-generated illustrated avatar
  personalityTraits: DogPersonalityTrait[];
  voiceStyle: DogVoiceStyle;
  additionalContext: string; // free-form notes about the dog
}

export type OnboardingStep =
  | 'welcome'
  | 'name'
  | 'details'
  | 'personality'
  | 'voice'
  | 'photo'
  | 'collar'
  | 'done';

export type DogState = 'idle' | 'wagging' | 'excited' | 'sleeping' | 'alert' | 'speaking' | 'calm';
