import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, GRADIENTS } from '../../constants/theme';
import BackButton from '../../components/BackButton';
import type { LegalBlock, LegalDocument, LegalSpan } from './legalDocumentTypes';

/**
 * Renders a canonical legal document (docs/legal/*.md, generated into
 * *Content.generated.ts) with complete, source-bound convenience translations. Acceptance remains bound
 * to the canonical English document version served on the website.
 */

const Spans = ({ spans }: { spans: LegalSpan[] }) => (
    <>
        {spans.map((span, index) => (
            <Text key={index} style={span.bold ? styles.bold : undefined}>{span.text}</Text>
        ))}
    </>
);

const Block = ({ block }: { block: LegalBlock }) => {
    switch (block.type) {
        case 'section':
            return <Text style={styles.sectionHeader}>{block.text}</Text>;
        case 'subsection':
            return <Text style={styles.subHeader}>{block.text}</Text>;
        case 'paragraph':
            return <Text style={styles.paragraph}><Spans spans={block.spans} /></Text>;
        case 'notice':
            return (
                <View style={styles.warningBox}>
                    <Text style={styles.importantText}><Spans spans={block.spans} /></Text>
                </View>
            );
        case 'bullets':
            return (
                <View style={styles.bulletList}>
                    {block.items.map((item, index) => (
                        <View key={index} style={styles.bulletItem}>
                            <Text style={styles.bullet}>•</Text>
                            <Text style={styles.bulletText}><Spans spans={item} /></Text>
                        </View>
                    ))}
                </View>
            );
        case 'table':
            return (
                <View style={styles.bulletList}>
                    {block.rows.map((row, rowIndex) => (
                        <View key={rowIndex} style={styles.tableRow}>
                            {row.map((cell, cellIndex) => (
                                <Text key={cellIndex} style={cellIndex === 0 ? styles.tableLead : styles.bulletText}>
                                    {cellIndex === 0 ? null : <Text style={styles.bold}>{`${block.header[cellIndex]}: `}</Text>}
                                    <Spans spans={cell} />
                                </Text>
                            ))}
                        </View>
                    ))}
                </View>
            );
    }
};

const LegalDocumentScreen = ({
    navigation,
    headerTitle,
    document,
}: {
    navigation: { goBack: () => void };
    headerTitle: string;
    document: LegalDocument;
}) => {
    const { t } = useTranslation();

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={COLORS.chrome} />
                <Text style={styles.headerTitle}>{headerTitle}</Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={true}>
                <Text style={styles.lastUpdated}>{t('ui.legal.lastUpdated', { date: document.lastUpdated })}</Text>
                <Text style={styles.lastUpdated}>{t('legal.languageNotice')}</Text>

                {document.blocks.map((block, index) => (
                    <Block key={index} block={block} />
                ))}

                <View style={styles.footer}>
                    <Text style={styles.footerNote}>{document.footer}</Text>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.text,
    },
    content: {
        padding: SPACING.l,
        paddingBottom: SPACING.xl * 3,
    },
    lastUpdated: {
        fontSize: 14,
        color: COLORS.textSecondary,
        marginBottom: SPACING.l,
        fontStyle: 'italic',
    },
    warningBox: {
        backgroundColor: 'rgba(255, 179, 0, 0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255, 179, 0, 0.20)',
        borderRadius: 18,
        padding: SPACING.m,
        marginBottom: SPACING.m,
    },
    sectionHeader: {
        fontSize: 11,
        fontWeight: '600',
        letterSpacing: 2,
        textTransform: 'uppercase',
        color: '#9CA3AF',
        marginTop: SPACING.xl,
        marginBottom: SPACING.m,
    },
    subHeader: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.chromeMuted,
        marginTop: SPACING.m,
        marginBottom: SPACING.s,
    },
    paragraph: {
        fontSize: 14,
        color: '#8B929E',
        lineHeight: 22,
        marginBottom: SPACING.m,
    },
    bold: {
        fontWeight: '600',
        color: COLORS.text,
    },
    importantText: {
        fontSize: 14,
        color: COLORS.text,
        fontWeight: '600',
        lineHeight: 22,
    },
    bulletList: {
        marginBottom: SPACING.m,
    },
    bulletItem: {
        flexDirection: 'row',
        marginBottom: SPACING.xs,
        paddingLeft: SPACING.s,
    },
    bullet: {
        fontSize: 14,
        color: COLORS.primary,
        marginRight: SPACING.s,
        lineHeight: 22,
    },
    bulletText: {
        fontSize: 14,
        color: COLORS.textSecondary,
        flex: 1,
        lineHeight: 22,
    },
    tableRow: {
        borderLeftWidth: 2,
        borderLeftColor: 'rgba(200,205,214,0.15)',
        paddingLeft: SPACING.m,
        marginBottom: SPACING.m,
    },
    tableLead: {
        fontSize: 14,
        lineHeight: 22,
        color: COLORS.text,
        marginBottom: SPACING.xs,
    },
    footer: {
        marginTop: SPACING.xl * 2,
        paddingTop: SPACING.l,
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.08)',
    },
    footerNote: {
        fontSize: 12,
        color: '#9CA3AF',
        textAlign: 'center',
        fontStyle: 'italic',
    },
});

export default LegalDocumentScreen;
