/**
 * Provian Theme Colors - Single Source of Truth
 *
 * Derived from src/constants/theme.ts (Anti-Gravity design system).
 * This file maps the canonical COLORS into the ThemeColors interface
 * consumed by useTheme() throughout the app.
 *
 * DO NOT define independent color values here.
 */

import { COLORS } from '../constants/theme';

export const colors = {
    // Backgrounds - deep space
    background: COLORS.background,
    surface: COLORS.surface,
    surfaceElevated: COLORS.surfaceElevated,
    surfaceHighlight: COLORS.surfaceHighlight,

    // Brand - Electric Chrome Blue
    primary: COLORS.primary,
    primaryHover: COLORS.primaryLight,
    primaryMuted: COLORS.primaryMuted,

    // Accent - AI Purple
    accent: COLORS.purple,
    accentLight: COLORS.purpleLight,
    accentMuted: COLORS.purpleMuted,

    // Secondary - Plasma Cyan
    secondary: COLORS.secondary,
    secondaryLight: COLORS.secondaryLight,
    secondaryMuted: COLORS.secondaryMuted,

    // Semantic - Vivid status
    success: COLORS.success,
    successLight: COLORS.successLight,
    successMuted: COLORS.successMuted,
    warning: COLORS.warning,
    warningLight: COLORS.warningLight,
    warningMuted: COLORS.warningMuted,
    error: COLORS.error,
    errorLight: COLORS.errorLight,
    errorMuted: COLORS.errorMuted,
    info: COLORS.secondary,
    infoMuted: COLORS.secondaryMuted,

    // Text - high contrast chrome
    textPrimary: COLORS.text,
    textSecondary: COLORS.textSecondary,
    textMuted: COLORS.textMuted,
    textInverse: '#0B0E14',

    // Borders - chrome-edged
    border: COLORS.border,
    borderStrong: '#9CA3AF',
    borderLight: COLORS.borderLight,

    // Inputs
    inputBackground: COLORS.surface,
    inputBorder: COLORS.border,
    inputFocus: COLORS.primary,

    // Chips/Pills
    chipBackground: COLORS.surfaceHighlight,
    chipText: COLORS.textSecondary,
    chipSelected: COLORS.primary,
    chipSelectedText: COLORS.white,

    // Legacy aliases
    cardBackground: 'rgba(17,24,39,0.85)',
    cardBackgroundElevated: COLORS.surfaceElevated,
    positive: COLORS.success,
    positiveMuted: COLORS.successMuted,
    negative: COLORS.error,
    negativeMuted: COLORS.errorMuted,
    buttonPrimary: COLORS.primary,
    buttonSecondary: COLORS.surfaceHighlight,

    // Glass effects - frosted chrome
    glass: COLORS.glass,
    glassStrong: COLORS.glassStrong,
    glassBorder: COLORS.glassBorder,
    glassBorderHighlight: COLORS.glassBorderHighlight,

    // Icon backgrounds
    iconBackground: COLORS.iconBackground,
    iconBackgroundSuccess: COLORS.iconBackgroundSuccess,
    iconBackgroundWarning: COLORS.iconBackgroundWarning,
    iconBackgroundError: COLORS.iconBackgroundError,

    // Misc
    overlay: 'rgba(0, 0, 0, 0.5)',
    skeleton: COLORS.surfaceHighlight,

    // Status bar
    statusBar: 'light-content' as const,
};

export type ThemeColors = typeof colors;
