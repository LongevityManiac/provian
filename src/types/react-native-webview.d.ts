declare module 'react-native-webview' {
    import { Component } from 'react';
    import { ViewProps } from 'react-native';

    export interface WebViewNavigationState {
        url: string;
        title: string;
        loading: boolean;
        canGoBack: boolean;
        canGoForward: boolean;
    }

    export interface WebViewErrorEvent {
        nativeEvent: {
            code?: number;
            description?: string;
            domain?: string;
            url?: string;
        };
    }

    export interface WebViewHttpErrorEvent {
        nativeEvent: {
            statusCode: number;
            description?: string;
            url?: string;
        };
    }

    export interface WebViewProps extends ViewProps {
        source?: { uri: string } | { html: string };
        originWhitelist?: string[];
        javaScriptEnabled?: boolean;
        sharedCookiesEnabled?: boolean;
        thirdPartyCookiesEnabled?: boolean;
        allowsBackForwardNavigationGestures?: boolean;
        startInLoadingState?: boolean;
        keyboardDisplayRequiresUserAction?: boolean;
        onMessage?: (event: { nativeEvent: { data: string } }) => void;
        onLoadStart?: (event: { nativeEvent: { url: string } }) => void;
        onLoadEnd?: (event: { nativeEvent: { url: string } }) => void;
        onError?: (event: WebViewErrorEvent) => void;
        onHttpError?: (event: WebViewHttpErrorEvent) => void;
        onNavigationStateChange?: (state: WebViewNavigationState) => void;
        injectedJavaScript?: string;
    }

    export class WebView extends Component<WebViewProps> {
        injectJavaScript(script: string): void;
        reload(): void;
        goBack(): void;
        goForward(): void;
        stopLoading(): void;
    }

    export default WebView;
}
