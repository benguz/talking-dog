export interface Env {
  AI: Ai;
  APP_ATTEST_KV: KVNamespace;
  OPENAI_API_KEY: string;
  APPLE_TEAM_ID: string;
  APPLE_BUNDLE_ID: string;
  /** Wrangler var — chat model for /v1/generate (default gpt-6-luna) */
  MODEL_NAME?: string;
  /** Wrangler var — reasoning effort override ('none' | 'minimal' | 'low' | …) */
  REASONING_EFFORT?: string;
  /** Optional overrides for the collar audio path */
  TRANSCRIBE_MODEL?: string;
  TTS_MODEL?: string;
  /** 'elevenlabs' | 'openai'; defaults to elevenlabs when ELEVENLABS_API_KEY is set */
  TTS_PROVIDER?: string;
  /** Secret: wrangler secret put ELEVENLABS_API_KEY */
  ELEVENLABS_API_KEY?: string;
  /** Voice by library name (default "Will") or explicit id */
  ELEVENLABS_VOICE?: string;
  ELEVENLABS_VOICE_ID?: string;
  /** default eleven_v4_turbo */
  ELEVENLABS_MODEL?: string;
  /** 0..1, lower = more expressive (default 0.35) */
  ELEVENLABS_STABILITY?: string;
  /** Set to "true" in production to hard-reject unatested requests */
  REQUIRE_ATTEST?: string;
}
