/**
 * In-app log buffer. console.log/warn/error from JS don't reach the Xcode
 * console or the Metro terminal on RN ≥ 0.77 (only React Native DevTools),
 * so we keep the last N tagged lines ("[BLE] …", "[LLM] …") in memory and
 * show them in Settings → Diagnostics.
 */
type Listener = () => void;

const MAX_LINES = 150;
const lines: string[] = [];
const listeners = new Set<Listener>();
let installed = false;

function fmt(args: unknown[]): string {
  return args
    .map(a => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
}

function push(level: 'log' | 'warn' | 'error', args: unknown[]) {
  const text = fmt(args);
  if (!text.startsWith('[')) return; // only our tagged lines
  const t = new Date();
  const stamp = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  lines.push(`${stamp} ${level === 'log' ? '' : level === 'warn' ? '⚠ ' : '✖ '}${text}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  listeners.forEach(l => l());
}

export function installDebugLog() {
  if (installed) return;
  installed = true;
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { orig.log(...a); push('log', a); };
  console.warn = (...a: unknown[]) => { orig.warn(...a); push('warn', a); };
  console.error = (...a: unknown[]) => { orig.error(...a); push('error', a); };
  // Unhandled promise rejections are the usual way a reply silently dies.
  const g = globalThis as unknown as { HermesInternal?: unknown; onunhandledrejection?: unknown };
  try {
    const tracking = require('promise/setimmediate/rejection-tracking');
    tracking.enable({
      allRejections: true,
      onUnhandled: (_id: number, err: unknown) => push('error', ['[unhandled promise]', err]),
    });
  } catch { /* not available */ }
  void g;
}

export function getDebugLines(): string[] {
  return lines.slice();
}

export function clearDebugLines() {
  lines.length = 0;
  listeners.forEach(l => l());
}

export function subscribeDebugLog(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
