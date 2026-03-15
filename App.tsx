import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';
import AppNavigator from './src/navigation';
import { useDogStore } from './src/store/dogStore';
import { audioService } from './src/services/AudioService';
import { llmService } from './src/services/LLMService';
import RNFS from 'react-native-fs';

export default function App() {
  const { hydrate, setLLMStatus } = useDogStore();

  useEffect(() => {
    // Hydrate persisted state
    hydrate();

    // Initialize TTS
    audioService.initTts(0.48, 1.05).catch(console.warn);

    // Attempt to load LLM model from Documents directory
    loadModel();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadModel() {
    try {
      // Look for any .gguf file in the Documents directory
      const docsDir = RNFS.DocumentDirectoryPath;
      const files = await RNFS.readDir(docsDir);
      const gguf = files.find(f => f.name.endsWith('.gguf'));

      if (!gguf) {
        setLLMStatus('not_loaded');
        return;
      }

      setLLMStatus('loading');
      await llmService.load(gguf.path);
      setLLMStatus('ready');
    } catch (e) {
      console.error('[App] Failed to load LLM:', e);
      setLLMStatus('error');
    }
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AppNavigator />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
