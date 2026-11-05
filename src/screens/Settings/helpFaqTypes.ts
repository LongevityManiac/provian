// Shape of the in-app FAQ structure generated from docs/help/faq.md by scripts/generate-help-faq.mjs.
export interface HelpFaqItem {
    questionKey: string;
    answerKey: string;
    /** The answer shown while the Genesis window is open, when the question has one. */
    genesisAnswerKey?: string;
}

export interface HelpFaqSection {
    /** The section's key under help.faq (also picks its icon). */
    key: string;
    titleKey: string;
    items: HelpFaqItem[];
}
