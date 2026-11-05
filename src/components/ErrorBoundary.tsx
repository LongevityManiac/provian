import { withTranslation, type WithTranslation } from 'react-i18next';
import i18next from 'i18next';
import React, { Component, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../constants/theme';

interface Props extends WithTranslation {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: React.ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null,
        };
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        this.setState({ errorInfo });
        // Log to error reporting service in production
        console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    }

    handleRestart = () => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
        });
    };

    render() {
        if (this.state.hasError) {
            return (
                <SafeAreaView style={styles.container}>
                    <View style={styles.content}>
                        <View style={styles.iconContainer}>
                            <Ionicons name="warning" size={56} color="#E8A838" />
                        </View>

                        <Text style={styles.title}>{i18next.t('commonsHumanJobManage.fundErrorTitle')}</Text>
                        <Text style={styles.subtitle}>
                            {i18next.t('ui.errorBoundary.body')}</Text>

                        <TouchableOpacity style={styles.button} onPress={this.handleRestart}>
                            <Text style={styles.buttonText}>{i18next.t('common.tryAgain')}</Text>
                        </TouchableOpacity>

                        {__DEV__ && this.state.error && (
                            <ScrollView style={styles.errorDetails}>
                                <Text style={styles.errorTitle}>ERROR DETAILS (DEV ONLY)</Text>
                                <Text style={styles.errorText}>
                                    {this.state.error.toString()}
                                </Text>
                                {this.state.errorInfo && (
                                    <Text style={styles.errorStack}>
                                        {this.state.errorInfo.componentStack}
                                    </Text>
                                )}
                            </ScrollView>
                        )}

                        <TouchableOpacity
                            style={styles.supportLink}
                            onPress={() => {
                                // In a full implementation, this would open email
                                console.log('Contact support');
                            }}
                        >
                            <Text style={styles.supportText}>
                                {i18next.t('legal.support_contact')}</Text>
                        </TouchableOpacity>
                    </View>
                </SafeAreaView>
            );
        }

        return this.props.children;
    }
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: SPACING.xl,
    },
    iconContainer: {
        width: 112,
        height: 112,
        borderRadius: 32,
        backgroundColor: 'rgba(255,179,0,0.14)',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: SPACING.xl,
    },
    title: {
        fontSize: 24,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.m,
    },
    subtitle: {
        fontSize: 16,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 24,
        marginBottom: SPACING.xl,
    },
    button: {
        backgroundColor: '#4A8EE8',
        paddingVertical: SPACING.m,
        paddingHorizontal: SPACING.xl,
        borderRadius: 28,
        marginBottom: SPACING.l,
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '700',
        color: '#0B0E14',
    },
    errorDetails: {
        maxHeight: 200,
        width: '100%',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        marginTop: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    errorTitle: {
        fontSize: 11,
        fontWeight: '600',
        color: '#E8A838',
        marginBottom: SPACING.s,
        letterSpacing: 2,
        textTransform: 'uppercase',
    },
    errorText: {
        fontSize: 11,
        color: COLORS.error,
        fontFamily: 'monospace',
    },
    errorStack: {
        fontSize: 10,
        color: '#9CA3AF',
        fontFamily: 'monospace',
        marginTop: SPACING.s,
    },
    supportLink: {
        marginTop: SPACING.xl,
    },
    supportText: {
        fontSize: 14,
        color: '#4A8EE8',
    },
});

export default withTranslation()(ErrorBoundary);
