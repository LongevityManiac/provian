/**
 * KeyboardSafeScrollView
 *
 * Wraps screen content so the on-screen numeric/text keypad never covers
 * the action button at the bottom of the screen. Combines:
 *   - KeyboardAvoidingView (pads on iOS, resizes on Android)
 *   - ScrollView with `keyboardShouldPersistTaps="handled"` so taps on
 *     buttons go through without first dismissing the keyboard
 *   - flexGrow:1 + bottom padding so the content can actually scroll
 *
 * USAGE:
 *
 *   <SafeAreaView style={styles.container}>
 *     <View style={styles.header}>...header...</View>
 *     <KeyboardSafeScrollView contentContainerStyle={styles.content}>
 *       ...form fields, TextInputs, action buttons...
 *     </KeyboardSafeScrollView>
 *   </SafeAreaView>
 *
 * WHEN NOT TO USE:
 *   - List-only screens that already use FlatList/SectionList - those
 *     have their own scroll context
 *   - Modal/sheet screens that should never scroll
 *
 * Why a shared component instead of fixing each screen by hand: every
 * screen with a TextInput needs the exact same wrapper. Centralizing the
 * pattern means one place to fix bugs, and it's drop-in for any future
 * form screens.
 */

import React from 'react';
import {
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleProp,
    ViewStyle,
} from 'react-native';

interface KeyboardSafeScrollViewProps {
    /** Style applied to the inner ScrollView's contentContainerStyle. Use
     *  this for padding and layout. Should NOT have flex:1 - use flexGrow:1
     *  if you need fill behavior. */
    contentContainerStyle?: StyleProp<ViewStyle>;
    /** Style applied to the outer KeyboardAvoidingView. Defaults to
     *  { flex: 1 } which fills the parent. */
    style?: StyleProp<ViewStyle>;
    /** Optional vertical offset for the iOS padding behavior. Use when
     *  there's a fixed header above the scroll view. */
    keyboardVerticalOffset?: number;
    children?: React.ReactNode;
}

const DEFAULT_CONTENT_STYLE: ViewStyle = {
    flexGrow: 1,
    paddingBottom: 24,
};

export default function KeyboardSafeScrollView({
    contentContainerStyle,
    style,
    keyboardVerticalOffset,
    children,
}: KeyboardSafeScrollViewProps) {
    return (
        <KeyboardAvoidingView
            style={[{ flex: 1 }, style]}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={keyboardVerticalOffset ?? (Platform.OS === 'ios' ? 0 : 24)}
        >
            <ScrollView
                contentContainerStyle={[DEFAULT_CONTENT_STYLE, contentContainerStyle]}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                {children}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}
