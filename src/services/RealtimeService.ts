/**
 * RealtimeService — manages a WebRTC session with OpenAI's Realtime API.
 *
 * Architecture:
 *   1. Fetch a short-lived ephemeral token from our Cloudflare Worker backend.
 *   2. Create a WebRTC peer connection with a sendrecv audio transceiver. The
 *      remote half plays the dog's voice; the local sender stays empty until
 *      the user holds the mic button — at which point we lazily capture the
 *      mic via getUserMedia and attach it via replaceTrack (no renegotiation).
 *   3. POST the SDP offer + ephemeral token directly to OpenAI.
 *   4. After the data channel opens, configure the session with the dog persona.
 *   5. For each trigger/message, send conversation items via the data channel
 *      and stream the transcript back as the model speaks.
 *
 * Audio from OpenAI plays automatically via the WebRTC remote audio track.
 * Text streaming comes from `response.audio_transcript.delta` data channel events.
 *
 * Voice input flow:
 *   • startVoiceInput()    — enable mic track (audio flows into OpenAI's input
 *                            audio buffer over WebRTC).
 *   • cancelVoiceInput()   — disable mic + clear the input buffer (used for
 *                            short presses with too little audio to commit).
 *   • commitVoiceInput()   — disable mic + commit the buffer + request a
 *                            response. The user's transcribed text arrives via
 *                            `conversation.item.input_audio_transcription.completed`.
 */

import {
  MediaStream,
  MediaStreamTrack,
  mediaDevices,
  RTCPeerConnection,
  RTCRtpTransceiver,
} from 'react-native-webrtc';
import type { MessageEventData } from 'react-native-webrtc/lib/typescript/MessageEvent';
import { CollarTrigger, ChatMessage, DogProfile, DogVoiceStyle, ManualTrigger } from '../types';
import { buildSystemPrompt, buildUserPrompt } from './LLMService';

// react-native-webrtc extends EventTarget from event-target-shim, whose typings
// aren't resolved by the RN tsconfig. We redeclare the minimal surface we need.
interface RNDataChannel {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: MessageEventData }) => void) | null;
}

interface RNPeerConnection {
  addTransceiver(source: 'audio' | 'video', init: { direction: string }): RTCRtpTransceiver;
  createDataChannel(label: string): RNDataChannel;
  createOffer(options?: object): Promise<{ sdp?: string; type: string }>;
  setLocalDescription(desc: { sdp?: string; type: string }): Promise<void>;
  setRemoteDescription(desc: { sdp: string; type: string }): Promise<void>;
  close(): void;
  onconnectionstatechange: (() => void) | null;
  connectionState: string;
}

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

// Map dog voice styles to OpenAI Realtime GA voices.
// GA voices (gpt-realtime): marin, cedar, alloy, ash, ballad, coral, echo, sage, shimmer, verse
const VOICE_MAP: Record<DogVoiceStyle, string> = {
  bouncy_excited: 'marin',
  wise_calm: 'cedar',
  silly_goofy: 'ballad',
  sweet_loving: 'shimmer',
  dramatic_diva: 'coral',
};

// ── Realtime event shapes (subset we care about) ────────────────────────────

interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

interface TranscriptDeltaEvent extends RealtimeEvent {
  type: 'response.audio_transcript.delta' | 'response.output_text.delta';
  delta: string;
}

interface ResponseDoneEvent extends RealtimeEvent {
  type: 'response.done';
  response: {
    output?: Array<{
      content?: Array<{ transcript?: string; text?: string }>;
    }>;
  };
}

interface ErrorEvent extends RealtimeEvent {
  type: 'error';
  error: { message?: string; code?: string };
}

interface InputAudioTranscriptionCompletedEvent extends RealtimeEvent {
  type: 'conversation.item.input_audio_transcription.completed';
  item_id: string;
  transcript: string;
}

interface InputAudioTranscriptionFailedEvent extends RealtimeEvent {
  type: 'conversation.item.input_audio_transcription.failed';
  item_id: string;
  error?: { message?: string };
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Reconnect tuning. Exponential backoff capped at 30s; reset on a successful
 * connect. We keep retrying indefinitely so a flaky network eventually heals
 * without user intervention — the UI can show a "reconnecting…" state via
 * `onStatusChange('connecting')`.
 */
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

class RealtimeService {
  private pc: RNPeerConnection | null = null;
  private dc: RNDataChannel | null = null;

