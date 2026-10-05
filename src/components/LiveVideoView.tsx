/**
 * LiveVideoView — full-bleed camera preview for the Talk screen that also
 * feeds LiveVideoService with a small JPEG snapshot every ~1.2 s.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
} from 'react-native-vision-camera';
import RNFS from 'react-native-fs';
import { CAPTURE_INTERVAL_MS, liveVideoService } from '../services/LiveVideoService';
import { COLORS, RADIUS, SPACING } from './theme';

interface Props {
  position: 'back' | 'front';
  onFlip: () => void;
  onClose: () => void;
  /** Rendered on top of the preview (e.g. the last few chat bubbles). */
  children?: React.ReactNode;
}

export function LiveVideoView({ position, onFlip, onClose, children }: Props) {
  const camera = useRef<Camera>(null);
  const device = useCameraDevice(position);
  // Small preview resolution keeps snapshots ~30–60 kB each.
  const format = useCameraFormat(device, [{ videoResolution: { width: 640, height: 480 } }]);
  const { hasPermission, requestPermission } = useCameraPermission();
  const [frames, setFrames] = useState(0);

  useEffect(() => {
    if (!hasPermission) requestPermission().catch(() => {});
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    liveVideoService.setActive(true);
    let stopped = false;
    let busy = false;
    const timer = setInterval(async () => {
      if (stopped || busy || !camera.current) return;
      busy = true;
      try {
        const snap = await camera.current.takeSnapshot({ quality: 55 });
        const path = snap.path.startsWith('file://') ? snap.path.slice(7) : snap.path;
        const b64 = await RNFS.readFile(path, 'base64');
        RNFS.unlink(path).catch(() => {});
        if (!stopped) {
          liveVideoService.pushFrame(b64);
          setFrames(liveVideoService.frameCount);
        }
      } catch (e) {
        // Camera not ready yet (first second) — just try again next tick.
      } finally {
        busy = false;
      }
    }, CAPTURE_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      liveVideoService.setActive(false);
    };
  }, [position]);

  return (
    <View style={styles.container}>
      {device && hasPermission ? (
        <Camera
          ref={camera}
          style={StyleSheet.absoluteFill}
          device={device}
          format={format}
          isActive={true}
          video={true}
          audio={false}
          photo={false}
          enableZoomGesture={false}
        />
      ) : (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>
            {hasPermission ? 'No camera available' : 'Camera permission needed'}
          </Text>
          {!hasPermission && (
            <Pressable onPress={() => requestPermission()} style={styles.permBtn}>
              <Text style={styles.permBtnText}>Allow camera</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Top controls */}
      <View style={styles.topBar} pointerEvents="box-none">
        <View style={styles.liveBadge}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE · {frames} frames</Text>
        </View>
        <View style={styles.topButtons}>
          <Pressable onPress={onFlip} style={styles.iconBtn} hitSlop={8}>
            <Text style={styles.iconBtnText}>🔄</Text>
          </Pressable>
          <Pressable onPress={onClose} style={styles.iconBtn} hitSlop={8}>
            <Text style={styles.iconBtnText}>✕</Text>
          </Pressable>
        </View>
      </View>

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.md },
  placeholderText: { color: '#fff', opacity: 0.8 },
  permBtn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.full,
  },
  permBtnText: { color: '#fff', fontWeight: '600' },
  topBar: {
    position: 'absolute',
    top: SPACING.sm,
    left: SPACING.sm,
    right: SPACING.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ff3b30' },
  liveText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  topButtons: { flexDirection: 'row', gap: 8 },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: { color: '#fff', fontSize: 16 },
});
