/**
 * CollarSpeaker — speaks a streaming LLM reply through the collar sentence by
 * sentence, so the dog starts talking while the model is still writing.
 *
 *   onDelta(token)  → buffers text; each completed sentence is sent to TTS
 *                     immediately (requests run concurrently) and queued to
 *                     play in order.
 *   onDone(full)    → flushes the tail; also handles non-streamed replies.
 */
import { bluetoothService } from './BluetoothService';
import { AudioService } from './AudioService';

const MIN_SENTENCE_CHARS = 12;      // merge tiny fragments ("Oh!") with the next one
const SENTENCE_END = /[.!?…]+["')\]]*\s+/;

type Opts = { backendUrl?: string; voiceStyle?: string };

class CollarSpeaker {
  private pending = '';
  private spokenChars = 0;
  private generation = 0;
  private playChain: Promise<void> = Promise.resolve();
  private opts: Opts = {};

  /** Call at the start of each reply. */
  begin(opts: Opts) {
    this.generation++;
    this.pending = '';
    this.spokenChars = 0;
    this.opts = opts;
  }

  onDelta(delta: string) {
    this.pending += delta;
    this.flushSentences(false);
  }

  onDone(fullText: string) {
    // If we never saw deltas (on-device path, or a non-streamed reply), speak
    // the whole thing; otherwise just the tail that hasn't been sent yet.
    if (this.spokenChars === 0 && this.pending.length === 0) {
      this.pending = fullText;
    }
    this.flushSentences(true);
  }

  /** Drop anything not yet sent (new reply started, disconnect, etc.). */
  cancel() {
    this.generation++;
    this.pending = '';
  }

  private flushSentences(final: boolean) {
    // Take complete sentences off the front; a short one ("Ball?") is merged
    // with the following sentence(s) until the piece is long enough to be
    // worth a TTS call, so quick-fire questions stay in order and in rhythm.
    for (;;) {
      let cut = 0;
      let searchFrom = 0;
      for (;;) {
        const m = SENTENCE_END.exec(this.pending.slice(searchFrom));
        if (!m) break;
        cut = searchFrom + m.index + m[0].length;
        if (cut >= MIN_SENTENCE_CHARS) break;
        searchFrom = cut;
      }
      if (cut === 0 || (cut < MIN_SENTENCE_CHARS && !final)) break;
      const piece = this.pending.slice(0, cut).trim();
      this.pending = this.pending.slice(cut);
      this.enqueue(piece);
    }
    if (final) {
      const tail = this.pending.trim();
      this.pending = '';
      if (tail) this.enqueue(tail);
    }
  }

  private enqueue(text: string) {
    if (!text || !bluetoothService.isConnected) return;
    const gen = this.generation;
    this.spokenChars += text.length;
    // Start synthesis right away; playback waits its turn in the chain.
    const audio = AudioService.fetchCollarSpeech(text, this.opts).catch(e => {
      console.warn('[CollarSpeaker] TTS failed:', e);
      return null;
    });
    this.playChain = this.playChain.then(async () => {
      const clip = await audio;
      if (!clip || gen !== this.generation || !bluetoothService.isConnected) return;
      try {
        await bluetoothService.streamAudio(clip.bytes, { format: clip.format });
      } catch (e) {
        console.warn('[CollarSpeaker] stream failed:', e);
      }
    });
  }
}

export const collarSpeaker = new CollarSpeaker();
