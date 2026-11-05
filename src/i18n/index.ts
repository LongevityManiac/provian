import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';

import en from './locales/en.json';
import enOnboardingNarrative from './locales/enOnboardingNarrative';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import id from './locales/id.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import pt from './locales/pt.json';
import sw from './locales/sw.json';
import tl from './locales/tl.json';
import vi from './locales/vi.json';
import zh from './locales/zh.json';

const LANGUAGE_STORAGE_KEY = '@provian_language';

const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh'];

const enWithNarrative = {
    ...en,
    onboarding: {
        ...en.onboarding,
        unified: {
            ...en.onboarding.unified,
            ...enOnboardingNarrative,
        },
    },
};

const resources = {
    en: { translation: enWithNarrative },
    es: { translation: es },
    fr: { translation: fr },
    hi: { translation: hi },
    id: { translation: id },
    ja: { translation: ja },
    ko: { translation: ko },
    pt: { translation: pt },
    sw: { translation: sw },
    tl: { translation: tl },
    vi: { translation: vi },
    zh: { translation: zh },
};

/**
 * Resolve language with priority: saved preference > device locale > English fallback.
 */
const resolveLanguage = async (): Promise<string> => {
    // 1. Check saved user preference
    try {
        const saved = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
        if (saved && SUPPORTED_LANGUAGES.includes(saved)) {
            return saved;
        }
    } catch {
        // AsyncStorage not available yet - fall through
    }

    // 2. Check device locale
    const deviceLang = Localization.getLocales()[0]?.languageCode;
    if (deviceLang && SUPPORTED_LANGUAGES.includes(deviceLang)) {
        return deviceLang;
    }

    // 3. English fallback
    return 'en';
};

/**
 * Save the user's language preference. Called from LanguageScreen.
 */
export const saveLanguagePreference = async (code: string): Promise<void> => {
    try {
        await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, code);
    } catch {
        // Best-effort - language still changes in memory
    }
};

export { SUPPORTED_LANGUAGES };

const initI18n = async () => {
    const language = await resolveLanguage();

    await i18n.use(initReactI18next).init({
        resources,
        lng: language,
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false,
        },
        compatibilityJSON: 'v4',
    });
};

initI18n();

export default i18n;
