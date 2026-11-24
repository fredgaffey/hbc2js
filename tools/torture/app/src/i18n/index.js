import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
  en: { translation: { home: 'Torture app', runCore: 'Run core checks', junk: 'Junk checksum', locale: 'Language', runs: 'Runs: {{count}}' } },
  fr: { translation: { home: 'Application torture', runCore: 'Lancer les tests', junk: 'Somme de contrôle', locale: 'Langue', runs: 'Exécutions : {{count}}' } },
};

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  compatibilityJSON: 'v3',
  interpolation: { escapeValue: false },
});

export default i18n;
