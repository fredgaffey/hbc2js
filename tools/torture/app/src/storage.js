import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'torture:state:v1';

export async function loadPersisted() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function persist(state) {
  await AsyncStorage.setItem(KEY, JSON.stringify({ runs: state.runs, locale: state.locale }));
}
