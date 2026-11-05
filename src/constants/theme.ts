// Provian Design System: "Quiet Shield" (2026 de-chrome of "Shield Glow")
// Dark navy base from the shield logo, flat solid surfaces, one interactive
// accent (Shield Blue). Green, amber, and red are status semantics, never
// decoration.
//
// VALUE-COLOR RULE (decided 2026-09-03, reconciling the 2026-08-18 platinum
// coin with the amber value accent): PLATINUM OWNS THE ASSET, AMBER OWNS THE
// MOMENT. The PVT token identity — the coin, PVT balances and PVT amounts,
// PVT earning chips/badges, the PVT wallet card accent, PVT hero art — is
// platinum (COLORS.platinum*, the "verified value" proof mark drawn by
// TokenIcon.tsx -> PVTIcon: platinum/silver coin with a deep-navy check).
// Amber remains the ambient accent for participation VALUE MOMENTS — the act
// of earning, the footprint/abundance tiles and glows (Shield Amber, from the
// logo's inner energy) — and for the warning status semantic. Rationale: the
// coin is the asset's proof mark and must not read as gold/yellow-on-black;
// the moment-of-earning energy stays amber so the app does not go grey.
//
// Gradient tokens are intentionally flat (same color at every stop) so legacy
// LinearGradient call sites render solid without per-screen edits. No glow,
// no neon, no translucent glass: calm is the brand. "Slow is smooth, smooth
// is safe."

export const COLORS = {
    // Core Depths (Backgrounds) - deep navy from the logo backdrop
    background: '#0B0E14',       // Shield Dark - deepest layer
    backgroundAlt: '#111827',    // Deep Navy - elevated containers
    surface: '#111827',          // Deep Navy - card surfaces
    surfaceHighlight: '#1A2332', // Midnight Steel - secondary surfaces, inputs
    surfaceElevated: '#1A2332',  // Midnight Steel - modals, sheets

    // Basic
    white: '#F0F2F5',           // Bright Chrome
    black: '#0B0E14',           // Shield Dark

    // Chrome Scale - warm-tinted chrome
    chrome: '#F0F2F5',          // Bright Chrome - headlines, critical values
    chromeMuted: '#C8CDD6',     // Silver Plate - primary text
    glow: '#4A8EE8',            // Shield Blue - primary energy

    // Primary - Shield Blue (from logo's blue edges)
    primary: '#4A8EE8',         // Shield Blue - primary actions
    primaryLight: '#6BA3F0',    // Arc Blue - hover states, links
    primaryMuted: 'rgba(74, 142, 232, 0.15)',
    primaryGlow: 'rgba(74, 142, 232, 0.40)',

    // Secondary - Amber Gold (from logo's inner energy). AMBER OWNS THE MOMENT:
    // the act of earning, footprint/abundance tiles and glows — never the PVT
    // asset itself (see the platinum scale below and the header rule).
    secondary: '#E8A838',       // Shield Amber - secondary actions, value moments
    secondaryLight: '#F5C542',  // Gold Spark - light accents
    secondaryMuted: 'rgba(232, 168, 56, 0.15)',
    secondaryGlow: 'rgba(232, 168, 56, 0.40)',

    // Platinum - the PVT ASSET identity ("verified value" proof mark). PLATINUM
    // OWNS THE ASSET: the coin (TokenIcon.tsx -> PVTIcon draws exactly these),
    // PVT balances and amounts, earning chips/badges, the PVT wallet card
    // accent. Never gold/yellow-on-black.
    platinum: '#F5F7FB',        // Platinum Sheen - coin highlight, PVT amounts, chips
    platinumDeep: '#C2C9D5',    // Platinum Body - coin body, gradient far stop
    platinumEdge: '#8A93A3',    // Platinum Rim - metallic rim stroke, muted edges
    platinumMuted: 'rgba(194, 201, 213, 0.22)', // Platinum Body at 22% - card borders
    platinumCheck: '#152233',   // Proof Navy - the verified check on the coin
    platinumSeal: '#1B2637',    // Seal Navy - the thin seal ring on the coin

    // Accent - Signal Red for emergency lockdown and critical alerts
    accent: '#F2555A',          // Signal Red - errors, losses, warnings
    accentLight: '#FF7A7E',

    // Purple - Agent features (maps to Shield Blue for unified look)
    purple: '#4A8EE8',          // Shield Blue (was purple, unified)
    purpleLight: '#6BA3F0',
    purpleMuted: 'rgba(74, 142, 232, 0.15)',

    // Text - High contrast hierarchy
    // [A11y fix] textTertiary/textMuted bumped from a darker gray
    // (3.2:1 - fails WCAG AA for normal text) to #9CA3AF (7.85:1 -
    // passes AAA). The old value made the bottom nav inactive icons
    // and muted labels hard to read in bright sunlight. Visual
    // hierarchy is preserved because textSecondary (6.1:1) and text
    // (17:1) remain brighter.
    text: '#F0F2F5',           // Bright Chrome - headlines (17:1)
    textSecondary: '#8B929E',  // Titanium - secondary text, icons (6.1:1)
    textTertiary: '#9CA3AF',   // Steel - muted text, inactive nav (7.85:1)
    textMuted: '#9CA3AF',      // Steel - labels and placeholders (7.85:1)

    // Status colors - System states (calmed from neon reactor hues)
    success: '#4CC38A',         // Quiet Green
    successLight: '#5ED9A0',
    successMuted: 'rgba(76, 195, 138, 0.15)',
    error: '#F2555A',           // Signal Red
    errorLight: '#FF7A7E',
    errorMuted: 'rgba(242, 85, 90, 0.15)',
    warning: '#E8A838',         // Shield Amber (unified with secondary)
    warningLight: '#F5C542',
    warningMuted: 'rgba(232, 168, 56, 0.15)',

    // Borders - Deep navy edges
    border: '#1E2D3D',          // Navy Border - dividers, inactive states
    borderLight: 'rgba(200, 205, 214, 0.08)',
    borderFocus: 'rgba(74, 142, 232, 0.40)',

    // Former glass panels - now opaque surfaces with neutral borders
    glass: '#111827',
    glassStrong: '#0D1119',
    glassBorder: 'rgba(200, 205, 214, 0.08)',
    glassBorderHighlight: 'rgba(200, 205, 214, 0.12)',

    // Icon backgrounds
    iconBackground: 'rgba(74, 142, 232, 0.15)',
    iconBackgroundSuccess: 'rgba(76, 195, 138, 0.15)',
    iconBackgroundWarning: 'rgba(232, 168, 56, 0.15)',
    iconBackgroundError: 'rgba(242, 85, 90, 0.15)',

    // Deep Current - blue-tinted background areas
    deepCurrent: '#0A1628',
};

