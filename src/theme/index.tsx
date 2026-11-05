/**
 * Theme provider - wraps the app with Anti-Gravity design tokens.
 * Single source: colors derived from src/constants/theme.ts
 */

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { StatusBar } from 'react-native';
import { colors, ThemeColors } from './colors';

interface ThemeContextType {
    colors: ThemeColors;
    isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = (): ThemeContextType => {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};

export const useThemeColors = (): ThemeColors => {
    const { colors: c } = useTheme();
    return c;
};

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
    useEffect(() => {
        StatusBar.setBarStyle('light-content');
    }, []);

    const value = useMemo(() => ({ colors, isDark: true }), []);

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
};

export { colors };
export type { ThemeColors };
export default ThemeContext;
