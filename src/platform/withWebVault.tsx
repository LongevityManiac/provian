/**
 * On the phone the screen is used as is (the OS keychain and Face ID need no setup step);
 * the web build loads withWebVault.web.tsx, which first sets up the browser's passkey + PIN vault.
 */
export default function withWebVault<C>(Screen: C): C {
    return Screen;
}
