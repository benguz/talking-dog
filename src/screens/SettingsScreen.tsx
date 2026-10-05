import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import { useDogStore } from '../store/dogStore';
import { bluetoothService } from '../services/BluetoothService';
import { audioService } from '../services/AudioService';
import { realtimeService } from '../services/RealtimeService';
import { collarSpeaker } from '../services/CollarSpeaker';
import { clearDebugLines, getDebugLines, subscribeDebugLog } from '../utils/debugLog';
import { collarVoiceService } from '../services/CollarVoiceService';
import { appAttestService } from '../services/AppAttestService';
import { COLORS, HEADING_FONT_FAMILY, RADIUS, SPACING } from '../components/theme';
import {
  AudioOutput,
  BleStatus,
  CameraSource,
  CollarTrigger,
  MemsData,
} from '../types';

const COLLAR_TRIGGERS: { trigger: CollarTrigger; emoji: string; label: string }[] = [
  { trigger: CollarTrigger.WAG_START, emoji: '🐕', label: 'Wag start' },
  { trigger: CollarTrigger.WAG_STOP, emoji: '🛑', label: 'Wag stop' },
  { trigger: CollarTrigger.BARK, emoji: '🗣️', label: 'Bark' },
  { trigger: CollarTrigger.EXCITED, emoji: '🎉', label: 'Excited' },
  { trigger: CollarTrigger.CALM, emoji: '😌', label: 'Calm' },
  { trigger: CollarTrigger.SLEEPING, emoji: '😴', label: 'Sleeping' },
  { trigger: CollarTrigger.ALERT, emoji: '🚨', label: 'Alert' },
];

