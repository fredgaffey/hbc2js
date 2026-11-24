import { create } from 'zustand';

export const useTortureStore = create((set, get) => ({
  coreResults: {},
  junkTotal: null,
  runs: 0,
  locale: 'en',
  setCoreResults: (coreResults) => set({ coreResults, runs: get().runs + 1 }),
  setJunkTotal: (junkTotal) => set({ junkTotal }),
  setLocale: (locale) => set({ locale }),
  hydrate: (saved) => set(saved ? { runs: saved.runs ?? 0, locale: saved.locale ?? 'en' } : {}),
}));