  private currentMsgId: string | null = null;
  private currentTrigger: CollarTrigger | ManualTrigger | null = null;
  private pendingDogProfile: DogProfile | null = null;
  private pendingPriorMessages: ChatMessage[] | null = null;

  // ── Voice input state ───────────────────────────────────────────────────
  // We add a sendrecv audio transceiver upfront (no track), so the SDP is
  // already negotiated to allow mic audio. The mic itself is captured
  // *per-press* via getUserMedia and released the moment the press ends —
  // this keeps PTT actually push-to-talk: mic hardware off and iOS recording
  // indicator dark between presses, and zero RTP audio going to OpenAI.
  //
  // `voiceState` is a small state machine that prevents races where the user
  // releases the button before the (async) permission prompt resolves, which
  // would otherwise leave a captured mic dangling with nothing to release it.
  // `pendingHumanMsgId` is the placeholder bubble whose text gets filled in
  // once the server returns the input transcription.
  private micTransceiver: RTCRtpTransceiver | null = null;
  private micStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private voiceState: 'idle' | 'starting' | 'recording' = 'idle';
  private pendingHumanMsgId: string | null = null;
  // Whether the current session SDP was negotiated with sendrecv (true) or
  // recvonly (false). Stays false until the user's first PTT press so the
  // iOS mic indicator never appears before they opt in to voice.
  private voiceEnabled = false;
  // True while reconnectWithVoice() is in flight so App.tsx can suppress the
  // transient 'connecting' → llmStatus='loading' change that would otherwise
  // disable the mic Pressable mid-press and kill the gesture.
  isVoiceUpgrading = false;

  // ── Auto-reconnect state ────────────────────────────────────────────────
  // The service owns the reconnect loop so every disconnect path (network
  // blip, voice swap, manual "Reconnect" button) goes through one place. The
  // intentional flag lets explicit teardown (provider switch, app unmount)
  // suppress the loop.
  private cachedBackendUrl: string | null = null;
  private cachedDogProfile: DogProfile | null = null;
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  // ── Callbacks (set by useLLM hook / App.tsx) ────────────────────────────

  onTranscriptDelta?: (delta: string, msgId: string) => void;
  onResponseDone?: (fullText: string, msgId: string, trigger: CollarTrigger | ManualTrigger) => void;
  /**
   * When true the session is asked for text-only responses: the phone stays
   * silent and the caller speaks the text elsewhere (the collar speaker).
   * Takes effect on the next session.update (setTextOnly re-sends it).
   */
  private textOnly = false;

  setTextOnly(textOnly: boolean) {
    if (this.textOnly === textOnly) return;
    this.textOnly = textOnly;
    if (this.isConnected && this.cachedDogProfile) {
      this.sendSessionUpdate(this.cachedDogProfile);
    }
  }
  onUserTranscript?: (transcript: string, msgId: string) => void;
  onError?: (message: string) => void;
  onStatusChange?: (status: 'disconnected' | 'connecting' | 'ready' | 'error') => void;
  /**
   * Called by scheduleReconnect to obtain the recent message history to replay
   * into the new session after an unintentional drop. Set by App.tsx so the
   * service doesn't need to import the store directly.
   */
  priorMessagesProvider?: () => ChatMessage[];

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Connect a fresh Realtime session.
   *
   * Caches the backend URL and dog profile so the service can self-reconnect
   * if the WebRTC peer connection drops mid-session. Tearing down any
   * existing peer first means callers don't have to worry about double-connect
   * races (e.g. an in-flight auto-reconnect colliding with a voice swap).
   *
   * @param priorMessages - Optional. If provided, these messages are replayed
   *   into the new session as `conversation.item.create` events right after
   *   the data channel opens, so the model has continuity across reconnects
   *   (e.g. when the user changes voice style mid-conversation).
   */
  async connect(
    backendUrl: string,
    dogProfile: DogProfile,
    priorMessages?: ChatMessage[],
  ): Promise<void> {
    this.cachedBackendUrl = backendUrl;
    this.cachedDogProfile = dogProfile;
    this.intentionalDisconnect = false;
    this.cancelPendingReconnect();
    this.tearDownPeer();

    this.pendingDogProfile = dogProfile;
    this.pendingPriorMessages = priorMessages ?? null;
    this.onStatusChange?.('connecting');

    try {
      const token = await this.fetchEphemeralToken(backendUrl, dogProfile.voiceStyle);
      await this.setupPeerConnection(token, dogProfile);
      this.reconnectAttempt = 0;
      this.onStatusChange?.('ready');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Realtime] connect error:', msg);
      this.onStatusChange?.('error');
      // Schedule a retry on transient failures (token fetch, SDP exchange,
      // network). Caller still gets the rejection so existing error UX runs.
      this.scheduleReconnect();
      throw e;
    }
  }

