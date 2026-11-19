import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import ProvianIcon, { type ProvianIconName } from '../components/ProvianIcon';
import { useTranslation } from 'react-i18next';
import { COLORS, BORDER_RADIUS, SHADOWS, GLASS, SPACING } from '../constants/theme';
import HomeScreen from '../screens/Dashboard/HomeScreen';
import { EarnHubScreen } from '../screens/Earn';
import PromiseListScreen from '../screens/Promise/PromiseListScreen';
import { ChatHomeScreen } from '../screens/Chat';
import CommonsDashboard from '../screens/Commons/CommonsDashboard';
import type { TabParamList } from './types';
import { useAttentionCount } from '../core/attention/useAttentionCount';
import { usePendingThreadDraftFlush } from '../core/commons/usePendingThreadDraftFlush';
import useCommonsStore from '../store/commonsStore';

/** the Commons Inbox count (messages, replies to you, publish requests) for the Commons-tab
 * badge. Refreshes on mount + every 60s; each source degrades on its own. */
function useCommonsInboxCount(): number {
    const count = useCommonsStore((s) => s.inboxUnread);
    const refresh = useCommonsStore((s) => s.refreshNotifications);
    React.useEffect(() => {
        void refresh();
        const id = setInterval(() => { void refresh(); }, 60000);
        return () => clearInterval(id);
    }, [refresh]);
    return count;
}


const Tab = createBottomTabNavigator<TabParamList>();

const tabDetails: Record<keyof TabParamList, { label: string; icon: ProvianIconName }> = {
    WalletTab: { label: 'overhaul.home', icon: 'home' },
    AgentsTab: { label: 'nav.earn', icon: 'earn' },
    ChatTab: { label: 'nav.chat', icon: 'chat' },
    CommonsTab: { label: 'nav.commons', icon: 'commons' },
    PromisesTab: { label: 'nav.promises', icon: 'promises' },
};