// Gradient presets - intentionally FLAT (same color at every stop).
// Legacy LinearGradient call sites keep working but render solid surfaces.
// Stop counts are preserved from the original tokens so any call site that
// passes `locations` arrays stays valid. The two *Fade tokens remain real
// gradients: they are functional scrims, not decoration.
export const GRADIENTS = {
    // Backgrounds - one flat depth
    background: ['#0B0E14', '#0B0E14', '#0B0E14'] as const,
    backgroundDiagonal: ['#0B0E14', '#0B0E14', '#0B0E14'] as const,
    backgroundRadial: ['#0B0E14', '#0B0E14'] as const,

    // Surfaces - opaque elevated cards
    surface: ['#111827', '#111827'] as const,
    surfaceHighlight: ['#1A2332', '#1A2332'] as const,
    card: ['#111827', '#111827'] as const,
    cardHover: ['#1A2332', '#1A2332'] as const,

    // Hero cards, premium surfaces
    chromeShield: ['#151D29', '#151D29', '#151D29'] as const,
    steelPlate: ['#1A2332', '#1A2332'] as const,
    voidDepth: ['#0B0E14', '#0B0E14'] as const,

    // Agent connection cards
    agentNexus: ['#111827', '#111827', '#111827'] as const,

    // PE count hero card
    participationGlow: ['#111827', '#111827', '#111827'] as const,

    // Action buttons - solid fills
    primary: ['#4A8EE8', '#4A8EE8'] as const,
    primaryLight: ['#6BA3F0', '#6BA3F0'] as const,
    primaryPressed: ['#3A7BD6', '#3A7BD6'] as const,
    secondary: ['#E8A838', '#E8A838'] as const,
    accent: ['#F2555A', '#F2555A'] as const,
    accentPressed: ['#C73E43', '#C73E43'] as const,
    success: ['#4CC38A', '#4CC38A'] as const,
    successPressed: ['#3AA873', '#3AA873'] as const,

    // Feature cards - single muted tint
    cardBlue: ['rgba(74, 142, 232, 0.10)', 'rgba(74, 142, 232, 0.10)'] as const,
    cardCyan: ['rgba(107, 163, 240, 0.10)', 'rgba(107, 163, 240, 0.10)'] as const,
    cardPurple: ['rgba(74, 142, 232, 0.10)', 'rgba(74, 142, 232, 0.10)'] as const,
    cardHighlight: ['rgba(74, 142, 232, 0.12)', 'rgba(74, 142, 232, 0.12)'] as const,

    // Balance card - flat premium surface
    balanceCard: ['#111827', '#111827'] as const,
    balanceCardGlow: ['#151D29', '#151D29', '#151D29'] as const,

    // Subtle surface sheen, now a flat whisper
    chrome: ['rgba(240, 242, 245, 0.03)', 'rgba(240, 242, 245, 0.03)'] as const,

    // Header/navigation - functional scrims (kept as real gradients)
    headerFade: ['#0B0E14', '#0B0E14', 'transparent'] as const,
    bottomFade: ['transparent', '#0B0E14'] as const,

    // Friction level status - solid semantic fills
    frictionLevel1: ['#4CC38A', '#4CC38A', '#4CC38A'] as const,
    frictionLevel2: ['#4A8EE8', '#4A8EE8', '#4A8EE8'] as const,
    frictionLevel3: ['#E8A838', '#E8A838', '#E8A838'] as const,
    frictionLevel4: ['#F2555A', '#F2555A', '#F2555A'] as const,
    frictionLevel5: ['#6A7280', '#6A7280', '#6A7280'] as const,

    // Status
    gold: ['#E8A838', '#E8A838'] as const,

    // PVT asset surfaces - platinum, flat per this file's convention. The coin's
    // own minted highlight is a radial from COLORS.platinum to COLORS.platinumDeep
    // drawn directly in TokenIcon.tsx; this token is for LinearGradient call sites.
    platinumSheen: ['#C2C9D5', '#C2C9D5'] as const,

    // Legacy signature tokens, now flat surfaces
    shieldGlow: ['#151D29', '#151D29', '#151D29'] as const,
    amberGlow: ['rgba(232, 168, 56, 0.10)', 'rgba(232, 168, 56, 0.10)'] as const,
};

