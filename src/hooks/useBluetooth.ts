import { useCallback, useEffect, useRef } from 'react';
import { Alert, Platform } from 'react-native';
import { PERMISSIONS, RESULTS, requestMultiple } from 'react-native-permissions';
import { useDogStore } from '../store/dogStore';
import { bluetoothService } from '../services/BluetoothService';
import { BluetoothService } from '../services/BluetoothService';
import { CollarTrigger, MemsData } from '../types';

const CONNECTION_TIMEOUT_MS = 15_000;

function showConnectionTimeoutAlert(phase: 'scanning' | 'connecting') {
  const scanTips = [
    '• Collar is powered on and within ~1m',
    '• SERVICE_UUID in config.h matches the app (12345678-1234-1234-1234-1234567890AB)',
    '• Collar is not already connected to another phone — power-cycle it to clear the pairing',
    '• Bluetooth is enabled and the app has permission in iOS Settings → Privacy → Bluetooth',
    '• Check the console for [BLE] logs — if no device appears at all, the service UUID filter may be wrong',
  ];
  const connectTips = [
    '• The collar is advertising but not accepting the connection — try power-cycling it',
    '• Another device may already hold the BLE connection',
    '• The ESP32 watchdog may have crashed — check the serial monitor',
    '• If connect() logged a timeout, the MTU negotiation may have stalled — try reducing requestMTU',
  ];
  Alert.alert(
    phase === 'scanning' ? 'Still scanning…' : 'Still connecting…',
    `No collar ${phase === 'scanning' ? 'found' : 'connected'} after ${CONNECTION_TIMEOUT_MS / 1000}s.\n\n${
      (phase === 'scanning' ? scanTips : connectTips).join('\n')
    }`,
    [{ text: 'OK' }],
  );
}

interface UseBluetoothOptions {
  onTrigger?: (trigger: CollarTrigger) => void;
  onMems?: (data: MemsData) => void;
}

export function useBluetooth({ onTrigger, onMems }: UseBluetoothOptions = {}) {
  const { setBleStatus, setConnectedDevice, setDogState, setLastMemsData } = useDogStore();
  const lastMemsStoreWriteRef = useRef(0);
  const memsWindowRef = useRef<MemsData[]>([]);
  const lastAutonomousAtRef = useRef(0);
  const lastTriggerRef = useRef<CollarTrigger | null>(null);
  const autoRoutedRef = useRef(false);

  // Motion events make the dog speak on its own, so they are rate-limited:
  // the collar's own detector fires every ~800 ms while the dog moves, which
  // would otherwise turn into one response after another.
  const gateTrigger = (trigger: CollarTrigger, source: 'collar' | 'phone') => {
    const { settings, isGenerating } = useDogStore.getState();
    if (!settings.collarTriggersEnabled) return;
    if (isGenerating || bluetoothService.isStreamingAudio) return;
    const now = Date.now();
    const cooldownMs = Math.max(5, settings.collarTriggerCooldownSec) * 1000;
    const sinceLast = now - lastAutonomousAtRef.current;
    if (sinceLast < cooldownMs) {
      return;
    }
    // Repeating the same state (still sleeping, still wagging) isn't news.
    if (trigger === lastTriggerRef.current && sinceLast < cooldownMs * 3) {
      return;
    }
    lastAutonomousAtRef.current = now;
    lastTriggerRef.current = trigger;
    console.log(`[BLE] motion trigger 0x${trigger.toString(16)} from ${source} → dog speaks`);
    onTrigger?.(trigger);
  };

  // Wire up service callbacks on mount
  useEffect(() => {
    bluetoothService.onTrigger = (trigger: CollarTrigger) => {
      gateTrigger(trigger, 'collar');
    };

    bluetoothService.onMems = (data: MemsData) => {
      // MEMS arrives at 50 Hz. Writing every packet to the global store made
      // every screen re-render 50×/s (they subscribe to the whole store), which
      // is what made taps laggy. Keep the live value on the service and only
      // mirror it into the store twice a second for anything that displays it.
      bluetoothService.lastMems = data;
      const now = Date.now();
      if (now - lastMemsStoreWriteRef.current >= 500) {
        lastMemsStoreWriteRef.current = now;
        setLastMemsData(data);
      }
      memsWindowRef.current = [...memsWindowRef.current.slice(-49), data];
      // The XIAO collar classifies motion itself and sends TRIGGER events, so
      // the phone-side classifier is only a fallback for collars without one
      // (the old ESP32 build). It ran 5×/s at 50 Hz and classified a collar
      // sitting on a desk as SLEEPING every time — hence the nonstop talking.
      if (!bluetoothService.hasMic && memsWindowRef.current.length % 50 === 0) {
        const inferred = BluetoothService.analyzeMemsWindow(memsWindowRef.current);
        if (inferred !== null) {
          gateTrigger(inferred, 'phone');
        }
      }
      onMems?.(data);
    };

    bluetoothService.onDisconnect = () => {
      setBleStatus('disconnected');
      setConnectedDevice(null);
      setDogState('idle');
      memsWindowRef.current = [];
    };

    return () => {
      bluetoothService.onTrigger = null;
      bluetoothService.onMems = null;
      bluetoothService.onDisconnect = null;
    };
  }, [onTrigger, onMems, setBleStatus, setConnectedDevice, setDogState, setLastMemsData]);

  const startScan = useCallback(async () => {
    // Android needs runtime BLE permissions before scanning returns anything
    // (iOS prompts by itself on first CoreBluetooth use).
    if (Platform.OS === 'android') {
      const wanted =
        Platform.Version >= 31
          ? [PERMISSIONS.ANDROID.BLUETOOTH_SCAN, PERMISSIONS.ANDROID.BLUETOOTH_CONNECT]
          : [PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION];
      const res = await requestMultiple(wanted);
      const denied = wanted.filter(p => res[p] !== RESULTS.GRANTED);
      if (denied.length) {
        Alert.alert(
          'Bluetooth permission needed',
          'Allow Bluetooth (and Location on Android 11 or older) in Settings to find the collar.',
        );
        setBleStatus('error');
        return;
      }
    }

    setBleStatus('scanning');
    let phase: 'scanning' | 'connecting' = 'scanning';

    const timeoutId = setTimeout(() => {
      showConnectionTimeoutAlert(phase);
    }, CONNECTION_TIMEOUT_MS);

    try {
      const device = await bluetoothService.scanAndConnect(name => {
        phase = 'connecting';
        setBleStatus('connecting');
        setConnectedDevice(name);
      });
      clearTimeout(timeoutId);
      setBleStatus('connected');
      setConnectedDevice(device.name ?? device.id);
      lastAutonomousAtRef.current = Date.now(); // no "hello" burst right after connecting

      // A collar with a speaker + mic (XIAO build) is the natural audio device:
      // route dog speech to it the first time it connects this app session.
      const { settings, updateSettings } = useDogStore.getState();
      if (bluetoothService.hasMic && settings.audioOutput !== 'collar' && !autoRoutedRef.current) {
        autoRoutedRef.current = true;
        console.log('[BLE] XIAO collar connected — switching audio output to collar');
        updateSettings({ audioOutput: 'collar' });
      }
    } catch {
      clearTimeout(timeoutId);
      setBleStatus('error');
    }
  }, [setBleStatus, setConnectedDevice]);

  const disconnect = useCallback(() => {
    bluetoothService.disconnect();
    setBleStatus('idle');
    setConnectedDevice(null);
  }, [setBleStatus, setConnectedDevice]);

  return { startScan, disconnect, isConnected: bluetoothService.isConnected };
}