  /**
   * Reconnect using the most recent connect() config. Used for voice-style
   * swaps and the user-initiated "Reconnect" affordance in Settings. Throws
   * if connect() has never been called.
   */
  async reconnect(priorMessages?: ChatMessage[]): Promise<void> {
    if (!this.cachedBackendUrl || !this.cachedDogProfile) {
      throw new Error('RealtimeService.reconnect called before connect');
    }
    return this.connect(this.cachedBackendUrl, this.cachedDogProfile, priorMessages);
  }

  /**
   * Upgrade the session from recvonly → sendrecv so PTT can stream mic audio.
   *
   * Called automatically by useLLM on the user's first PTT press. Sets
   * voiceEnabled = true (so setupPeerConnection uses sendrecv) and
   * isVoiceUpgrading = true (so App.tsx suppresses the transient
   * 'connecting' status that would otherwise flip llmStatus to 'loading',
   * disable the mic Pressable mid-press, and kill the touch gesture).
   *
   * Once upgraded, auto-reconnects after network drops also use sendrecv.
   * disconnect() resets voiceEnabled so the next explicit connect() starts
   * recvonly again (e.g. after the app returns from background).
   */
  async reconnectWithVoice(priorMessages?: ChatMessage[]): Promise<void> {
    if (!this.cachedBackendUrl || !this.cachedDogProfile) {
      throw new Error('RealtimeService.reconnectWithVoice called before connect');
    }
    this.voiceEnabled = true;
    this.isVoiceUpgrading = true;
    try {
      await this.connect(this.cachedBackendUrl, this.cachedDogProfile, priorMessages);
    } catch (e) {
      this.voiceEnabled = false;
      throw e;
    } finally {
      this.isVoiceUpgrading = false;
    }
  }

  /**
   * Tear down the session and stop any pending auto-reconnect. Use this when
   * the user explicitly leaves the cloud path (provider switch) or the app
   * unmounts. After disconnect(), the next session must be started via
   * connect() again.
   */
  disconnect() {
    this.intentionalDisconnect = true;
    this.voiceEnabled = false;
    this.cancelPendingReconnect();
    this.tearDownPeer();
    this.onStatusChange?.('disconnected');
  }

  /**
   * Update session instructions when the dog profile changes.
   *
   * NOTE: This only updates instructions. OpenAI's Realtime API binds the voice
   * at token-mint time and won't change it on a live session. To change voice,
   * call connect() again with the new profile.
   *
   * Also refreshes the cached profile so a subsequent auto-reconnect uses the
   * latest prompt/persona — otherwise a network blip after a prompt edit would
   * silently revert to the previous instructions.
   */
  updateSession(dogProfile: DogProfile) {
    this.pendingDogProfile = dogProfile;
    this.cachedDogProfile = dogProfile;
    if (this.dc?.readyState === 'open') {
      this.sendSessionUpdate(dogProfile);
    }
  }

  get isConnected() {
    return this.dc?.readyState === 'open';
  }

  /** True once the session has been rebuilt with sendrecv by reconnectWithVoice(). */
  get canSendVoice() {
    return this.voiceEnabled && this.isConnected;
  }

