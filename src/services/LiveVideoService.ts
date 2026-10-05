/**
 * LiveVideoService — a short rolling buffer of frames from the phone camera.
 *
 * LiveVideoView (the preview on the Talk screen) captures a small JPEG every
 * CAPTURE_INTERVAL_MS while live video is on and pushes it here. When a
 * message is generated, getRecentFrames() returns up to 3 frames spread
 * across the last 5 seconds (oldest first) to attach to the request.
 */

export const CAPTURE_INTERVAL_MS = 1200;
const WINDOW_MS = 5000;
const MAX_FRAMES = 3;
const KEEP_MS = 8000;

interface Frame {
  ts: number;
  base64: string; // JPEG, no data: prefix
}

class LiveVideoService {
  private frames: Frame[] = [];
  private _active = false;

  get isActive() {
    return this._active;
  }

  setActive(active: boolean) {
    this._active = active;
    if (!active) this.frames = [];
  }

  pushFrame(base64: string) {
    const now = Date.now();
    this.frames.push({ ts: now, base64 });
    this.frames = this.frames.filter(f => now - f.ts <= KEEP_MS);
  }

  get frameCount() {
    return this.frames.length;
  }

  /**
   * Up to MAX_FRAMES frames from the last WINDOW_MS, oldest first, spread as
   * evenly as the buffer allows (e.g. -5 s, -2.5 s, now).
   */
  getRecentFrames(): string[] {
    const now = Date.now();
    const recent = this.frames.filter(f => now - f.ts <= WINDOW_MS);
    if (recent.length === 0) return [];
    if (recent.length <= MAX_FRAMES) return recent.map(f => f.base64);
    const picked: Frame[] = [];
    for (let i = 0; i < MAX_FRAMES; i++) {
      const idx = Math.round((i * (recent.length - 1)) / (MAX_FRAMES - 1));
      picked.push(recent[idx]!);
    }
    return picked.map(f => f.base64);
  }
}

export const liveVideoService = new LiveVideoService();
