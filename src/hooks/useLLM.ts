import { useCallback, useEffect, useRef } from 'react';
import { useDogStore } from '../store/dogStore';
import { llmService } from '../services/LLMService';
import { LLMService } from '../services/LLMService';
import { realtimeService } from '../services/RealtimeService';
import { audioService } from '../services/AudioService';
import { bluetoothService } from '../services/BluetoothService';
import { collarVoiceService } from '../services/CollarVoiceService';
import { collarSpeaker } from '../services/CollarSpeaker';
import { liveVideoService } from '../services/LiveVideoService';
import { stripAudioTags } from '../utils/audioTags';
import { CollarTrigger, ManualTrigger } from '../types';
import type { ChatMessage } from '../types';
import { buildUserPrompt } from '../services/LLMService';

function collarAudioSelected(): boolean {
  return useDogStore.getState().settings.audioOutput === 'collar' && bluetoothService.isConnected;
}

/**
 * If a reply hasn't finished after this long, assume the path died (stale
 * Realtime session, lost request) and unstick the UI so new input works.
 */
const GENERATION_TIMEOUT_MS = 40_000;
let generationWatchdog: ReturnType<typeof setTimeout> | null = null;
function armGenerationWatchdog() {
  if (generationWatchdog) clearTimeout(generationWatchdog);
  generationWatchdog = setTimeout(() => {
    generationWatchdog = null;
    const st = useDogStore.getState();
    if (st.isGenerating) {
      console.warn('[LLM] generation watchdog: no reply after 40 s — resetting');
      st.setIsGenerating(false);
      st.setDogState('idle');
      useDogStore.setState(s => ({
        messages: s.messages.map(m => (m.text === '…' ? { ...m, text: '...woof?' } : m)),
      }));
    }
  }, GENERATION_TIMEOUT_MS);
}

/** Start a new collar utterance (sentence-by-sentence TTS) for the coming reply. */
function beginCollarSpeech() {
  if (!collarAudioSelected()) return;
  const { settings, dogProfile } = useDogStore.getState();
  collarSpeaker.begin({ backendUrl: settings.backendUrl, voiceStyle: dogProfile.voiceStyle });
}

/** Photo attached by the user (if any) plus live-video frames from the last 5 s. */
function gatherImages(imageBase64?: string): string[] {
  const images = imageBase64 ? [imageBase64] : [];
  if (useDogStore.getState().settings.liveVideoEnabled) {
    const frames = liveVideoService.getRecentFrames();
    if (frames.length) {
      const kb = Math.round(frames.reduce((n, f) => n + f.length * 0.75, 0) / 1024);
      console.log(`[LLM] attaching ${frames.length} live video frame(s), ~${kb} kB`);
    } else {
      console.warn(`[LLM] live video is on but no frames in the last 5 s (buffer ${liveVideoService.frameCount}, active ${liveVideoService.isActive})`);
    }
    images.push(...frames);
  }
  return images;
}

