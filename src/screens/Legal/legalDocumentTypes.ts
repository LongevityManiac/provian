// Shape of the in-app legal documents generated from docs/legal/*.md by
// scripts/generate-legal-app-content.mjs.
export interface LegalSpan {
    text: string;
    bold?: boolean;
}

export type LegalBlock =
    | { type: 'section'; text: string }
    | { type: 'subsection'; text: string }
    | { type: 'paragraph'; spans: LegalSpan[] }
    | { type: 'notice'; spans: LegalSpan[] }
    | { type: 'bullets'; items: LegalSpan[][] }
    | { type: 'table'; header: string[]; rows: LegalSpan[][][] };

export interface LegalDocument {
    /** SHA-256 of the parsed content; the identity a person's acceptance is recorded against. */
    version: string;
    title: string;
    lastUpdated: string;
    footer: string;
    blocks: LegalBlock[];
}
