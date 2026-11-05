import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, BORDER_RADIUS, SHADOWS, GLASS, SPACING } from '../constants/theme';
import DashboardScreen from '../screens/Dashboard/DashboardScreen';
import { EarnHubScreen } from '../screens/Earn';
import { MyProvenanceDashboardScreen } from '../screens/Provenance';
import PromiseListScreen from '../screens/Promise/PromiseListScreen';
import { ChatHomeScreen } from '../screens/Chat';
import VisionScreen from '../screens/Vision/VisionScreen';
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

// These screens use the parent Stack navigator for navigation via useNavigation(),
// so we cast them to satisfy the tab navigator's type constraints.
const VisionTab = VisionScreen as unknown as React.ComponentType<Record<string, never>>;
const AbundanceTab = MyProvenanceDashboardScreen as unknown as React.ComponentType<Record<string, never>>;
const AgentsTab = EarnHubScreen as unknown as React.ComponentType<Record<string, never>>;
const CommonsTab = CommonsDashboard as unknown as React.ComponentType<Record<string, never>>;
const PromisesTab = PromiseListScreen as unknown as React.ComponentType<Record<string, never>>;
const ChatTab = ChatHomeScreen as unknown as React.ComponentType<Record<string, never>>;

/**
 * Floating tab bar.
 *
 * The whole cell is the touch target — the press handler must never sit on the
 * Ionicons glyph itself, which is only ~22pt and leaves the rest of the cell
 * dead to the touch. Each cell also carries its own accessibility identity so
 * a screen reader announces "Wallet, tab, 3 of 7, selected" rather than an
 * unlabeled image.
 */
const FloatingTabBar = ({ state, descriptors, navigation }: any) => {
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
                    {state.routes.map((route: any, index: number) => {
                        const { options } = descriptors[route.key];
                        const focused = state.index === index;
                        const iconName = options.tabBarIconName as string;
                        const label = t(options.tabBarLabelKey as string);
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
                                    <Ionicons
                                        name={iconName as any}
                                        size={22}
                                        color={focused ? COLORS.primary : COLORS.textTertiary}
                                    />
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
                                    // Tighter floor than before: with the smaller uniform base
                                    // above, most labels never shrink, and this keeps any that
                                    // do close in size to the rest instead of visibly tiny.
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
        // Sized so all SEVEN labels (Vision…Chat, incl. the added Commons tab)
        // fit their cell WITHOUT per-label auto-shrink. `adjustsFontSizeToFit`
        // scales each Text independently, so at fontSize 9 the longer labels
        // (Abundance, Promises, Commons) shrank while short ones (Earn, Chat)
        // stayed full size — reading as mismatched fonts across the bar. A
        // smaller uniform base keeps every label at the same size on normal
        // devices; the auto-shrink below is now only a safety net for very
        // narrow screens and longer localized strings.
        fontSize: 8,
        fontWeight: '500',
        lineHeight: 11,
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
            <Tab.Screen
                name="VisionTab"
                component={VisionTab}
                options={{
                    tabBarLabelKey: 'nav.vision',
                    tabBarIconName: 'compass-outline',
                    tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                        <Ionicons name="compass-outline" size={size} color={color} />
                    ),
                } as any}
            />
            <Tab.Screen
                name="AbundanceTab"
                component={AbundanceTab}
                options={{
                    tabBarLabelKey: 'nav.abundance',
                    tabBarIconName: 'sparkles-outline',
                    tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                        <Ionicons name="sparkles-outline" size={size} color={color} />
                    ),
                } as any}
            />
            <Tab.Screen
                name="WalletTab"
                component={DashboardScreen}
                options={{
                    tabBarLabelKey: 'nav.wallet',
                    tabBarIconName: 'wallet-outline',
                    // surface the attention count on the tab bar so it is visible on app open
                    // from any tab (the bell + attention center live on the Wallet screen).
                    ...(attentionCount > 0 ? { tabBarBadge: attentionCount } : {}),
                    tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                        <Ionicons name="wallet-outline" size={size} color={color} />
                    ),
                } as any}
            />
            <Tab.Screen
                name="AgentsTab"
                component={AgentsTab}
                options={{
                    tabBarLabelKey: 'nav.earn',
                    tabBarIconName: 'trending-up-outline',
                    tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                        <Ionicons name="trending-up-outline" size={size} color={color} />
                    ),
                } as any}
            />
            <Tab.Screen
                name="CommonsTab"
                component={CommonsTab}
                options={{
                    tabBarLabelKey: 'nav.commons',
                    tabBarIconName: 'people-outline',
                    // messages, replies to you, and publish requests waiting in the Commons Inbox.
                    ...(commonsInboxCount > 0 ? { tabBarBadge: commonsInboxCount } : {}),
                    tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                        <Ionicons name="people-outline" size={size} color={color} />
                    ),
                } as any}
            />
            <Tab.Screen
                name="PromisesTab"
                component={PromisesTab}
                options={{
                    tabBarLabelKey: 'nav.promises',
                    tabBarIconName: 'heart-outline',
                    tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                        <Ionicons name="heart-outline" size={size} color={color} />
                    ),
                } as any}
            />
            <Tab.Screen
                name="ChatTab"
                component={ChatTab}
                options={{
                    tabBarLabelKey: 'nav.chat',
                    tabBarIconName: 'chatbubbles-outline',
                    tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                        <Ionicons name="chatbubbles-outline" size={size} color={color} />
                    ),
                } as any}
            />
        </Tab.Navigator>
    );
};

export default TabNavigator;
