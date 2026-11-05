import React, { useState } from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Circle, Path } from 'react-native-svg';
import { getTokenIconUrl, getChainIconUrl, PVT_SYMBOL } from '../constants/tokenIcons';
import { COLORS } from '../constants/theme';

interface TokenIconProps {
    symbol: string;
    size?: number;
    showChainBadge?: boolean;
    chain?: string;
    style?: any;
}

// Chain color mapping for subtle colored borders
const CHAIN_COLORS: Record<string, string> = {
    ethereum: '#627EEA',
    base: '#0052FF',
    arbitrum: '#28A0F0',
    optimism: '#FF0420',
};

/**
 * PVTIcon - "Platinum proof": a minted platinum/silver coin carrying a deep
 * navy verified checkmark inside a thin seal ring ("verified value"). Pure
 * vector (react-native-svg) so it stays crisp at any `size` with no bundled
 * asset or remote fetch.
 *
 * VALUE-COLOR RULE (theme.ts header): PLATINUM OWNS THE ASSET, AMBER OWNS THE
 * MOMENT. This coin IS the asset's proof mark, so every color here is a
 * COLORS.platinum* token from the design system — no hex literal may appear
 * in this component (valueColorReconciliation.test.ts binds it).
 */
const PVTIcon = ({ size }: { size: number }) => (
    <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
            <RadialGradient id="pvtPlat" cx="38%" cy="30%" r="82%">
                <Stop offset="0" stopColor={COLORS.platinum} />
                <Stop offset="1" stopColor={COLORS.platinumDeep} />
            </RadialGradient>
        </Defs>
        {/* coin body */}
        <Circle cx="50" cy="50" r="48" fill="url(#pvtPlat)" />
        {/* minted bevel highlight + metallic rim */}
        <Circle cx="50" cy="50" r="45.5" fill="none" stroke={COLORS.platinum} strokeOpacity={0.45} strokeWidth={1.5} />
        <Circle cx="50" cy="50" r="47" fill="none" stroke={COLORS.platinumEdge} strokeOpacity={0.55} strokeWidth={2} />
        {/* verified seal ring */}
        <Circle cx="50" cy="50" r="27" fill="none" stroke={COLORS.platinumSeal} strokeOpacity={0.3} strokeWidth={3} />
        {/* verified check */}
        <Path d="M34 53 L45 64 L68 37" fill="none" stroke={COLORS.platinumCheck} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
);

/**
 * TokenIcon - Displays official token icons with letter fallback
 *
 * Uses Trustwallet's open-source asset repository for icons.
 * Falls back to first letter of symbol if image fails to load.
 * PVT gets the platinum proof-mark coin (PVTIcon).
 */
const TokenIcon = ({
    symbol,
    size = 36,
    showChainBadge = false,
    chain,
    style,
}: TokenIconProps) => {
    const [imageError, setImageError] = useState(false);
    const isPVT = symbol.toUpperCase() === PVT_SYMBOL;
    const iconUrl = getTokenIconUrl(symbol);
    const chainIconUrl = chain ? getChainIconUrl(chain) : null;
    const chainColor = chain ? CHAIN_COLORS[chain.toLowerCase()] || 'rgba(200,205,214,0.12)' : 'rgba(200,205,214,0.12)';

    const containerStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
    };

    const fontSize = size * 0.4;
    const badgeSize = size * 0.4;

    // PVT gets the platinum proof-mark coin (the asset identity)
    if (isPVT) {
        return (
            <View style={[{ position: 'relative' }, containerStyle, style]}>
                <PVTIcon size={size} />
                {showChainBadge && chainIconUrl && (
                    <View style={[styles.chainBadge, { width: badgeSize, height: badgeSize, borderColor: chainColor }]}>
                        <Image
                            source={{ uri: chainIconUrl }}
                            style={styles.chainBadgeImage}
                            resizeMode="contain"
                        />
                    </View>
                )}
            </View>
        );
    }

    // Show letter fallback if no URL or image failed to load
    if (!iconUrl || imageError) {
        return (
            <View style={[styles.fallbackContainer, containerStyle, { borderColor: chainColor }, style]}>
                <Text style={[styles.fallbackText, { fontSize }]}>
                    {symbol[0]?.toUpperCase() || '?'}
                </Text>
                {showChainBadge && chainIconUrl && (
                    <View style={[styles.chainBadge, { width: badgeSize, height: badgeSize, borderColor: chainColor }]}>
                        <Image
                            source={{ uri: chainIconUrl }}
                            style={styles.chainBadgeImage}
                            resizeMode="contain"
                        />
                    </View>
                )}
            </View>
        );
    }

    return (
        <View style={[styles.container, containerStyle, { borderColor: chainColor }, style]}>
            <Image
                source={{ uri: iconUrl }}
                style={[styles.icon, { width: size - 2, height: size - 2, borderRadius: (size - 2) / 2 }]}
                resizeMode="contain"
                onError={() => setImageError(true)}
            />
            {showChainBadge && chainIconUrl && (
                <View style={[styles.chainBadge, { width: badgeSize, height: badgeSize, borderColor: chainColor }]}>
                    <Image
                        source={{ uri: chainIconUrl }}
                        style={styles.chainBadgeImage}
                        resizeMode="contain"
                    />
                </View>
            )}
        </View>
    );
};

interface ChainIconProps {
    chain: string;
    size?: number;
    style?: any;
}

/**
 * ChainIcon - Displays chain/network icons
 */
export const ChainIcon = ({ chain, size = 24, style }: ChainIconProps) => {
    const [imageError, setImageError] = useState(false);
    const iconUrl = getChainIconUrl(chain);
    const chainColor = CHAIN_COLORS[chain.toLowerCase()] || 'rgba(200,205,214,0.12)';

    if (!iconUrl || imageError) {
        return (
            <View style={[styles.chainFallback, { width: size, height: size, borderColor: chainColor }, style]}>
                <Text style={[styles.chainFallbackText, { fontSize: size * 0.5 }]}>
                    {chain[0]?.toUpperCase() || '?'}
                </Text>
            </View>
        );
    }

    return (
        <View style={[{ borderWidth: 1.5, borderColor: chainColor, borderRadius: size / 2, padding: 1 }, style]}>
            <Image
                source={{ uri: iconUrl }}
                style={{ width: size - 4, height: size - 4, borderRadius: (size - 4) / 2 }}
                resizeMode="contain"
                onError={() => setImageError(true)}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        backgroundColor: 'rgba(18,21,26,0.70)',
        overflow: 'hidden',
        borderWidth: 1.5,
    },
    icon: {
        backgroundColor: 'transparent',
    },
    fallbackContainer: {
        position: 'relative',
        backgroundColor: 'rgba(18,21,26,0.70)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
    },
    fallbackText: {
        color: COLORS.text,
        fontWeight: 'bold',
    },
    chainBadge: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        borderRadius: 100,
        backgroundColor: '#0B0E14',
        padding: 2,
        borderWidth: 1.5,
        overflow: 'hidden',
    },
    chainBadgeImage: {
        width: '100%',
        height: '100%',
        borderRadius: 100,
    },
    chainFallback: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 100,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
    },
    chainFallbackText: {
        color: COLORS.text,
        fontWeight: 'bold',
    },
});

export default TokenIcon;
