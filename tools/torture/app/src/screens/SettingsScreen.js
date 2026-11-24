import React from 'react';
import { View, Text, Switch } from 'react-native';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useTortureStore } from '../store/useTortureStore';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const locale = useTortureStore((s) => s.locale);
  const setLocale = useTortureStore((s) => s.setLocale);
  const toggle = (fr) => {
    const next = fr ? 'fr' : 'en';
    setLocale(next);
    i18n.changeLanguage(next);
  };
  return (
    <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center' }}>
      <Text>{t('locale')}: {locale}</Text>
      <Switch value={locale === 'fr'} onValueChange={toggle} />
    </View>
  );
}
