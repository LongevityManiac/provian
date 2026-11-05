import { describe, it, expect } from 'vitest';
import { keyboardAvoidingBehavior, bottomSheetHost, fieldScrollOffset } from './keyboardLayout';

describe('keyboardLayout (nothing hides under the keyboard on edge-to-edge Android)', () => {
    it('Android KeyboardAvoidingView pads — RED control: the pre-fix `undefined` left the field under the keyboard', () => {
        expect(keyboardAvoidingBehavior('android')).toBe('padding');
        expect(keyboardAvoidingBehavior('android')).not.toBeUndefined();
        expect(keyboardAvoidingBehavior('ios')).toBe('padding');
        expect(keyboardAvoidingBehavior('web')).toBeUndefined();
    });

    it('a bottom sheet is inline on Android (a Modal dialog gets no resize and no keyboard events), a Modal on iOS', () => {
        expect(bottomSheetHost('android')).toBe('inline');
        expect(bottomSheetHost('ios')).toBe('modal');
    });

    it('scroll target puts the field just below the top edge, never negative', () => {
        expect(fieldScrollOffset(420, 16)).toBe(404);
        expect(fieldScrollOffset(8, 16)).toBe(0);
        expect(fieldScrollOffset(Number.NaN, 16)).toBe(0);
    });
});
