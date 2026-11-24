import React from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import dayjs from 'dayjs';
import { useTortureStore } from '../store/useTortureStore';

export default function HomeScreen({ navigation }) {
  const { t } = useTranslation();
  const runs = useTortureStore((s) => s.runs);
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{t('home')}</Text>
      <Text>{t('runs', { count: runs })}</Text>
      <Text>{dayjs(0).add(runs, 'day').format('YYYY-MM-DD')}</Text>
      <Button title={t('runCore')} onPress={() => navigation.navigate('Core')} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 8 },
  title: { fontSize: 22, fontWeight: '600' },
});
