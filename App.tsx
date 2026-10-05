import React, { useEffect, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppState, Platform, StyleSheet } from 'react-native';
import { PERMISSIONS, requestMultiple } from 'react-native-permissions';
import AppNavigator from './src/navigation';
import { useDogStore } from './src/store/dogStore';
import { audioService } from './src/services/AudioService';
import { llmService } from './src/services/LLMService';
import { realtimeService } from './src/services/RealtimeService';
import { appAttestService } from './src/services/AppAttestService';
import type { DogProfile } from './src/types';

export default function App() {
  const hydrate = useDogStore(s => s.hydrate);
  const setLLMStatus = useDogStore(s => s.setLLMStatus);

  // Refs the secondary effect uses to detect *user-driven* changes to the
  // dog profile / backend URL. Declared up here so the mount effect can seed
  // them with the post-hydrate values before the store change triggers a
  // re-render — otherwise the secondary effect would interpret the
  // hydration delta as a voice/URL swap and fire a duplicate connect().
  const prevProfileRef = useRef<DogProfile | null>(null);
  const prevBackendUrlRef = useRef<string | null>(null);
  /** Tracks onboarding completion so we connect after finish and skip reconnect while onboarding / after reset. */
  const prevOnboardingCompleteRef = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await hydrate();
      audioService.initTts(0.48, 1.05).catch(console.warn);

      // Android: ask for Bluetooth up front (iOS shows its own prompt the
      // first time BLE is touched; Android only prompts when we ask).
      if (Platform.OS === 'android' && useDogStore.getState().hasCompletedOnboarding) {
        const wanted =
          Platform.Version >= 31
            ? [PERMISSIONS.ANDROID.BLUETOOTH_SCAN, PERMISSIONS.ANDROID.BLUETOOTH_CONNECT]
            : [PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION];
        requestMultiple(wanted)
          .then(res => console.log('[App] android BLE permissions:', res))
          .catch(e => console.warn('[App] BLE permission request failed:', e));
      }

      const { settings, dogProfile: hydratedProfile } = useDogStore.getState();
      // Seed change-detection refs BEFORE the hydrate-induced render commits
      // so the secondary effect's first post-hydrate run sees prev === current
      // and treats it as a no-op rather than a user-driven settings change.
      prevProfileRef.current = hydratedProfile;
      prevBackendUrlRef.current = settings.backendUrl;
      prevOnboardingCompleteRef.current = useDogStore.getState().hasCompletedOnboarding;

      // Point AppAttest at the configured backend URL and register this device
      // if it hasn't been registered yet.
      appAttestService.setBackendUrl(settings.backendUrl);
      appAttestService.initialize().catch(e =>
        console.warn('[App] AppAttest init failed:', e),
      );

      // Activate whichever model provider the user has selected.
      // Wire onStatusChange once: RealtimeService owns the reconnect loop, so
      // App.tsx is purely a status -> llmStatus mapper. 'connecting' covers
      // both first-time connects and auto-reconnect attempts after a drop.
      realtimeService.onStatusChange = status => {
        if (cancelled) return;
        if (status === 'ready') setLLMStatus('ready');
        else if (status === 'connecting') {
          // Suppress the loading flash during a PTT-triggered sendrecv upgrade
          // so the mic Pressable stays enabled and the touch gesture isn't lost.
          if (!realtimeService.isVoiceUpgrading) setLLMStatus('loading');
        }
        else if (status === 'error' || status === 'disconnected') {
          // The HTTP /v1/generate path works without a Realtime session, so
          // stay usable (text replies on the phone, voice on the collar).
          if (status === 'error') console.warn('[App] Realtime unavailable — using HTTP generation');
          setLLMStatus('ready');
        }
      };

      // Give the auto-reconnect loop a way to pull recent messages so the
      // model retains context after an unintentional drop.
      realtimeService.priorMessagesProvider = () =>
        useDogStore.getState().messages.slice(-10);

      try {
        setLLMStatus('loading');

        if (settings.modelProvider === 'backend') {
          // Skip until onboarding is done — the second effect handles the
          // connect() call once the user finishes setup. Connecting early
          // would activate the WebRTC audio session (and the iOS mic
          // indicator) before the user has opted in to anything.
          if (useDogStore.getState().hasCompletedOnboarding) {
            const { dogProfile, messages } = useDogStore.getState();
            await realtimeService.connect(
              settings.backendUrl,
              dogProfile,
              messages.slice(-10),
            );
          } else {
            if (!cancelled) setLLMStatus('not_loaded');
          }
        } else {
          await llmService.activate(settings.modelProvider);
          if (!cancelled) setLLMStatus('ready');
        }
      } catch (e) {
        console.warn('[App] failed to activate model provider', e);
        // RealtimeService will keep retrying in the background; surface the
        // current state without overriding the status it just emitted.
        if (!cancelled && settings.modelProvider !== 'backend') {
          setLLMStatus('not_loaded');
        }
      }
    })();

    return () => {
      cancelled = true;
      realtimeService.disconnect();
    };
  }, [hydrate, setLLMStatus]);

  // ── React to dogProfile / settings changes during a live Realtime session ─
  // OpenAI's Realtime API binds the voice at token-mint time (audio.output.voice
  // on /v1/realtime/client_secrets). Once the session has produced audio, voice
  // can't be changed via session.update. So a voiceStyle change requires
  // disconnecting and reconnecting with a fresh ephemeral token.
  //
  // A backendUrl change must also reconnect — RealtimeService caches the URL
  // for its auto-reconnect loop and a stale value would defeat the override.
  //
  // Other profile changes (name, breed, traits, context) only affect the system
  // prompt and can be applied with a cheap session.update.
  const dogProfile = useDogStore(s => s.dogProfile);
  const modelProvider = useDogStore(s => s.settings.modelProvider);
  const backendUrl = useDogStore(s => s.settings.backendUrl);
  const hasCompletedOnboarding = useDogStore(s => s.hasCompletedOnboarding);

  useEffect(() => {
    const prevOnboarding = prevOnboardingCompleteRef.current;
    const justFinishedOnboarding =
      prevOnboarding === false && hasCompletedOnboarding;

    const prev = prevProfileRef.current;
    const prevUrl = prevBackendUrlRef.current;
    prevProfileRef.current = dogProfile;
    prevBackendUrlRef.current = backendUrl;
    prevOnboardingCompleteRef.current = hasCompletedOnboarding;

    if (modelProvider !== 'backend') return;
    // Skip until refs are seeded (initial render → before hydrate completes).
    // The mount effect seeds them with the post-hydrate values, so the first
    // post-hydrate render here has prev === current and skips reconnecting.
    if (!prev || prevUrl == null) return;

    if (justFinishedOnboarding) {
      const priorMessages = useDogStore.getState().messages.slice(-10);
      realtimeService
        .connect(backendUrl, dogProfile, priorMessages)
        .catch(e => console.warn('[App] connect after onboarding failed:', e));
      return;
    }

    if (!hasCompletedOnboarding) return;

    const voiceChanged = prev.voiceStyle !== dogProfile.voiceStyle;
    const urlChanged = prevUrl !== backendUrl;
    const promptChanged =
      prev.name !== dogProfile.name ||
      prev.breed !== dogProfile.breed ||
      prev.age !== dogProfile.age ||
      prev.additionalContext !== dogProfile.additionalContext ||
      prev.personalityTraits.join('|') !== dogProfile.personalityTraits.join('|');

    const collarMode =
      useDogStore.getState().settings.audioOutput === 'collar' &&
      useDogStore.getState().bleStatus === 'connected';
    if (collarMode) return; // no Realtime session in collar mode

    if (voiceChanged || urlChanged) {
      // Replay the last 5 turns (10 messages) into the new session so the dog
      // remembers the conversation across the swap. We always call connect()
      // (not reconnect()) here so the service caches the *new* profile/URL —
      // a stale cache would otherwise feed the wrong voice or URL into the
      // background auto-reconnect loop. RealtimeService tears down the
      // existing peer and emits its own status events, so we only handle the
      // failure case here.
      const priorMessages = useDogStore.getState().messages.slice(-10);
      realtimeService
        .connect(backendUrl, dogProfile, priorMessages)
        .catch(e => console.warn('[App] reconnect after settings change failed:', e));
    } else if (promptChanged && realtimeService.isConnected) {
      // Cheap path: instructions can be updated on the live session.
      realtimeService.updateSession(dogProfile);
    }
  }, [dogProfile, modelProvider, backendUrl, hasCompletedOnboarding]);

  // ── Release the WebRTC session (and mic) when the app goes to background ──
  // react-native-webrtc keeps AVAudioSession active in PlayAndRecord mode for
  // the lifetime of the peer connection. On iOS this shows the orange
  // microphone indicator even if no track is attached. Disconnecting on
  // background tears down the session and clears the indicator; reconnecting
  // on foreground restores it with message history replayed so context is not
  // lost.
  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      const { settings, hasCompletedOnboarding, dogProfile, messages } =
        useDogStore.getState();
      if (settings.modelProvider !== 'backend') return;

      // Collar mode runs over HTTP with no WebRTC session; nothing to restore.
      const collarMode =
        settings.audioOutput === 'collar' && useDogStore.getState().bleStatus === 'connected';

      if (nextState === 'background' || nextState === 'inactive') {
        realtimeService.disconnect();
      } else if (nextState === 'active' && collarMode) {
        useDogStore.getState().setLLMStatus('ready');
      } else if (nextState === 'active' && hasCompletedOnboarding) {
        realtimeService
          .connect(settings.backendUrl, dogProfile, messages.slice(-10))
          .catch(e => console.warn('[App] reconnect on foreground failed:', e));
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AppNavigator />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
