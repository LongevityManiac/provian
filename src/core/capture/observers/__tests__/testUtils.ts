/**
 * Shared helpers for observer unit tests.
 *
 * Each per-provider test loads its synthetic fixture, instantiates a
 * happy-dom Window, writes the fixture into it, and hands the Document
 * to the provider's observer. This helper centralizes that setup so
 * fixture loading is consistent across tests.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';

export interface LoadedFixture {
    window: Window;
    document: Window['document'];
    html: string;
}

export function loadFixture(providerId: string): LoadedFixture {
    const path = resolve(
        __dirname,
        '..',
        '..',
        'fixtures',
        `${providerId}.synthetic.html`,
    );
    const html = readFileSync(path, 'utf8');
    const window = new Window();
    window.document.write(html);
    window.document.close();
    return { window, document: window.document, html };
}
