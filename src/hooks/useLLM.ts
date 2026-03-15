import { useCallback } from 'react';
import { useDogStore } from '../store/dogStore';
import { llmService } from '../services/LLMService';
import { LLMService } from '../services/LLMService';
import { audioService } from '../services/AudioService';
import { bluetoothService } from '../services/BluetoothService';
import { CollarTrigger, ManualTrigger, ChatMessage } from '../types';

export function useLLM() {
  const {
    dogProfile,
    messages,
    addMessage,
    setIsGenerating,
    setDogState,
    isGenerating,
    llmStatus,
  } = useDogStore();

  const generateResponse = useCallback(
    async (trigger: CollarTrigger | ManualTrigger) => {
      if (isGenerating) return;
      if (!llmService.isReady) return;

      setIsGenerating(true);
      setDogState('speaking');

      let generated = '';
      const msgId = `dog_${Date.now()}`;

      try {
        // Start a streaming message
        addMessage({
          id: msgId,
          role: 'dog',
          text: '…',
          trigger,
          timestamp: Date.now(),
        });

        generated = await llmService.generate({
          trigger,
          dogProfile,
          recentMessages: messages,
          onToken: token => {
            generated += token;
            // Update the message in store with accumulating text
            useDogStore.setState(s => ({
              messages: s.messages.map(m =>
                m.id === msgId ? { ...m, text: generated } : m,
              ),
            }));
          },
        });

        // Finalize the message
        useDogStore.setState(s => ({
          messages: s.messages.map(m =>
            m.id === msgId ? { ...m, text: generated } : m,
          ),
        }));

        // Speak through phone speaker
        await audioService.speak(generated);

        // Also send to collar if connected (async, non-blocking)
        // In production this would pipe TTS audio file through μ-law → BLE
        // For now it's a no-op if not connected
        if (bluetoothService.isConnected) {
          // Future: await bluetoothService.streamAudio(ulawEncoded);
        }
      } catch (e) {
        console.error('[LLM] generate error', e);
        useDogStore.setState(s => ({
          messages: s.messages.map(m =>
            m.id === msgId ? { ...m, text: '...woof?' } : m,
          ),
        }));
      } finally {
        setIsGenerating(false);
        const newState = LLMService.triggerToDogState(trigger);
        setDogState(newState === 'idle' ? 'idle' : newState);
      }
    },
    [isGenerating, dogProfile, messages, addMessage, setIsGenerating, setDogState],
  );

  return { generateResponse, isGenerating, llmStatus };
}