  /**
   * Send a text prompt (and optional photo) and start a response.
   * The model will stream audio (via WebRTC) and transcript deltas (via data channel).
   *
   * @param imageBase64 - Base64-encoded JPEG (no data: prefix). When provided it is
   *   included as an `input_image` content item so the model can see what the dog
   *   is doing or what is in front of the camera.
   */
  sendPrompt(
    promptText: string,
    msgId: string,
    trigger: CollarTrigger | ManualTrigger,
    imageBase64?: string | string[],
  ) {
    if (!this.isConnected) {
      this.onError?.('Realtime session not connected');
      return;
    }

    this.currentMsgId = msgId;
    this.currentTrigger = trigger;

    const images = imageBase64 == null ? [] : Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
    const content: { type: string; text?: string; image_url?: string }[] = [
      {
        type: 'input_text',
        text:
          images.length > 1
            ? `${promptText}\n\n(You can see through your human's phone camera: ${images.length} frames from the last few seconds, oldest first. React to anything interesting, don't caption it.)`
            : promptText,
      },
    ];

    for (const img of images) {
      content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${img}` });
    }

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content,
      },
    });

    this.send({ type: 'response.create' });
  }

  /**
   * Trigger a one-shot spoken utterance through the realtime session without
   * adding anything to the conversation history. Used by Settings → Test audio
   * output: real responses on the cloud path play through the WebRTC remote
   * audio track, so the test must use that same channel rather than local TTS
   * (which is silenced by the WebRTC audio session).
   *
   * Uses `conversation: 'none'` for an out-of-band response, and leaves
   * `currentMsgId`/`currentTrigger` unset so transcript/done events from this
   * test are ignored by handleEvent.
   */
  sendTestUtterance(text: string): boolean {
    if (!this.isConnected) return false;
    this.send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: this.textOnly ? ['text'] : ['audio'],
        instructions: `Say exactly this, in your dog voice, and nothing else: "${text}"`,
      },
    });
    return true;
  }

  // ── Voice input ──────────────────────────────────────────────────────────

  /**
   * Begin streaming microphone audio to OpenAI for one PTT press.
   *
   * Each press calls getUserMedia and attaches a fresh track to the
   * sendrecv transceiver via replaceTrack (no SDP renegotiation needed
   * since the audio kind already matches). The track is fully released by
   * cancelVoiceInput / commitVoiceInput so the mic hardware shuts off and
   * the iOS recording indicator goes dark between presses.
   *
   * If the user releases the button before the permission/getUserMedia
   * round-trip finishes (state has flipped back to 'idle'), the captured
   * stream is torn down before being attached so the mic is never left on.
   *
   * Returns false if the session isn't connected, another press is already
   * in flight, or the mic couldn't be acquired (permission denied, etc.).
   */
  async startVoiceInput(): Promise<boolean> {
    if (!this.isConnected || !this.pc || !this.micTransceiver) {
      this.onError?.('Realtime session not connected');
      return false;
    }
    if (this.voiceState !== 'idle') {
      console.warn('[Realtime] startVoiceInput called while', this.voiceState);
      return false;
    }

    this.voiceState = 'starting';

    let stream: MediaStream | null = null;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true, video: false });

      // The user may have released the button while we were awaiting the
      // permission prompt. Bail out and discard the just-acquired stream
      // rather than leaving the mic hot with no path to release it.
      if (this.voiceState !== 'starting') {
        stream.getTracks().forEach(t => t.stop());
        return false;
      }

      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('getUserMedia returned no audio track');

      await this.micTransceiver.sender.replaceTrack(track);
      this.micStream = stream;
      this.micTrack = track;
      track.enabled = true;
      this.voiceState = 'recording';
      return true;
    } catch (e) {
      this.voiceState = 'idle';
      // Whatever we managed to capture before the throw, release it.
      try { stream?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Realtime] startVoiceInput error:', msg);
      this.onError?.(`Mic capture failed: ${msg}`);
      return false;
    }
  }

  /**
   * Release the mic and clear any audio sitting in the server-side input
   * buffer. Safe to call from any state — if a press is still in 'starting'
   * (mid getUserMedia), flipping voiceState back to 'idle' makes the
   * in-flight startVoiceInput discard the stream when it eventually resolves.
   */
  cancelVoiceInput(): void {
    if (this.voiceState === 'idle') return;
    this.voiceState = 'idle';
    this.releaseMic();
    if (this.isConnected) {
      this.send({ type: 'input_audio_buffer.clear' });
    }
  }

  /**
   * Commit the buffered audio as a user turn and request the model's reply.
   * The user's transcribed text arrives via the
   * `conversation.item.input_audio_transcription.completed` event, where
   * we'll route it to `onUserTranscript(transcript, humanMsgId)`. The dog's
   * spoken response streams through the existing transcript-delta path.
   *
   * If the press never reached 'recording' (e.g. permission still pending),
   * we treat this like a cancel rather than committing an empty buffer.
   */
  commitVoiceInput(humanMsgId: string, dogMsgId: string): boolean {
    if (!this.isConnected) {
      this.onError?.('Realtime session not connected');
      return false;
    }
    if (this.voiceState !== 'recording') {
      this.cancelVoiceInput();
      return false;
    }

    this.voiceState = 'idle';
    // Disable the track first so no further audio is appended to the buffer
    // between commit and full release.
    if (this.micTrack) this.micTrack.enabled = false;

    this.pendingHumanMsgId = humanMsgId;
    this.currentMsgId = dogMsgId;
    this.currentTrigger = ManualTrigger.CUSTOM_TEXT;

    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'response.create' });

    this.releaseMic();
    return true;
  }

  /**
   * Stop the captured mic track and detach it from the sender so iOS
   * releases the audio hardware (recording indicator goes off). Synchronous
   * from the caller's perspective: state fields are nulled immediately so
   * the next press sees a clean slate; the actual replaceTrack(null) is
   * fire-and-forget since rn-webrtc serialises sender operations.
   */
  private releaseMic(): void {
    const transceiver = this.micTransceiver;
    const track = this.micTrack;
    const stream = this.micStream;
    this.micTrack = null;
    this.micStream = null;

    try { track?.stop(); } catch { /* already stopped */ }
    try { stream?.getTracks().forEach(t => t.stop()); } catch { /* already stopped */ }
    if (transceiver) {
      transceiver.sender.replaceTrack(null).catch(() => { /* ignore */ });
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async fetchEphemeralToken(backendUrl: string, voiceStyle: DogVoiceStyle): Promise<string> {
    const base = (backendUrl.trim() || 'https://talking-dog-worker.benjamin-guzovsky.workers.dev').replace(/\/$/, '');
    const res = await fetch(`${base}/v1/realtime/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: VOICE_MAP[voiceStyle] ?? 'marin' }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Token fetch failed ${res.status}: ${text}`);
    }

    // GA /v1/realtime/client_secrets returns { value, expires_at, session: {...} }.
    // Older beta /v1/realtime/sessions returned { client_secret: { value } } — accept either.
    const data = await res.json() as { value?: string; client_secret?: { value?: string } };
    const token = data.value ?? data.client_secret?.value;
    if (!token) throw new Error('No ephemeral token value in response');
    return token;
  }

  private async setupPeerConnection(token: string, dogProfile: DogProfile): Promise<void> {
    const pc = new RTCPeerConnection({}) as unknown as RNPeerConnection;
    this.pc = pc;

    // Audio transceiver direction depends on whether voice send has been
    // enabled. recvonly (the default) receives the dog's voice without
    // touching the mic hardware — AVAudioSession stays in Playback mode so
    // the iOS orange indicator never appears. On the user's first PTT press,
    // reconnectWithVoice() rebuilds the session with sendrecv; from that
    // point replaceTrack() is used per-press to capture and release the mic.
    this.micTransceiver = pc.addTransceiver('audio', {
      direction: this.voiceEnabled ? 'sendrecv' : 'recvonly',
    });

    // Data channel for sending/receiving session events
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;

    // Wait for the data channel to actually open before resolving.
    const dcReady = new Promise<void>((resolve, reject) => {
      dc.onopen = () => {
        console.log('[Realtime] data channel open');
        const profile = this.pendingDogProfile ?? dogProfile;
        this.sendSessionUpdate(profile);
        if (this.pendingPriorMessages?.length) {
          this.replayPriorMessages(this.pendingPriorMessages);
          this.pendingPriorMessages = null;
        }
        resolve();
      };
      // Reject during setup if the connection fails before the channel opens.
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log('[Realtime] connection state:', state);
        if (state === 'failed' || state === 'closed') {
          reject(new Error(`WebRTC connection ${state}`));
        }
      };
    });

    // After dc opens, keep monitoring connection state for mid-session failures.
    // Unintentional drops (network blip, server reset) flip the UI to
    // 'connecting' and kick off the backoff loop; intentional teardown via
    // disconnect() short-circuits via the flag.
    dcReady.then(() => {
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log('[Realtime] connection state:', state);
        // Belt-and-braces: if this.pc has been replaced with a newer peer
        // (e.g. a concurrent connect() raced ahead of us), ignore stale
        // events from this captured pc. tearDownPeer also nulls the handler
        // before close, but iOS rn-webrtc has been observed to fire one
        // last state change anyway.
        if (this.pc !== pc) return;
        if (state === 'failed' || state === 'closed') {
          if (this.intentionalDisconnect) return;
          this.onStatusChange?.('connecting');
          this.scheduleReconnect();
        }
      };
    }).catch(() => { /* setup failed; no need to rebind */ });

    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const event = JSON.parse(e.data) as RealtimeEvent;
          this.handleEvent(event);
        } catch {
          // ignore malformed events
        }
      }
    };

    // Create and send the SDP offer
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);

    // POST offer SDP directly to OpenAI with the ephemeral token
    const sdpRes = await fetch(REALTIME_CALLS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/sdp',
      },
      body: (offer as { sdp?: string }).sdp ?? '',
    });

    if (!sdpRes.ok) {
      const text = await sdpRes.text().catch(() => '');
      throw new Error(`SDP exchange failed ${sdpRes.status}: ${text}`);
    }

    const answerSdp = await sdpRes.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // Block until the data channel is open so callers know the session is
    // truly ready to send messages.
    await dcReady;
  }

  /**
   * Replay recent local messages into the new session as conversation items so
   * the model has continuity after a reconnect (e.g. voice style change).
   *
   * Mapping:
   *   - role 'human' → role 'user', content type 'input_text'
   *   - role 'dog'   → role 'assistant', content type 'output_text'
   *
   * For dog messages that were triggered by the collar (no human turn), we use
   * the synthetic user prompt that originally produced them so the conversation
   * reads as a coherent back-and-forth.
   */
  private replayPriorMessages(messages: ChatMessage[]) {
    for (const m of messages) {
      // Skip placeholder/in-flight messages that never resolved to text.
      const text = m.text?.trim();
      if (!text || text === '…' || text === '...woof?') continue;

      if (m.role === 'human') {
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        });
      } else {
        // For collar-triggered dog turns there's no preceding human message;
        // synthesize the prompt that originally drove this response so the
        // assistant turn isn't dangling.
        if (m.trigger) {
          this.send({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: buildUserPrompt(m.trigger) }],
            },
          });
        }
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          },
        });
      }
    }
  }

  private sendSessionUpdate(dogProfile: DogProfile) {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: buildSystemPrompt(dogProfile),
        output_modalities: this.textOnly ? ['text'] : ['audio'],
        audio: {
          output: {
            voice: VOICE_MAP[dogProfile.voiceStyle] ?? 'marin',
          },
          input: {
            // Disable server-side VAD: the user holds a PTT button and we
            // commit the input audio buffer manually on release.
            turn_detection: null,
            // Have the server transcribe the user's audio so we can show
            // their words in the chat. The dog model still consumes the
            // raw audio directly — this transcript is just for the UI.
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
          },
        },
      },
    });
  }

  private send(payload: unknown) {
    if (!this.dc || this.dc.readyState !== 'open') {
      console.warn('[Realtime] send called but data channel not open');
      return;
    }
    this.dc.send(JSON.stringify(payload));
  }

  private tearDownPeer() {
    // CRITICAL: detach the connection-state handler BEFORE close(). Otherwise
    // the synthetic 'closed' event we're about to fire would re-enter the
    // post-setup handler, look like an unintentional drop, and queue an
    // auto-reconnect against ourselves — producing a connect/teardown loop
    // every time we replace the peer (e.g. a voice swap or URL change).
    if (this.pc) {
      try { this.pc.onconnectionstatechange = null; } catch { /* ignore */ }
    }
    // Stop any captured mic tracks first so iOS releases the audio session
    // cleanly. The track itself is owned by the stream, so stopping the
    // stream's tracks is sufficient.
    try { this.micStream?.getTracks().forEach(t => t.stop()); } catch { /* already stopped */ }
    try { this.dc?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    this.dc = null;
    this.pc = null;
    this.micTransceiver = null;
    this.micStream = null;
    this.micTrack = null;
    this.voiceState = 'idle';
    this.pendingHumanMsgId = null;
    this.currentMsgId = null;
    this.currentTrigger = null;
  }

  private cancelPendingReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Queue a reconnect attempt with exponential backoff. No-op when the user
   * has explicitly disconnected, or when another retry is already pending.
   * Each failed attempt grows the delay; a successful connect() resets the
   * counter.
   */
  private scheduleReconnect() {
    if (this.intentionalDisconnect) return;
    if (this.reconnectTimer) return;
    if (!this.cachedBackendUrl || !this.cachedDogProfile) return;

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    console.log(`[Realtime] scheduling reconnect attempt ${this.reconnectAttempt} in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Replay recent messages into the new session so the model retains
      // conversation context across the drop.
      const priorMessages = this.priorMessagesProvider?.();
      // reconnect() will reset reconnectAttempt on success or schedule another
      // attempt on failure (via the catch branch in connect()).
      this.reconnect(priorMessages).catch(e => {
        console.warn('[Realtime] auto-reconnect attempt failed:', e);
      });
    }, delay);
  }

  private handleEvent(event: RealtimeEvent) {
    switch (event.type) {
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta': {
        const e = event as TranscriptDeltaEvent;
        if (this.currentMsgId && e.delta) {
          this.onTranscriptDelta?.(e.delta, this.currentMsgId);
        }
        break;
      }

      case 'response.done': {
        const e = event as ResponseDoneEvent;
        const first = e.response?.output?.[0]?.content?.[0];
        const transcript = first?.transcript ?? first?.text ?? '';
        if (this.currentMsgId && this.currentTrigger !== null) {
          this.onResponseDone?.(transcript, this.currentMsgId, this.currentTrigger);
        }
        this.currentMsgId = null;
        this.currentTrigger = null;
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const e = event as InputAudioTranscriptionCompletedEvent;
        const msgId = this.pendingHumanMsgId;
        this.pendingHumanMsgId = null;
        if (msgId && typeof e.transcript === 'string') {
          this.onUserTranscript?.(e.transcript.trim(), msgId);
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.failed': {
        const e = event as InputAudioTranscriptionFailedEvent;
        const msgId = this.pendingHumanMsgId;
        this.pendingHumanMsgId = null;
        const reason = e.error?.message ?? 'transcription failed';
        console.warn('[Realtime] input audio transcription failed:', reason);
        if (msgId) {
          // Surface a placeholder so the bubble isn't stuck on "…"
          this.onUserTranscript?.('🎙️ (couldn\u2019t hear that)', msgId);
        }
        break;
      }

      case 'error': {
        const e = event as ErrorEvent;
        const msg = e.error?.message ?? 'Unknown Realtime error';
        console.error('[Realtime] server error:', msg, e.error?.code);
        this.onError?.(msg);
        // Clear pending state so the UI doesn't get stuck
        this.currentMsgId = null;
        this.currentTrigger = null;
        this.pendingHumanMsgId = null;
        break;
      }

      case 'session.updated': {
        const sess = (event as RealtimeEvent & { session?: { output_modalities?: string[] } }).session;
        console.log('[Realtime] session.updated — output_modalities:', sess?.output_modalities, 'textOnly:', this.textOnly);
        break;
      }

      default:
        break;
    }
  }
}

export const realtimeService = new RealtimeService();