const FloatingTabBar = ({ state, descriptors, navigation }: BottomTabBarProps) => {
    const { t } = useTranslation();
    // Respect the device's bottom safe area so the tab bar doesn't collide
    // with Android's gesture bar or iOS's home indicator. Fall back to a
    // reasonable floating offset when the inset is zero (older devices).
    const insets = useSafeAreaInsets();
    const platformFloatOffset = Platform.OS === 'ios' ? 12 : 8;
    const wrapperBottom = Math.max(insets.bottom, 0) + platformFloatOffset;
    // The bar floats, so list content showed through the gaps beside and below it (the operator,
    // 2026-09-23). A fade from the bar's TOP EDGE down to the screen bottom dissolves that
    // content into the background. It never reaches above the bar; lists already reserve room
    // to scroll their last row clear of it (tabs/layout.ts). Nothing floats over the bar in a
    // tab: the Commons "Post a job" / "Post a request" actions sit inline in their lists
    // (InlinePostButton). Height is the bar's measured height.
    const [barHeight, setBarHeight] = React.useState(72);

    return (
    <>
    <LinearGradient
        pointerEvents="none"
        colors={[`${COLORS.background}00`, `${COLORS.background}F2`, COLORS.background]}
        locations={[0, 0.3, 1]}
        style={[tabStyles.scrim, { height: wrapperBottom + barHeight }]}
    />
    <View style={[tabStyles.wrapper, { bottom: wrapperBottom }]}>
        <View style={tabStyles.container} onLayout={(e) => setBarHeight(Math.round(e.nativeEvent.layout.height))}>
            <View style={tabStyles.bar}>
                <View style={tabStyles.inner} accessibilityRole="tablist">
                    {state.routes.map((route, index) => {
                        const { options } = descriptors[route.key];
                        const focused = state.index === index;
                        const entry = tabDetails[route.name as keyof TabParamList];
                        const label = t(entry.label);
                        const badge = typeof options.tabBarBadge === 'number' ? options.tabBarBadge : null;

                        const onPress = () => {
                            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
                        };
                        const onLongPress = () => {
                            navigation.emit({ type: 'tabLongPress', target: route.key });
                        };

                        return (
                            <Pressable
                                key={route.key}
                                style={tabStyles.tab}
                                onPress={onPress}
                                onLongPress={onLongPress}
                                accessibilityRole="tab"
                                accessibilityState={{ selected: focused }}
                                accessibilityLabel={label}
                                testID={`tab-${route.name}`}
                            >
                                <View style={[tabStyles.iconWrap, focused && tabStyles.iconWrapActive]}>
                                    <ProvianIcon name={entry.icon} size={26} selected={focused} />
                                    {badge != null && (
                                        <View style={tabStyles.badge}>
                                            <Text style={tabStyles.badgeText} numberOfLines={1}>
                                                {badge > 9 ? '9+' : badge}
                                            </Text>
                                        </View>
                                    )}
                                </View>
                                <Text
                                    style={[tabStyles.label, focused && tabStyles.labelActive]}
                                    numberOfLines={1}
                                    adjustsFontSizeToFit
                                    minimumFontScale={0.85}
                                >
                                    {label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </View>
        </View>
    </View>
    </>
    );
};

const tabStyles = StyleSheet.create({
    scrim: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    wrapper: {
        // `bottom` is computed at render-time from safe-area insets in
        // FloatingTabBar, so it's not set here.
        position: 'absolute',
        left: 16,
        right: 16,
        alignItems: 'center',
    },
    container: {
        width: '100%',
        maxWidth: 380,
        borderRadius: BORDER_RADIUS.xxl,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: COLORS.glassBorder,
        ...SHADOWS.large,
    },
    bar: {
        overflow: 'hidden',
        borderRadius: BORDER_RADIUS.xxl,
        backgroundColor: GLASS.nav.backgroundColor,
    },
    inner: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.s,
    },
    // The Pressable itself — the full cell is the touch target, so the
    // vertical padding here is load-bearing, not decoration.
    tab: {
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        paddingVertical: SPACING.xs,
    },
    iconWrap: {
        width: 44,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconWrapActive: {
        backgroundColor: COLORS.primaryMuted,
    },
    badge: {
        position: 'absolute',
        top: -2,
        right: 2,
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        paddingHorizontal: 4,
        backgroundColor: COLORS.warning,
        alignItems: 'center',
        justifyContent: 'center',
    },
    badgeText: {
        fontSize: 10,
        fontWeight: '600',
        color: COLORS.background,
    },
    label: {
        marginTop: 3,
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        letterSpacing: -0.1,
        textAlign: 'center',
        color: COLORS.textTertiary,
    },
    labelActive: {
        fontWeight: '600',
        color: COLORS.primary,
    },
});

const TabNavigator = () => {
    // / item 4: the same shared count as the Dashboard bell (mount, 30 s, foreground, push).
    const { count: attentionCount } = useAttentionCount();
    const commonsInboxCount = useCommonsInboxCount();
    // Kept Commons drafts send themselves once the recipient's message key appears.
    usePendingThreadDraftFlush();
    return (
        <Tab.Navigator
            initialRouteName="WalletTab"
            backBehavior="initialRoute"
            tabBar={(props) => <FloatingTabBar {...props} />}
            screenOptions={{
                headerShown: false,
                tabBarStyle: { position: 'absolute' },
            }}
        >
            <Tab.Screen name="WalletTab" component={HomeScreen} options={{ tabBarBadge: attentionCount || undefined }} />
            <Tab.Screen name="AgentsTab" component={EarnHubScreen} />
            <Tab.Screen name="ChatTab" component={ChatHomeScreen} />
            <Tab.Screen name="CommonsTab" component={CommonsDashboard}
                options={{ tabBarBadge: commonsInboxCount || undefined }} />
            <Tab.Screen name="PromisesTab" component={PromiseListScreen} />
        </Tab.Navigator>
    );
};

export default TabNavigator;
