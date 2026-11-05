/**
 * Agents that live on their own cloud computers are invited in the app : the
 * connect-an-agent screen, the Earn tab and the Vision tab each say such an agent connects with
 * the same one command and earns from the work it does there. App copy describes the class and
 * names no product (a Grok Bot is named only on the website's developers page and FAQ).
 *
 * Since the copy simplification of 2026-10-22 the Connect chooser's agent card and the Earn card
 * are each one line, so the class is named in that line (a computer of its own in the cloud) and
 * the "machine itself witnesses each command" fact lives in the What earns row under Details.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCALES = ['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh'] as const;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const locale = (l: string): Json =>
    JSON.parse(readFileSync(resolve(__dirname, `../../i18n/locales/${l}.json`), 'utf8')) as Json;

/** The word each language uses for the cloud (or the Mac mini every version also names). */
const CLOUD = /Mac mini|cloud|nube|nuvem|wingu|awan|ulap|đám mây|云|クラウド|클라우드|क्लाउड/u;

describe('cloud-computer agents are invited in the app', () => {
    it('English: connect, Earn and Vision each name the class; What earns says the machine witnesses its commands', () => {
        const en = locale('en');
        expect(en.connectAgent.agentPathBody).toMatch(/computer of its own in the cloud/);
        expect(en.connectAgent.whatEarns2).toMatch(/own cloud computer.*machine itself witnesses each command/);
        expect(en.earn.surfaces.connected_agents.description)
            .toMatch(/computer of its own in the cloud.*witnessed where it runs and mints PVT, mostly for you/);
        expect(en.visionScreen.card5Body)
            .toMatch(/computer of its own in the cloud connects with the same one command and earns from the work it does there/);
    });

    for (const l of LOCALES) {
        it(`${l}: the connect, Earn and Vision copy names no product for the class`, () => {
            const j = locale(l);
            const texts = [
                ...Object.values(j.connectAgent as Record<string, string>),
                ...Object.values(j.earn.surfaces.connected_agents as Record<string, string>),
                j.visionScreen.card5Body as string,
            ];
            for (const text of texts) expect(text).not.toMatch(/Grok Bot|Muse/);
        });

        it(`${l}: every invitation line is translated (not left in English) and names the class`, () => {
            const j = locale(l);
            const en = locale('en');
            if (l !== 'en') {
                expect(j.connectAgent.agentPathBody).not.toBe(en.connectAgent.agentPathBody);
                expect(j.connectAgent.whatEarns2).not.toBe(en.connectAgent.whatEarns2);
                expect(j.earn.surfaces.connected_agents.description).not.toBe(en.earn.surfaces.connected_agents.description);
            }
            // The chooser card, the Earn card and the Vision card each name the cloud computer.
            expect(j.connectAgent.agentPathBody).toMatch(CLOUD);
            expect(j.earn.surfaces.connected_agents.description).toMatch(CLOUD);
            expect(j.visionScreen.card5Body).toMatch(CLOUD);
        });
    }

    it('RED control: the class-free card bodies this test exists to refuse do not match', () => {
        expect('Any agent you run. It gets its own wallet.').not.toMatch(CLOUD);
        expect('Connect an AI agent and its work becomes proof it owns.').not.toMatch(CLOUD);
    });
});
