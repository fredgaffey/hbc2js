import React, { useEffect } from 'react';
import { ScrollView, Text } from 'react-native';
import { runCore } from '../core';
import { useTortureStore } from '../store/useTortureStore';
import { persist } from '../storage';

export default function CoreScreen() {
  const results = useTortureStore((s) => s.coreResults);
  const setCoreResults = useTortureStore((s) => s.setCoreResults);
  useEffect(() => {
    let live = true;
    runCore().then((r) => {
      if (!live) return;
      setCoreResults(r);
      persist(useTortureStore.getState());
    });
    return () => { live = false; };
  }, [setCoreResults]);
  return (
    <ScrollView contentContainerStyle={{ padding: 12 }}>
      {Object.entries(results).map(([name, value]) => (
        <Text key={name} testID={'core-' + name}>{name}: {String(value)}</Text>
      ))}
    </ScrollView>
  );
}
