/**
 * The model writes delivery cues for the voice ("[excited] Walk time!!!").
 * The TTS engine consumes them; the chat should not show them.
 */
const TAG_RE = /\[[a-z][a-z ,'-]{1,30}\]\s?/gi;

export function stripAudioTags(text: string): string {
  return text.replace(TAG_RE, '').replace(/\s{2,}/g, ' ').trim();
}