export const SPACING = {
    xs: 4,
    s: 8,
    m: 16,
    l: 24,
    xl: 32,
    xxl: 48,
    xxxl: 64,
};

export const BORDER_RADIUS = {
    s: 4,       // Buttons, inputs, chips
    m: 8,       // Cards, modals
    l: 16,      // Feature cards, bottom sheets
    xl: 24,     // Large panels
    xxl: 32,    // Oversized elements
    round: 9999, // Pills, avatars, indicators
};

// Shadow presets - 5-level elevation system with shield glow
export const SHADOWS = {
    // Level 0: Flat
    none: {
        shadowColor: 'transparent',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
    },
    // Level 1: Lifted - standard cards, inputs
    small: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.30,
        shadowRadius: 4,
        elevation: 3,
    },
    // Level 2: Prominent - active cards, dropdowns
    medium: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.40,
        shadowRadius: 12,
        elevation: 6,
    },
    // Level 3: Dramatic - bottom sheets, floating panels
    large: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.50,
        shadowRadius: 32,
        elevation: 12,
    },
    // Level 4: Maximum - command bar, critical modals
    card: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 24 },
        shadowOpacity: 0.60,
        shadowRadius: 48,
        elevation: 16,
    },
    // Former glow shadows - retired. Colored halo shadows read as neon;
    // every glow token now resolves to a soft black lift so existing call
    // sites keep valid elevation without the energy effect.
    glowPrimary: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
        elevation: 3,
    },
    glowSecondary: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
        elevation: 3,
    },
    glowSuccess: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
        elevation: 3,
    },
    glowCard: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
        elevation: 3,
    },
    glowAmber: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
        elevation: 3,
    },
    glowPurple: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
        elevation: 3,
    },
    glowDanger: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
        elevation: 3,
    },
};

// Former glass primitives - now opaque elevated surfaces. Translucency over
// gradient washes was the glassmorphism look; flat opaque cards on a flat
// background are the calm one.
export const GLASS = {
    card: {
        backgroundColor: '#111827',
        borderColor: '#1E2D3D',
        borderWidth: 1,
        borderRadius: 8,
    },
    cardStrong: {
        backgroundColor: '#0D1119',
        borderColor: '#1E2D3D',
        borderWidth: 1,
        borderRadius: 8,
    },
    cardSubtle: {
        backgroundColor: '#10141C',
        borderColor: 'rgba(30, 45, 61, 0.5)',
        borderWidth: 1,
        borderRadius: 8,
    },
    input: {
        backgroundColor: '#1A2332',
        borderColor: '#1E2D3D',
        borderWidth: 1,
        borderRadius: 4,
    },
    nav: {
        backgroundColor: '#10141C',
        borderColor: '#1E2D3D',
        borderWidth: 1,
        borderRadius: 28,
    },
    pill: {
        borderRadius: 9999,
    },
    chip: {
        borderRadius: 4,
    },
} as const;

