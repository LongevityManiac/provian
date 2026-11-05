/**
 * keyboardLayout — the keyboard decisions shared by every screen with a text field.
 *
 * The app is edge-to-edge on Android (`app.json` edgeToEdgeEnabled, RN's edge-to-edge flag on).
 * edge-to-edge the activity's `adjustResize` no longer shrinks the window, so a screen that
 * relied on the resize (KeyboardAvoidingView `behavior={undefined}` on Android) left its field
 * and buttons UNDER the keyboard — the Rename sheet and the Link Invitation name field. Two rules:
 *
 * 1. KeyboardAvoidingView uses `padding` on BOTH platforms. It is self-correcting: it pads by the
 * overlap between its own frame and the keyboard's top, so on a window that DID resize the
 * overlap is 0 and nothing doubles.
 * 2. A bottom sheet on Android is hosted INLINE (an absolutely-positioned overlay in the screen),
 * not in an RN `Modal`. The Modal's dialog window is also edge-to-edge (no resize), and the
 * keyboard events the KeyboardAvoidingView listens to come from the ACTIVITY's root view, which
 * does not see the dialog's IME — so inside a Modal nothing could move the sheet.
 */
export type KeyboardAvoidBehavior = 'padding' | 'height' | 'position';

export function keyboardAvoidingBehavior(os: string): KeyboardAvoidBehavior | undefined {
    return os === 'ios' || os === 'android' ? 'padding' : undefined;
}

export type SheetHost = 'modal' | 'inline';

export function bottomSheetHost(os: string): SheetHost {
    return os === 'android' ? 'inline' : 'modal';
}

/**
 * Where to scroll so a focused field sits near the top of the visible area once the keyboard is
 * up: the field's y inside the scroll content, less a small margin, never negative.
 */
export function fieldScrollOffset(fieldY: number, margin: number): number {
    return Number.isFinite(fieldY) ? Math.max(0, fieldY - margin) : 0;
}
