import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { JUNK_MODULES } from '../junk';
import { entryArg, mix } from '../junk/_rt';

function junkChecksum() {
  let h = 0;
  let count = 0;
  for (const path of Object.keys(JUNK_MODULES).sort()) {
    const ns = JUNK_MODULES[path];
    for (const name of Object.keys(ns).sort()) {
      if (typeof ns[name] !== 'function') continue;
      h = mix(h, ns[name](entryArg(name)));
      count++;
    }
  }
  return { h, count };
}

export default function JunkScreen() {
  const { t } = useTranslation();
  const { h, count } = useMemo(junkChecksum, []);
  return (
    <View style={{ padding: 16 }}>
      <Text>{t('junk')}: {h}</Text>
      <Text testID="junk-count">{count}</Text>
    </View>
  );
}
