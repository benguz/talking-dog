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
    const results: Record<string, PermissionStatus> = {};

    const permissionsToRequest =
      Platform.OS === 'ios'
        ? [
            PERMISSIONS.IOS.BLUETOOTH,
            PERMISSIONS.IOS.MICROPHONE,
            PERMISSIONS.IOS.CAMERA,
            PERMISSIONS.IOS.PHOTO_LIBRARY,
          ]
        : Platform.OS === 'android'
          ? [
              // Android 12+ (API 31): BLE scan/connect are runtime permissions.
              // Older Android: scanning needs fine location instead.
              ...(Platform.Version >= 31
                ? [PERMISSIONS.ANDROID.BLUETOOTH_SCAN, PERMISSIONS.ANDROID.BLUETOOTH_CONNECT]
                : [PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION]),
              PERMISSIONS.ANDROID.RECORD_AUDIO,
              PERMISSIONS.ANDROID.CAMERA,
            ]
          : [];

    for (const permission of permissionsToRequest) {
      const status = await request(permission);
      results[permission] = mapResult(status);
    }

    return results;
  }, []);

  const checkBluetooth = useCallback(async (): Promise<PermissionStatus> => {
    if (Platform.OS === 'ios') {
      return mapResult(await check(PERMISSIONS.IOS.BLUETOOTH));
    }
    if (Platform.OS === 'android') {
      const perm =
        Platform.Version >= 31
          ? PERMISSIONS.ANDROID.BLUETOOTH_SCAN
          : PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION;
      return mapResult(await check(perm));
    }
    return 'granted';
  }, []);

  return { requestAll, checkBluetooth };
}

function mapResult(result: string): PermissionStatus {
  if (result === RESULTS.GRANTED) return 'granted';
  if (result === RESULTS.DENIED) return 'denied';
  if (result === RESULTS.BLOCKED) return 'blocked';
  return 'unavailable';
}