// Feature accent colors - disciplined to one interactive accent.
// Blue is the product. Red is reserved for genuinely critical surfaces (kill
// switch, court). VALUE-COLOR RULE: PLATINUM OWNS THE ASSET, AMBER OWNS THE
// MOMENT — `pvt` (the token identity: coin, balances, amounts, earning chips,
// wallet card accent, hero art) is platinum; `footprint` and `abundance` (the
// participation value moments: earning, tiles, glows) stay Shield Amber.
export const ACCENTS = {
    promises: '#4A8EE8',     // Shield Blue
    agents: '#4A8EE8',       // Shield Blue
    wallet: '#4A8EE8',       // Shield Blue
    commons: '#6BA3F0',      // Arc Blue
    security: '#F2555A',     // Signal Red - critical
    recovery: '#4A8EE8',     // Shield Blue
    footprint: COLORS.secondary,  // Shield Amber - value MOMENT (participation footprint)
    abundance: COLORS.secondary,  // Shield Amber - value MOMENT (abundance tiles/glows)
    pvt: COLORS.platinum,         // Platinum - the PVT ASSET identity
    court: '#F2555A',        // Signal Red - critical
    governance: '#6BA3F0',   // Arc Blue
    forum: '#4A8EE8',        // Shield Blue
    humanJobs: '#4A8EE8',    // Shield Blue
    market: '#6BA3F0',       // Arc Blue
    registry: '#4A8EE8',     // Shield Blue
    escrow: '#4A8EE8',       // Shield Blue
} as const;

// Former neon accent-line stops - retired to fully transparent so any
// remaining call site renders nothing.
export const NEON_GLOW = [
    'rgba(74, 142, 232, 0)',
    'rgba(74, 142, 232, 0)',
    'rgba(232, 168, 56, 0)',
    'rgba(232, 168, 56, 0)',
    'rgba(74, 142, 232, 0)',
] as const;

// Typography - clean system
export const FONTS = {
    regular: 'Inter_400Regular',
    medium: 'Inter_500Medium',
    semiBold: 'Inter_600SemiBold',
    bold: 'Inter_700Bold',
};

// Typography scale tokens
// Weights cap at 600: hierarchy comes from size and spacing, not boldness.
export const TYPE_SCALE = {
    displayXl: { fontSize: 56, fontWeight: '600' as const, lineHeight: 58, letterSpacing: -0.8 },
    displayLg: { fontSize: 40, fontWeight: '600' as const, lineHeight: 44, letterSpacing: -0.5 },
    displayMd: { fontSize: 32, fontWeight: '600' as const, lineHeight: 36, letterSpacing: -0.4 },
    headingLg: { fontSize: 24, fontWeight: '600' as const, lineHeight: 29, letterSpacing: -0.36 },
    headingMd: { fontSize: 20, fontWeight: '600' as const, lineHeight: 25, letterSpacing: -0.2 },
    headingSm: { fontSize: 16, fontWeight: '600' as const, lineHeight: 21 },
    bodyLg: { fontSize: 16, fontWeight: '400' as const, lineHeight: 24 },
    bodyMd: { fontSize: 14, fontWeight: '400' as const, lineHeight: 21 },
    bodySm: { fontSize: 12, fontWeight: '400' as const, lineHeight: 17 },
    monoLg: { fontSize: 20, fontWeight: '500' as const, lineHeight: 24, letterSpacing: 0.4 },
    monoMd: { fontSize: 14, fontWeight: '500' as const, lineHeight: 18, letterSpacing: 0.42 },
    monoSm: { fontSize: 11, fontWeight: '500' as const, lineHeight: 13, letterSpacing: 0.44 },
} as const;

// Friction level colors - five-tier visual system
export const FRICTION_COLORS = {
    level1: { primary: '#4CC38A', bg: 'rgba(76, 195, 138, 0.10)', border: '#4CC38A', label: 'INSTANT' },
    level2: { primary: '#4A8EE8', bg: 'rgba(74, 142, 232, 0.10)', border: '#4A8EE8', label: 'BIOMETRIC' },
    level3: { primary: '#E8A838', bg: 'rgba(232, 168, 56, 0.10)', border: '#E8A838', label: 'VERIFY' },
    level4: { primary: '#F2555A', bg: 'rgba(242, 85, 90, 0.10)', border: '#F2555A', label: 'COOLING' },
    level5: { primary: '#9CA3AF', bg: '#111827', border: '#1E2D3D', label: 'BLOCKED' },
} as const;

// Animation timing
export const TIMING = {
    instant: 100,
    fast: 150,
    normal: 250,
    slow: 400,
    dramatic: 600,
} as const;