export default function SettingsScreen() {
  const {
    settings,
    updateSettings,
    bleStatus,
    setBleStatus,
    setConnectedDevice,
    setDogState,
    llmStatus,
    dogProfile,
    resetOnboarding,
    clearMessages,
    setIsGenerating,
  } = useDogStore();

  // ── Restart chat ──────────────────────────────────────────────────────────
  // Clears the conversation and anything in flight: a stuck "generating"
  // flag, queued collar speech, a half-captured utterance, and the Realtime
  // session's context (reconnected empty when it's in use).
  const handleRestartChat = () => {
    Alert.alert('Restart chat?', 'Clears the conversation and resets the dog.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restart',
        style: 'destructive',
        onPress: () => {
          collarSpeaker.cancel();
          collarVoiceService.holdOff(500);
          clearMessages();
          setIsGenerating(false);
          setDogState('idle');
          const { settings: st, hasCompletedOnboarding } = useDogStore.getState();
          if (st.modelProvider === 'backend' && realtimeService.isConnected && hasCompletedOnboarding) {
            realtimeService
              .connect(st.backendUrl, useDogStore.getState().dogProfile, [])
              .catch(e => console.warn('[Settings] restart reconnect failed:', e));
          }
          console.log('[Settings] chat restarted');
        },
      },
    ]);
  };

  const [lastCapture, setLastCapture] = useState<string | null>(null);
  const [debugLines, setDebugLines] = useState<string[]>(() => getDebugLines());
  useEffect(() => subscribeDebugLog(() => setDebugLines(getDebugLines())), []);
  // Local draft for the backend URL so we only commit to the store (and
  // trigger a reconnect) when the user finishes typing, not on every keystroke.
  const [urlDraft, setUrlDraft] = useState(settings.backendUrl);

  // ── Collar data feed ─────────────────────────────────────────────────────
  const [lastMems, setLastMems] = useState<MemsData | null>(null);
  const [lastTrigger, setLastTrigger] = useState<{ trigger: CollarTrigger; ts: number } | null>(null);
  const [lastFrame, setLastFrame] = useState<{ uri: string; ts: number } | null>(null);
  const memsRateRef = useRef<{ count: number; since: number }>({ count: 0, since: Date.now() });
  const [memsHz, setMemsHz] = useState(0);

  useEffect(() => {
    const prevOnMems = bluetoothService.onMems;
    const prevOnTrigger = bluetoothService.onTrigger;
    const prevOnCameraFrame = bluetoothService.onCameraFrame;

    bluetoothService.onMems = (data) => {
      prevOnMems?.(data);
      setLastMems(data);
      const r = memsRateRef.current;
      r.count++;
      const elapsed = (Date.now() - r.since) / 1000;
      if (elapsed >= 1) {
        setMemsHz(Math.round(r.count / elapsed));
        r.count = 0;
        r.since = Date.now();
      }
    };

    bluetoothService.onTrigger = (trigger) => {
      prevOnTrigger?.(trigger);
      setLastTrigger({ trigger, ts: Date.now() });
    };

    bluetoothService.onCameraFrame = (eventType, jpeg) => {
      prevOnCameraFrame?.(eventType, jpeg);
      const b64 = btoa(String.fromCharCode(...jpeg));
      setLastFrame({ uri: `data:image/jpeg;base64,${b64}`, ts: Date.now() });
    };

    return () => {
      bluetoothService.onMems = prevOnMems;
      bluetoothService.onTrigger = prevOnTrigger;
      bluetoothService.onCameraFrame = prevOnCameraFrame;
    };
  }, []);

  const isConnected = bleStatus === 'connected';

  // ── Audio ────────────────────────────────────────────────────────────────

  const handleTestAudio = async () => {
    const sample =
      "Woof! This is your dog speaking — testing the " +
      (settings.audioOutput === 'phone' ? 'phone speaker.' : 'collar speaker.');
    try {
      if (settings.audioOutput === 'collar') {
        if (!bluetoothService.isConnected) {
          Alert.alert(
            'Collar not connected',
            'Connect (or simulate) the collar before testing audio over BLE.',
          );
          return;
        }
        await audioService.streamToCollar(sample, {
          backendUrl: settings.backendUrl,
          voiceStyle: dogProfile.voiceStyle,
        });
        return;
      }

      // Phone speaker. Real responses play through the WebRTC remote audio
      // track, and the WebRTC audio session silences AVSpeechSynthesizer — so
      // trigger the realtime session to speak the sample instead of using
      // local TTS. Fall back to local TTS only if the session isn't up yet.
      if (realtimeService.isConnected) {
        const ok = realtimeService.sendTestUtterance(sample);
        if (ok) return;
      }
      await audioService.speak(sample);
    } catch (e) {
      console.warn('[Settings] test audio failed:', e);
      Alert.alert(
        'Test audio failed',
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  // ── Realtime session ─────────────────────────────────────────────────────

  // Manual reconnect. RealtimeService also auto-reconnects with backoff after
  // unintentional drops; this button is the user-visible escape hatch when
  // the session is stuck in 'offline' or 'error'.
  const handleReconnect = async () => {
    try {
      const { messages } = useDogStore.getState();
      await realtimeService.connect(settings.backendUrl, dogProfile, messages.slice(-10));
    } catch (e) {
      console.warn('[Settings] reconnect failed:', e);
      Alert.alert(
        'Reconnect failed',
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  // ── Camera ───────────────────────────────────────────────────────────────

  const handleTestCapture = async () => {
    if (settings.cameraSource === 'phone') {
      const choice = await askCameraOrLibrary();
      if (!choice) return;

      const tryCapture = (useFallback = false) => {
        const launcher = (!useFallback && choice === 'camera') ? launchCamera : launchImageLibrary;
        launcher({ mediaType: 'photo', quality: 0.6, includeBase64: false }, res => {
          if (res.didCancel) return;
          if (res.errorCode === 'camera_unavailable' && !useFallback) {
            // Simulator has no camera — quietly fall back to the photo library
            tryCapture(true);
            return;
          }
          if (res.errorCode) {
            Alert.alert('Capture failed', res.errorMessage ?? res.errorCode);
            return;
          }
          const uri = res.assets?.[0]?.uri ?? null;
          if (uri) setLastCapture(uri);
        });
      };
      tryCapture();
    } else {
      Alert.alert(
        'Collar camera not wired up',
        'The chip-side camera capture pipeline is not implemented yet. Switch to "Phone" to capture a frame from the device for testing.',
      );
    }
  };

  // ── BLE simulator ────────────────────────────────────────────────────────

  const handleToggleSimulatedCollar = (next: boolean) => {
    updateSettings({ simulateCollar: next });
    if (next) {
      setBleStatus('connected');
      setConnectedDevice('SimulatedCollar');
    } else {
      bluetoothService.simulateDisconnect();
      setBleStatus('idle');
      setConnectedDevice(null);
      setDogState('idle');
    }
  };

  const handleResetOnboarding = () => {
    Alert.alert(
      'Reset onboarding?',
      'This clears your dog profile, chat history, and app settings, like the first time you opened the app. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            realtimeService.disconnect();
            bluetoothService.disconnect();
            bluetoothService.simulateDisconnect();
            resetOnboarding();
            appAttestService.setBackendUrl(useDogStore.getState().settings.backendUrl);
          },
        },
      ],
    );
  };

  const handleFireTrigger = (trigger: CollarTrigger) => {
    if (!settings.simulateCollar && !isConnected) {
      Alert.alert(
        'Not connected',
        'Toggle "Simulated collar" on, or connect a real collar first.',
      );
      return;
    }
    bluetoothService.simulateTrigger(trigger);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>Developer & debug tools</Text>
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* ── AI model ──────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Cloud AI"
            subtitle="Dog responses stream from the hosted Realtime API."
          />
          <View style={styles.statusPill}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor:
                    llmStatus === 'ready'
                      ? COLORS.success
                      : llmStatus === 'loading'
                      ? COLORS.warning
                      : llmStatus === 'error'
                      ? COLORS.error
                      : COLORS.textMuted,
                },
              ]}
            />
            <Text style={styles.statusPillText}>
              {llmStatus === 'ready'
                ? 'Connected'
                : llmStatus === 'loading'
                ? 'Connecting…'
                : llmStatus === 'generating'
                ? 'Generating…'
                : llmStatus === 'error'
                ? 'Error'
                : 'Offline'}
            </Text>
          </View>
          <Pressable
            onPress={handleReconnect}
            disabled={llmStatus === 'loading'}
            style={[styles.actionBtn, llmStatus === 'loading' && styles.actionBtnDisabled]}>
            <Text style={styles.actionBtnText}>
              {llmStatus === 'ready' ? 'Reconnect session' : 'Reconnect now'}
            </Text>
          </Pressable>
          <Text style={styles.fieldLabel}>Backend URL (override)</Text>
          <TextInput
            style={styles.input}
            value={urlDraft}
            onChangeText={setUrlDraft}
            onBlur={() => {
              if (urlDraft !== settings.backendUrl) {
                updateSettings({ backendUrl: urlDraft });
              }
            }}
            placeholder="https://api.talkingdog.example"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Hint>
            API keys for any third-party LLM live on your server, never in the app —
            ship a tiny proxy backend that calls OpenAI/Anthropic/etc. with the secret
            key and forwards the response. Reconnects retry automatically with backoff
            after a drop; tap "Reconnect now" to force a fresh session.
          </Hint>
        </Card>

        {/* ── Audio routing ─────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Audio output" subtitle="Where dog speech is played." />
          <Segmented<AudioOutput>
            value={settings.audioOutput}
            options={[
              { value: 'phone', label: '📱 Phone' },
              { value: 'collar', label: '🎙️ Collar' },
            ]}
            onChange={v => updateSettings({ audioOutput: v })}
          />
          <Pressable onPress={handleTestAudio} style={styles.actionBtn}>
            <Text style={styles.actionBtnText}>Test audio output</Text>
          </Pressable>
          {settings.audioOutput === 'collar' && (
            <Hint>
              Replies are synthesized by the backend as 8 kHz μ-law and streamed to the collar
              speaker over BLE. The phone stays silent for the dog's voice.
            </Hint>
          )}
        </Card>

        {/* ── Live video ────────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Live video" subtitle="Let your dog see through the phone." />
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Live video on the Talk screen</Text>
              <Text style={styles.toggleSub}>
                The camera preview fills the screen and three frames from the last 5 seconds are
                sent with every message so the dog can react to what it sees.
              </Text>
            </View>
            <ToggleSwitch
              value={settings.liveVideoEnabled}
              onChange={v => updateSettings({ liveVideoEnabled: v })}
            />
          </View>
          {settings.liveVideoEnabled && (
            <Segmented<'back' | 'front'>
              value={settings.liveVideoCamera}
              options={[
                { value: 'back', label: '📷 Back camera' },
                { value: 'front', label: '🤳 Front camera' },
              ]}
              onChange={v => updateSettings({ liveVideoCamera: v })}
            />
          )}
          <Hint>
            Frames are small (about 640×480 JPEG) and only leave the phone when a message is
            generated. Uses more battery while on; the 📹 button on the Talk screen toggles it too.
          </Hint>
        </Card>

        {/* ── Collar microphone ─────────────────────────────────────── */}
        <Card>
          <CardHeader title="Collar microphone" subtitle="Let the dog hear you through the collar." />
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Listen through the collar</Text>
              <Text style={styles.toggleSub}>
                Speech picked up by the collar mic is transcribed and sent to the chat as if you
                typed it. Paused while the dog is talking or thinking.
              </Text>
            </View>
            <ToggleSwitch
              value={settings.collarMicInput}
              onChange={v => updateSettings({ collarMicInput: v })}
            />
          </View>
          <Hint>
            Needs a collar with a microphone (XIAO nRF54L15 Sense) and Audio output set to Collar,
            so the dog can't hear itself. The mic only streams while this is on and the collar is connected.
          </Hint>
        </Card>

        {/* ── Diagnostics ───────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Diagnostics" subtitle="Recent app log (newest at the bottom)." />
          <ScrollView style={styles.logBox} nestedScrollEnabled>
            {debugLines.length === 0 ? (
              <Text style={styles.logLine}>No log lines yet.</Text>
            ) : (
              debugLines.slice(-60).map((l, i) => (
                <Text key={i} style={[styles.logLine, l.includes('✖') && styles.logErr, l.includes('⚠') && styles.logWarn]} selectable>
                  {l}
                </Text>
              ))
            )}
          </ScrollView>
          <Pressable onPress={() => clearDebugLines()} style={styles.actionBtn}>
            <Text style={styles.actionBtnText}>Clear log</Text>
          </Pressable>
        </Card>

        {/* ── Conversation ──────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Conversation" subtitle="Start over with a clean slate." />
          <Pressable onPress={handleRestartChat} style={styles.actionBtn}>
            <Text style={styles.actionBtnText}>Restart chat</Text>
          </Pressable>
          <Hint>
            Clears the message history and cancels anything the dog is in the middle of saying or
            thinking. Use it if the dog stops responding.
          </Hint>
        </Card>

        {/* ── Collar motion triggers ────────────────────────────────── */}
        <Card>
          <CardHeader title="Collar motion" subtitle="Let the dog speak up when it moves." />
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>React to motion events</Text>
              <Text style={styles.toggleSub}>
                Wag, excited, alert and sleepy events from the collar's IMU start a dog message.
              </Text>
            </View>
            <ToggleSwitch
              value={settings.collarTriggersEnabled}
              onChange={v => updateSettings({ collarTriggersEnabled: v })}
            />
          </View>
          {settings.collarTriggersEnabled && (
            <>
              <Text style={styles.fieldLabel}>Minimum time between self-started messages</Text>
              <Segmented<number>
                value={settings.collarTriggerCooldownSec}
                options={[
                  { value: 15, label: '15 s' },
                  { value: 60, label: '1 min' },
                  { value: 300, label: '5 min' },
                ]}
                onChange={v => updateSettings({ collarTriggerCooldownSec: v })}
              />
            </>
          )}
        </Card>

        {/* ── Camera source ─────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Vision input" subtitle="Send a photo with each dog response." />
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Enable camera vision</Text>
              <Text style={styles.toggleSub}>
                Attach a photo when the dog speaks — from the collar trigger or when you send a message.
              </Text>
            </View>
            <ToggleSwitch
              value={settings.cameraEnabled}
              onChange={v => updateSettings({ cameraEnabled: v })}
            />
          </View>
          {settings.cameraEnabled && (
            <>
              <Segmented<CameraSource>
                value={settings.cameraSource}
                options={[
                  { value: 'phone', label: '📱 Phone' },
                  { value: 'collar', label: '📷 Collar' },
                ]}
                onChange={v => updateSettings({ cameraSource: v })}
              />
              <Pressable onPress={handleTestCapture} style={styles.actionBtn}>
                <Text style={styles.actionBtnText}>Test capture</Text>
              </Pressable>
              {lastCapture && (
                <View style={styles.capturePreview}>
                  <Image source={{ uri: lastCapture }} style={styles.captureImage} />
                  <Text style={styles.captureCaption}>Last frame</Text>
                </View>
              )}
              <Hint>
                Phone: tap the 📷 button on the Talk tab to attach a photo, or the camera will open
                automatically when the collar fires a trigger. Collar: uses the latest JPEG frame
                streamed over BLE.
              </Hint>
            </>
          )}
        </Card>

        {/* ── BLE simulator ─────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="BLE simulator"
            subtitle="The iOS Simulator can't talk to real Bluetooth peripherals."
          />
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Fake a connected collar</Text>
              <Text style={styles.toggleSub}>
                Forces BLE status to "connected" so you can run the full app loop without hardware.
              </Text>
            </View>
            <ToggleSwitch
              value={settings.simulateCollar}
              onChange={handleToggleSimulatedCollar}
            />
          </View>

          <BleStatusPill status={bleStatus} simulated={settings.simulateCollar} />

          <Text style={styles.fieldLabel}>Inject collar triggers</Text>
          <View style={styles.triggerGrid}>
            {COLLAR_TRIGGERS.map(t => (
              <Pressable
                key={t.trigger}
                onPress={() => handleFireTrigger(t.trigger)}
                style={styles.triggerChip}>
                <Text style={styles.triggerEmoji}>{t.emoji}</Text>
                <Text style={styles.triggerLabel}>{t.label}</Text>
              </Pressable>
            ))}
          </View>

          <Hint>
            Tip: trigger buttons fire through the same callback path real BLE notifications
            would. Open the Talk tab to see the dog react.
          </Hint>
        </Card>

        {/* ── Collar data feed ──────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Collar data feed"
            subtitle="Live sensor readings from the connected collar."
          />

          {/* MEMS */}
          <Text style={styles.fieldLabel}>IMU — accel / gyro {memsHz > 0 ? `(${memsHz} Hz)` : ''}</Text>
          {lastMems ? (
            <View style={styles.memsGrid}>
              {(
                [
                  ['ax', lastMems.ax],
                  ['ay', lastMems.ay],
                  ['az', lastMems.az],
                  ['gx', lastMems.gx],
                  ['gy', lastMems.gy],
                  ['gz', lastMems.gz],
                ] as [string, number][]
              ).map(([label, val]) => (
                <View key={label} style={styles.memsCell}>
                  <Text style={styles.memsCellLabel}>{label}</Text>
                  <Text style={styles.memsCellValue}>{val > 0 ? '+' : ''}{val}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.feedEmpty}>No MEMS data yet — connect the collar.</Text>
          )}

          {/* Trigger */}
          <Text style={styles.fieldLabel}>Last trigger</Text>
          {lastTrigger ? (
            <View style={styles.triggerRow}>
              <Text style={styles.triggerBadge}>
                {COLLAR_TRIGGERS.find(t => t.trigger === lastTrigger.trigger)?.emoji ?? '?'}{' '}
                {COLLAR_TRIGGERS.find(t => t.trigger === lastTrigger.trigger)?.label ?? `0x${lastTrigger.trigger.toString(16)}`}
              </Text>
              <Text style={styles.feedTs}>{new Date(lastTrigger.ts).toLocaleTimeString()}</Text>
            </View>
          ) : (
            <Text style={styles.feedEmpty}>No trigger received yet.</Text>
          )}

          {/* Camera frame */}
          <Text style={styles.fieldLabel}>Last camera frame</Text>
          {lastFrame ? (
            <View style={styles.capturePreview}>
              <Image source={{ uri: lastFrame.uri }} style={styles.captureImage} />
              <Text style={styles.captureCaption}>{new Date(lastFrame.ts).toLocaleTimeString()}</Text>
            </View>
          ) : (
            <Text style={styles.feedEmpty}>No frame received yet.</Text>
          )}
        </Card>

        {/* ── Onboarding reset ─────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Start over"
            subtitle="Run setup from the beginning with a clean profile and settings."
          />
          <Pressable onPress={handleResetOnboarding} style={styles.dangerBtn}>
            <Text style={styles.dangerBtnText}>Reset onboarding</Text>
          </Pressable>
        </Card>

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function CardHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardSubtitle}>{subtitle}</Text>
    </View>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.hintBox}>
      <Text style={styles.hintText}>{children}</Text>
    </View>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map(opt => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={[styles.segment, selected && styles.segmentSelected]}>
            <Text style={[styles.segmentLabel, selected && styles.segmentLabelSelected]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ToggleSwitch({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      style={[styles.toggle, value && styles.toggleOn]}>
      <View style={[styles.toggleKnob, value && styles.toggleKnobOn]} />
    </Pressable>
  );
}

function BleStatusPill({
  status,
  simulated,
}: {
  status: BleStatus;
  simulated: boolean;
}) {
  const color = STATUS_COLORS[status] ?? COLORS.textMuted;
  const label = simulated && status === 'connected' ? 'Connected (simulated)' : status;
  return (
    <View style={styles.statusPill}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <Text style={styles.statusPillText}>{label}</Text>
    </View>
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function askCameraOrLibrary(): Promise<'camera' | 'library' | null> {
  return new Promise(resolve => {
    Alert.alert(
      'Capture from…',
      'The iOS Simulator has no camera, so pick "Library" when running there.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
        { text: 'Camera', onPress: () => resolve('camera') },
        { text: 'Library', onPress: () => resolve('library') },
      ],
    );
  });
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  logBox: {
    maxHeight: 260,
    backgroundColor: '#111',
    borderRadius: 10,
    padding: 8,
    marginBottom: 8,
  },
  logLine: {
    color: '#cfd8dc',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 2,
  },
  logWarn: { color: '#ffd54f' },
  logErr: { color: '#ff8a80' },
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  title: {
    fontSize: 28,
    fontFamily: HEADING_FONT_FAMILY,
    fontWeight: '700',
    color: COLORS.text,
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 13, color: COLORS.textMuted, marginTop: 2 },
  input: {
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: 14,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  scrollView: { flex: 1 },
  scroll: { padding: SPACING.lg, gap: SPACING.md, paddingBottom: SPACING.xxl },

  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.sm,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  cardSubtitle: { fontSize: 12, color: COLORS.textMuted },

  segmented: {
    flexDirection: 'row',
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.full,
    padding: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  segment: {
    flex: 1,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    borderRadius: RADIUS.full,
  },
  segmentSelected: { backgroundColor: COLORS.accentSoft },
  segmentLabel: { fontSize: 13, fontWeight: '600', color: COLORS.textSecondary },
  segmentLabelSelected: { color: COLORS.accent },

  actionBtn: {
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  actionBtnDisabled: { opacity: 0.5 },
  actionBtnText: { color: COLORS.text, fontSize: 13, fontWeight: '700' },

  dangerBtn: {
    backgroundColor: 'rgba(220, 38, 38, 0.08)',
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(220, 38, 38, 0.35)',
  },
  dangerBtnText: { color: COLORS.error, fontSize: 13, fontWeight: '700' },

  hintBox: {
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.md,
    padding: SPACING.sm,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.primary,
  },
  hintText: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 17 },

  capturePreview: { alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.xs },
  captureImage: {
    width: 140,
    height: 140,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  captureCaption: { color: COLORS.textMuted, fontSize: 11 },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  toggleLabel: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  toggleSub: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },
  toggle: {
    width: 50,
    height: 30,
    borderRadius: 15,
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 3,
    justifyContent: 'center',
  },
  toggleOn: { backgroundColor: COLORS.accentSoft, borderColor: COLORS.accent },
  toggleKnob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.textMuted,
  },
  toggleKnobOn: {
    backgroundColor: COLORS.accent,
    transform: [{ translateX: 20 }],
  },

  statusPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.surfaceElevated,
    paddingHorizontal: SPACING.md,
    paddingVertical: 6,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusPillText: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary },

  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: SPACING.xs,
  },
  memsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  memsCell: {
    width: '30%',
    flexGrow: 1,
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 2,
  },
  memsCellLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  memsCellValue: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.text,
    fontVariant: ['tabular-nums'],
  },
  triggerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  triggerBadge: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
  },
  feedTs: {
    fontSize: 11,
    color: COLORS.textMuted,
    fontVariant: ['tabular-nums'],
  },
  feedEmpty: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontStyle: 'italic',
  },
  triggerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  triggerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  triggerEmoji: { fontSize: 14 },
  triggerLabel: { color: COLORS.text, fontSize: 12, fontWeight: '600' },
});
