import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../constants/theme';

interface UnderstandingTestProps {
    statement: string;
    onPass: () => void;
    onFail: () => void;
    explanation: string;
}

const UnderstandingTest: React.FC<UnderstandingTestProps> = ({
    statement,
    onPass,
    onFail,
    explanation
}) => {
    const [selectedAnswer, setSelectedAnswer] = useState<'true' | 'false' | null>(null);
    const [hasSubmitted, setHasSubmitted] = useState(false);
    const [showWhyInfo, setShowWhyInfo] = useState(false);

    const handleAnswer = (answer: 'true' | 'false') => {
        if (hasSubmitted) return;

        setSelectedAnswer(answer);
        setHasSubmitted(true);

        // TRUE is the correct answer (the statement is always true)
        if (answer === 'true') {
            setTimeout(() => onPass(), 1200);
        } else {
            setTimeout(() => onFail(), 2000);
        }
    };

    const isCorrect = selectedAnswer === 'true';

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={styles.headerIconWrap}>
                    <Ionicons name="shield-checkmark" size={40} color="#4A8EE8" />
                </View>
                <Text style={styles.title}>Confirm You Understand</Text>
                <Text style={styles.subtitle}>
                    Is this statement true or false?
                </Text>
            </View>

            <View style={styles.statementBox}>
                <Text style={styles.statementLabel}>STATEMENT</Text>
                <Text style={styles.statementText}>{statement}</Text>
            </View>

            <TouchableOpacity
                style={styles.whyLink}
                onPress={() => setShowWhyInfo(!showWhyInfo)}
            >
                <Ionicons
                    name={showWhyInfo ? "chevron-up" : "help-circle"}
                    size={16}
                    color="#9CA3AF"
                />
                <Text style={styles.whyLinkText}>Why am I seeing this?</Text>
            </TouchableOpacity>

            {showWhyInfo && (
                <View style={styles.whyInfoBox}>
                    <Text style={styles.whyInfoText}>
                        This safety check appears for medium-risk transactions to ensure you understand the action before approving.
                    </Text>
                </View>
            )}

            <View style={styles.buttonsContainer}>
                <TouchableOpacity
                    style={[
                        styles.answerButton,
                        styles.trueButton,
                        selectedAnswer === 'true' && styles.trueButtonSelected,
                        hasSubmitted && selectedAnswer === 'true' && styles.trueButtonCorrect,
                    ]}
                    onPress={() => handleAnswer('true')}
                    disabled={hasSubmitted}
                >
                    <Ionicons
                        name="checkmark-circle"
                        size={28}
                        color={selectedAnswer === 'true' ? '#0B0E14' : '#4CC38A'}
                    />
                    <Text style={[
                        styles.answerButtonText,
                        selectedAnswer === 'true' && styles.answerButtonTextSelected
                    ]}>
                        TRUE
                    </Text>
                    <Text style={[
                        styles.answerButtonSubtext,
                        selectedAnswer === 'true' && styles.answerButtonSubtextSelected
                    ]}>
                        I understand
                    </Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={[
                        styles.answerButton,
                        styles.falseButton,
                        selectedAnswer === 'false' && styles.falseButtonSelected,
                        hasSubmitted && selectedAnswer === 'false' && styles.falseButtonWrong,
                    ]}
                    onPress={() => handleAnswer('false')}
                    disabled={hasSubmitted}
                >
                    <Ionicons
                        name="close-circle"
                        size={28}
                        color={selectedAnswer === 'false' ? '#0B0E14' : COLORS.error}
                    />
                    <Text style={[
                        styles.answerButtonText,
                        selectedAnswer === 'false' && styles.answerButtonTextSelected
                    ]}>
                        FALSE
                    </Text>
                    <Text style={[
                        styles.answerButtonSubtext,
                        selectedAnswer === 'false' && styles.answerButtonSubtextSelected
                    ]}>
                        This isn't right
                    </Text>
                </TouchableOpacity>
            </View>

            {hasSubmitted && (
                <View style={[
                    styles.resultBox,
                    isCorrect ? styles.resultBoxCorrect : styles.resultBoxWrong
                ]}>
                    <Ionicons
                        name={isCorrect ? "checkmark-circle" : "close-circle"}
                        size={24}
                        color={isCorrect ? '#4CC38A' : COLORS.error}
                    />
                    <Text style={styles.resultText}>
                        {isCorrect
                            ? 'Correct! Proceeding with transaction...'
                            : 'The statement is actually true.'}
                    </Text>
                    {!isCorrect && (
                        <Text style={styles.explanationText}>{explanation}</Text>
                    )}
                </View>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: SPACING.l,
        backgroundColor: '#0B0E14',
    },
    header: {
        alignItems: 'center',
        marginBottom: SPACING.xl,
    },
    headerIconWrap: {
        width: 72,
        height: 72,
        borderRadius: 22,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        fontSize: 24,
        fontWeight: '700',
        color: COLORS.text,
        marginTop: SPACING.m,
    },
    subtitle: {
        fontSize: 16,
        color: '#8B929E',
        textAlign: 'center',
        marginTop: SPACING.s,
    },
    statementBox: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 20,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.25)',
    },
    statementLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: '#4A8EE8',
        letterSpacing: 2,
        marginBottom: SPACING.s,
        textTransform: 'uppercase',
    },
    statementText: {
        fontSize: 18,
        color: COLORS.text,
        lineHeight: 26,
        fontWeight: '600',
    },
    whyLink: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'center',
        gap: 4,
        marginBottom: SPACING.m,
    },
    whyLinkText: {
        fontSize: 13,
        color: '#9CA3AF',
        textDecorationLine: 'underline',
    },
    whyInfoBox: {
        backgroundColor: 'rgba(74,142,232,0.08)',
        padding: SPACING.m,
        borderRadius: 14,
        marginBottom: SPACING.m,
        borderLeftWidth: 3,
        borderLeftColor: '#4A8EE8',
    },
    whyInfoText: {
        fontSize: 13,
        color: '#8B929E',
        lineHeight: 18,
    },
    buttonsContainer: {
        flexDirection: 'row',
        gap: SPACING.m,
        marginBottom: SPACING.xl,
    },
    answerButton: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.l,
        borderRadius: 20,
        borderWidth: 1,
        gap: SPACING.xs,
    },
    trueButton: {
        backgroundColor: 'rgba(0,230,118,0.06)',
        borderColor: 'rgba(0,230,118,0.30)',
    },
    trueButtonSelected: {
        backgroundColor: '#4CC38A',
        borderColor: '#4CC38A',
    },
    trueButtonCorrect: {
        backgroundColor: '#4CC38A',
        borderColor: '#4CC38A',
    },
    falseButton: {
        backgroundColor: 'rgba(255,71,87,0.06)',
        borderColor: 'rgba(255,71,87,0.30)',
    },
    falseButtonSelected: {
        backgroundColor: COLORS.error,
        borderColor: COLORS.error,
    },
    falseButtonWrong: {
        backgroundColor: COLORS.error,
        borderColor: COLORS.error,
    },
    answerButtonText: {
        fontSize: 18,
        fontWeight: '800',
        color: COLORS.text,
        letterSpacing: 1,
    },
    answerButtonTextSelected: {
        color: '#0B0E14',
    },
    answerButtonSubtext: {
        fontSize: 12,
        color: '#8B929E',
    },
    answerButtonSubtextSelected: {
        color: 'rgba(11, 15, 26, 0.6)',
    },
    resultBox: {
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.l,
        flexDirection: 'column',
        gap: SPACING.s,
    },
    resultBoxCorrect: {
        backgroundColor: 'rgba(0,230,118,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(0,230,118,0.30)',
    },
    resultBoxWrong: {
        backgroundColor: 'rgba(255,71,87,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255,71,87,0.30)',
    },
    resultText: {
        fontSize: 16,
        fontWeight: '700',
        color: COLORS.text,
    },
    explanationText: {
        fontSize: 14,
        color: '#8B929E',
        lineHeight: 20,
        marginTop: SPACING.s,
    },
});

export default UnderstandingTest;