export function useLLM() {
  const {
    dogProfile,
    messages,
    addMessage,
    setIsGenerating,
    setDogState,
    isGenerating,
    llmStatus,
    settings,
  } = useDogStore();

  // ── Wire Realtime event callbacks ──────────────────────────────────────────
  // Register once on mount. Callbacks write directly to the store so they work
  // regardless of which component called the hook.

  useEffect(() => {
    let realtimeRaw = '';
    realtimeService.onTranscriptDelta = (delta, msgId) => {
      if (collarAudioSelected()) collarSpeaker.onDelta(delta);
      realtimeRaw += delta;
      const shown = stripAudioTags(realtimeRaw) || '…';
      useDogStore.setState(s => ({
        messages: s.messages.map(m => (m.id === msgId ? { ...m, text: shown } : m)),
      }));
    };

    realtimeService.onResponseDone = (fullText, msgId, trigger) => {
      realtimeRaw = '';
      useDogStore.setState(s => ({
        messages: s.messages.map(m =>
          m.id === msgId ? { ...m, text: stripAudioTags(fullText) || m.text } : m,
        ),
      }));
      useDogStore.getState().setIsGenerating(false);
      useDogStore.getState().setDogState(LLMService.triggerToDogState(trigger));
      // Phone playback isn't observable, so give it a generous hold-off; collar
      // playback is covered exactly by bluetoothService.isStreamingAudio.
      collarVoiceService.holdOff(collarAudioSelected() ? 1500 : 8000);
      if (collarAudioSelected()) collarSpeaker.onDone(fullText);
    };

    realtimeService.onUserTranscript = (transcript, msgId) => {
      useDogStore.setState(s => ({
        messages: s.messages.map(m =>
          m.id === msgId ? { ...m, text: transcript || '🎙️' } : m,
        ),
      }));
    };

    realtimeService.onError = message => {
      console.error('[Realtime] error in hook:', message);
      useDogStore.setState(s => ({
        messages: s.messages.map(m =>
          m.id === useDogStore.getState().messages.at(-1)?.id && m.text === '…'
            ? { ...m, text: '...woof?' }
            : m,
        ),
      }));
      useDogStore.getState().setIsGenerating(false);
      useDogStore.getState().setDogState('idle');
    };

    return () => {
      realtimeService.onTranscriptDelta = undefined;
      realtimeService.onResponseDone = undefined;
      realtimeService.onUserTranscript = undefined;
      realtimeService.onError = undefined;
    };
  }, []);

  // ── Collar microphone → chat ───────────────────────────────────────────────
  // While a collar with a mic is connected and "collarMicInput" is on, speech
  // the collar hears is transcribed by the backend and fed in as a human
  // message, exactly like typing it.

  const generateResponseToTextRef = useRef<((t: string) => Promise<void>) | null>(null);
  const bleStatus = useDogStore(s => s.bleStatus);
  const collarMicInput = useDogStore(s => s.settings.collarMicInput);
  const backendUrl = useDogStore(s => s.settings.backendUrl);
  const audioOutput = useDogStore(s => s.settings.audioOutput);

  // ── Collar mode: no WebRTC ─────────────────────────────────────────────────
  // With the collar as the audio device the phone needs neither mic nor
  // speaker, and react-native-webrtc keeps iOS's audio session in
  // play-and-record (orange mic indicator) for as long as a peer connection
  // exists. So in collar mode we release the Realtime session entirely and
  // generate over plain HTTP (/v1/generate, streamed), restoring the session
  // when the collar disconnects or output goes back to the phone.
  const collarMode = audioOutput === 'collar' && bleStatus === 'connected';
  const wasCollarModeRef = useRef(false);
  useEffect(() => {
    const { settings, hasCompletedOnboarding, dogProfile, messages, setLLMStatus: setStatus } =
      useDogStore.getState();
    if (settings.modelProvider !== 'backend') return;
    if (collarMode) {
      wasCollarModeRef.current = true;
      realtimeService.disconnect();
      setStatus('ready'); // HTTP generation needs no session
      console.log('[Collar] text mode: WebRTC session released (phone mic/speaker off)');
    } else if (wasCollarModeRef.current) {
      wasCollarModeRef.current = false;
      if (hasCompletedOnboarding) {
        realtimeService
          .connect(settings.backendUrl, dogProfile, messages.slice(-10))
          .catch(e => console.warn('[Collar] realtime reconnect failed:', e));
      }
    }
  }, [collarMode]);

  useEffect(() => {
    // Listening requires collar audio output too: with speech on the phone the
    // collar mic would hear the phone and the dog would answer itself.
    const wantListening =
      bleStatus === 'connected' && collarMicInput && bluetoothService.hasMic && audioOutput === 'collar';
    if (!wantListening) {
      collarVoiceService.stop();
      return;
    }
    collarVoiceService.backendUrl = backendUrl;
    const profile = useDogStore.getState().dogProfile;
    collarVoiceService.recognizerPrompt = [profile.name, profile.ownerNames].filter(Boolean).join(', ');
    collarVoiceService.shouldPause = () => useDogStore.getState().isGenerating;
    collarVoiceService.onUtterance = text => {
      console.log('[CollarVoice] → chat:', text);
      void generateResponseToTextRef.current?.(text);
    };
    collarVoiceService.start();
    return () => collarVoiceService.stop();
  }, [bleStatus, collarMicInput, backendUrl, audioOutput]);

  // ── generateResponse ───────────────────────────────────────────────────────

  const generateResponse = useCallback(
    async (trigger: CollarTrigger | ManualTrigger, imageBase64?: string) => {
      if (useDogStore.getState().isGenerating) {
        console.warn('[LLM] dropping trigger', trigger, '— a reply is still generating');
        return;
      }

      setIsGenerating(true);
      setDogState('speaking');

      const msgId = `dog_${Date.now()}`;

      addMessage({
        id: msgId,
        role: 'dog',
        text: '…',
        trigger,
        timestamp: Date.now(),
      });

      const currentSettings = useDogStore.getState().settings;

      if (currentSettings.modelProvider === 'backend' && !collarAudioSelected() && realtimeService.isConnected) {
        // ── Realtime path (phone audio) ────────────────────────────────────
        // sendPrompt is fire-and-forget; callbacks above handle state updates.
        console.log('[LLM] generate via Realtime (trigger', trigger, ')');
        armGenerationWatchdog();
        const promptText = buildUserPrompt(trigger);
        realtimeService.sendPrompt(promptText, msgId, trigger, gatherImages(imageBase64));
        // setIsGenerating(false) + setDogState() are called by onResponseDone
        return;
      }

      // ── HTTP (collar mode, or Realtime unavailable) or on-device path ──────
      // Without a Realtime session the reply is text on the phone (no phone
      // voice); with the collar connected it is spoken there as usual.
      let generated = '';
      const speakViaCollar = collarAudioSelected();
      console.log(`[LLM] generate via HTTP (trigger ${trigger}, collar audio ${speakViaCollar})`);
      armGenerationWatchdog();
      if (speakViaCollar) beginCollarSpeech();
      try {
        const stateSnapshot = useDogStore.getState();

        generated = await llmService.generate({
          trigger,
          dogProfile,
          recentMessages: stateSnapshot.messages.filter(m => m.id !== msgId && m.text !== '…'),
          backendUrl: stateSnapshot.settings.backendUrl,
          images: gatherImages(imageBase64),
          onToken: token => {
            generated += token;
            if (speakViaCollar) collarSpeaker.onDelta(token);
            const shown = stripAudioTags(generated) || '…';
            useDogStore.setState(s => ({
              messages: s.messages.map(m =>
                m.id === msgId ? { ...m, text: shown } : m,
              ),
            }));
          },
        });

        useDogStore.setState(s => ({
          messages: s.messages.map(m =>
            m.id === msgId ? { ...m, text: stripAudioTags(generated) || generated } : m,
          ),
        }));

        setIsGenerating(false);
        setDogState(LLMService.triggerToDogState(trigger));

        if (speakViaCollar) {
          collarSpeaker.onDone(generated);
          collarVoiceService.holdOff(1500);
        } else {
          await audioService.speak(stripAudioTags(generated));
        }
      } catch (e) {
        console.error('[LLM] generate error', e);
        useDogStore.setState(s => ({
          messages: s.messages.map(m =>
            m.id === msgId ? { ...m, text: '...woof?' } : m,
          ),
        }));
      } finally {
        setIsGenerating(false);
        if (useDogStore.getState().dogState === 'speaking') {
          setDogState(LLMService.triggerToDogState(trigger));
        }
      }
    },
    [isGenerating, dogProfile, messages, addMessage, setIsGenerating, setDogState],
  );

  // ── generateResponseToText ─────────────────────────────────────────────────

  const generateResponseToText = useCallback(
    async (userText: string, imageBase64?: string) => {
      if (useDogStore.getState().isGenerating) {
        console.warn('[LLM] dropping text input — a reply is still generating:', userText);
        return;
      }

      const humanMsg: ChatMessage = {
        id: `human_${Date.now()}`,
        role: 'human',
        text: userText,
        timestamp: Date.now(),
      };
      useDogStore.getState().addMessage(humanMsg);

      const currentSettings = useDogStore.getState().settings;

      if (currentSettings.modelProvider === 'backend' && !collarAudioSelected() && realtimeService.isConnected) {
        // For custom text, send the user's actual words directly so the model
        // responds to what they said (not a generic prompt).
        console.log('[LLM] generate via Realtime (custom text)');
        armGenerationWatchdog();

        setIsGenerating(true);
        setDogState('speaking');

        const msgId = `dog_${Date.now()}`;
        addMessage({
          id: msgId,
          role: 'dog',
          text: '…',
          trigger: ManualTrigger.CUSTOM_TEXT,
          timestamp: Date.now(),
        });

        realtimeService.sendPrompt(userText, msgId, ManualTrigger.CUSTOM_TEXT, gatherImages(imageBase64));
        return;
      }

      // HTTP / on-device: the human message is already in the store, so the
      // model sees it in recentMessages under the CUSTOM_TEXT prompt.
      await generateResponse(ManualTrigger.CUSTOM_TEXT, imageBase64);
    },
    [isGenerating, generateResponse, addMessage, setIsGenerating, setDogState],
  );

  useEffect(() => {
    generateResponseToTextRef.current = text => generateResponseToText(text);
  }, [generateResponseToText]);

  // ── Voice input (push-to-talk) ─────────────────────────────────────────────
  // Backed by the existing OpenAI Realtime WebRTC session: mic audio streams
  // directly to OpenAI, the server transcribes it for our UI, and the dog's
  // spoken reply comes back through the same audio track + transcript deltas.
  // Only available on the `backend` provider — on-device LLM doesn't have a
  // voice path yet.

  const MIN_VOICE_DURATION_MS = 300;
  const voiceStartTsRef = useRef<number | null>(null);
  // Tracks whether the user is currently holding the PTT button. Set on
  // press, cleared on release. Used to handle the race where the user lifts
  // their finger before getUserMedia/permission resolves: in that case,
  // startVoice's promise resolves AFTER stopVoice ran with no started ts,
  // so we cancel the just-captured mic the moment we see we're no longer
  // pressed.
  const pressActiveRef = useRef(false);

  const startVoice = useCallback(async (): Promise<boolean> => {
    if (isGenerating) return false;
    const provider = useDogStore.getState().settings.modelProvider;
    if (provider !== 'backend' || !realtimeService.isConnected) return false;

    pressActiveRef.current = true;

    // The initial session is recvonly so the iOS mic indicator never appears
    // at rest. On the user's first PTT press (or after any app-background
    // cycle that resets voiceEnabled), upgrade the session to sendrecv.
    // isVoiceUpgrading suppresses the transient llmStatus='loading' change so
    // the mic Pressable stays enabled and the touch gesture isn't dropped.
    if (!realtimeService.canSendVoice) {
      try {
        const priorMessages = useDogStore.getState().messages.slice(-10);
        await realtimeService.reconnectWithVoice(priorMessages);
      } catch {
        pressActiveRef.current = false;
        return false;
      }
      if (!pressActiveRef.current) {
        // User released the button while the upgrade was in flight.
        realtimeService.cancelVoiceInput();
        return false;
      }
    }

    const ok = await realtimeService.startVoiceInput();

    if (!ok) {
      pressActiveRef.current = false;
      return false;
    }
    if (!pressActiveRef.current) {
      // User released while we were waiting for the mic. RealtimeService's
      // own state machine bails out before attaching the track when this
      // happens, but call cancel here too as a safety net so any
      // server-side input buffer state is cleared.
      realtimeService.cancelVoiceInput();
      return false;
    }
    voiceStartTsRef.current = Date.now();
    return true;
  }, [isGenerating]);

  const stopVoice = useCallback(() => {
    pressActiveRef.current = false;
    const startedAt = voiceStartTsRef.current;
    voiceStartTsRef.current = null;
    if (startedAt == null) {
      // Press was released before startVoice's getUserMedia resolved.
      // Cancel so the in-flight mic capture (if it still completes) is
      // immediately released and the server-side buffer is cleared.
      realtimeService.cancelVoiceInput();
      return;
    }

    const heldMs = Date.now() - startedAt;
    if (heldMs < MIN_VOICE_DURATION_MS) {
      realtimeService.cancelVoiceInput();
      return;
    }

    const now = Date.now();
    const humanMsgId = `human_${now}`;
    const dogMsgId = `dog_${now + 1}`;

    addMessage({ id: humanMsgId, role: 'human', text: '…', timestamp: now });
    addMessage({
      id: dogMsgId,
      role: 'dog',
      text: '…',
      trigger: ManualTrigger.CUSTOM_TEXT,
      timestamp: now + 1,
    });

    setIsGenerating(true);
    setDogState('speaking');
    realtimeService.commitVoiceInput(humanMsgId, dogMsgId);
  }, [addMessage, setIsGenerating, setDogState]);

  return {
    generateResponse,
    generateResponseToText,
    startVoice,
    stopVoice,
    isGenerating,
    llmStatus,
  };
}
