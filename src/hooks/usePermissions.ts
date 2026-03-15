/**
 * Requests all permissions the app needs on first launch.
 * Call this from the onboarding flow or App.tsx before starting BLE / audio.
 */
import { useCallback } from 'react';
import { Platform } from 'react-native';
import { check, request, PERMISSIONS, RESULTS } from 'react-native-permissions';

export type PermissionStatus = 'granted' | 'denied' | 'blocked' | 'unavailable';

export function usePermissions() {
  const requestAll = useCallback(async (): Promise<Record<string, PermissionStatus>> => {
    if (Platform.OS !== 'ios') return {};

    const results: Record<string, PermissionStatus> = {};

    const permissionsToRequest = [
      PERMISSIONS.IOS.BLUETOOTH,
      PERMISSIONS.IOS.MICROPHONE,
      PERMISSIONS.IOS.CAMERA,
      PERMISSIONS.IOS.PHOTO_LIBRARY,
    ];

    for (const permission of permissionsToRequest) {
      const status = await request(permission);
      results[permission] = mapResult(status);
    }

    return results;
  }, []);

  const checkBluetooth = useCallback(async (): Promise<PermissionStatus> => {
    if (Platform.OS !== 'ios') return 'granted';
    const status = await check(PERMISSIONS.IOS.BLUETOOTH);
    return mapResult(status);
  }, []);

  return { requestAll, checkBluetooth };
}

function mapResult(result: string): PermissionStatus {
  if (result === RESULTS.GRANTED) return 'granted';
  if (result === RESULTS.DENIED) return 'denied';
  if (result === RESULTS.BLOCKED) return 'blocked';
  return 'unavailable';
}
