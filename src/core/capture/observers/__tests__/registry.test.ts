import { describe, it, expect } from 'vitest';
import {
    OBSERVERS,
    getObserver,
    observeClaude,
    observeChatGPT,
    observeGemini,
    observePerplexity,
    observeGrok,
    observeVenice,
} from '../';

describe('observer registry', () => {
    it('has one entry per launch provider', () => {
        expect(Object.keys(OBSERVERS).sort()).toEqual([
            'chatgpt',
            'claude',
            'gemini',
            'grok',
            'perplexity',
            'venice',
        ]);
    });

    it('each entry points at the corresponding pure observer', () => {
        expect(OBSERVERS.claude).toBe(observeClaude);
        expect(OBSERVERS.chatgpt).toBe(observeChatGPT);
        expect(OBSERVERS.gemini).toBe(observeGemini);
        expect(OBSERVERS.perplexity).toBe(observePerplexity);
        expect(OBSERVERS.grok).toBe(observeGrok);
        expect(OBSERVERS.venice).toBe(observeVenice);
    });

    it('getObserver returns null for unknown providers', () => {
        expect(getObserver('copilot')).toBeNull();
        expect(getObserver('')).toBeNull();
    });

    it('getObserver returns a function for known providers', () => {
        expect(typeof getObserver('claude')).toBe('function');
        expect(typeof getObserver('grok')).toBe('function');
    });
});
