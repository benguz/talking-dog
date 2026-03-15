import { useCallback, useEffect, useRef } from 'react';
import { useDogStore } from '../store/dogStore';
import { bluetoothService } from '../services/BluetoothService';
import { BluetoothService } from '../services/BluetoothService';
import { CollarTrigger, MemsData } from '../types';

interface UseBluetoothOptions {
  onTrigger?: (trigger: CollarTrigger) => void;
  onMems?: (data: MemsData) => void;
}

export function useBluetooth({ onTrigger, onMems }: UseBluetoothOptions = {}) {
  const { setBleStatus, setConnectedDevice, setDogState, setLastMemsData } = useDogStore();
  const memsWindowRef = useRef<MemsData[]>([]);

  // Wire up service callbacks on mount
  useEffect(() => {
    bluetoothService.onTrigger = (trigger: CollarTrigger) => {
      onTrigger?.(trigger);
    };

    bluetoothService.onMems = (data: MemsData) => {
      setLastMemsData(data);
      memsWindowRef.current = [...memsWindowRef.current.slice(-49), data];

      // Run MEMS analysis every 10 samples (~1s at 10Hz)
      if (memsWindowRef.current.length % 10 === 0) {
        const inferred = BluetoothService.analyzeMemsWindow(memsWindowRef.current);
        if (inferred !== null) {
          onTrigger?.(inferred);
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
    setBleStatus('scanning');
    try {
      const device = await bluetoothService.scanAndConnect(name => {
        setBleStatus('connecting');
        setConnectedDevice(name);
      });
      setBleStatus('connected');
      setConnectedDevice(device.name ?? device.id);
    } catch {
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
