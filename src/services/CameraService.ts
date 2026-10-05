import { launchCamera } from 'react-native-image-picker';

/**
 * CameraService manages photo capture from both the phone camera and the
 * collar's BLE camera stream.
 *
 * Phone capture uses react-native-image-picker's launchCamera, which opens
 * the native camera UI. The caller awaits the promise; it resolves with a
 * base64-encoded JPEG string (no data: prefix) or null if the user cancelled
 * or an error occurred.
 *
 * Collar capture is passive: BluetoothService calls setLastCollarFrame()
 * whenever a full JPEG frame arrives over the CHAR_CAMERA characteristic.
 * Callers read getLastCollarFrame() synchronously to get the most recent
 * available frame.
 */
class CameraService {
  private lastCollarFrame: string | null = null;

  /** Called by BluetoothService when a collar JPEG frame is fully assembled. */
  setLastCollarFrame(jpegBytes: Uint8Array) {
    this.lastCollarFrame = btoa(String.fromCharCode(...jpegBytes));
  }

  /** Returns the base64-encoded JPEG of the most recent collar frame, or null. */
  getLastCollarFrame(): string | null {
    return this.lastCollarFrame;
  }

  clearLastCollarFrame() {
    this.lastCollarFrame = null;
  }

  /**
   * Open the phone camera UI and return a base64-encoded JPEG string once the
   * user takes a photo. Returns null if the user cancels or the camera is
   * unavailable (e.g. in the iOS Simulator).
   */
  captureFromPhone(): Promise<string | null> {
    return new Promise(resolve => {
      launchCamera({ mediaType: 'photo', quality: 0.6, includeBase64: true }, res => {
        if (res.didCancel || res.errorCode) {
          resolve(null);
          return;
        }
        resolve(res.assets?.[0]?.base64 ?? null);
      });
    });
  }
}

export const cameraService = new CameraService();
