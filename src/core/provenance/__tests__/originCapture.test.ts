import { describe, it, expect } from 'vitest';
import {sha256} from '@noble/hashes/sha2';
import {bytesToHex,utf8ToBytes} from '@noble/hashes/utils';
const secret=utf8ToBytes('existing-owner-test-secret');
import {
    resolvableOrigin, privateOrigin, urlOrigins, domainOf, PRIVATE_FILE, PRIVATE_URL_PATH,
} from '../originCapture';

describe('originCapture (app) — privacy classifier (Prompt 2)', () => {
    it('resolvableOrigin: identifier in the clear + sync sha256 hash', () => {
        const o = resolvableOrigin('provider:claude');
        expect(o.origin_identifier).toBe('provider:claude');
        expect(o.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(o.witnessed).toBe(false); // no witness → actor-supplied
    });

    it('privateOrigin: only a type tag in origin_identifier; raw value owner-secret-bound', () => {
        const o = privateOrigin(PRIVATE_FILE, '/data/user/secret.db',null,secret);
        expect(o.origin_identifier).toBe(PRIVATE_FILE);
        expect(o.origin_identifier).not.toContain('secret');
        expect(o.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('urlOrigins: domain resolvable + path private; no plaintext path leak', () => {
        const os = urlOrigins('https://claude.ai/chat/SECRET_SESSION_ID',null,secret);
        expect(os[0].origin_identifier).toBe('domain:claude.ai');
        expect(os[1].origin_identifier).toBe(PRIVATE_URL_PATH);
        for (const o of os) expect(o.origin_identifier).not.toContain('SECRET_SESSION_ID');
    });

    it('matches the SDK/backend digest convention (sha256 hex, lowercased)', () => {
        // Stable digest so cross-package reasoning holds (the hash is sha256(identifier)).
        const o = resolvableOrigin('provider:claude');
        expect(o.hash.length).toBe('sha256:'.length + 64);
    });

    it('RED the old digest recovers a guessed path, while the owner-secret MAC cannot be matched by that dictionary',()=>{
        const path='/data/user/secret.db',guess='sha256:'+bytesToHex(sha256(utf8ToBytes(path)));
        expect(guess).toBe('sha256:'+bytesToHex(sha256(utf8ToBytes(path))));
        expect(privateOrigin(PRIVATE_FILE,path,null,secret).hash).not.toBe(guess);
        expect(privateOrigin(PRIVATE_FILE,path,null,secret).hash).not.toBe(privateOrigin(PRIVATE_FILE,path,null,utf8ToBytes('other-existing-owner-secret')).hash);
        expect(()=>privateOrigin(PRIVATE_FILE,path)).toThrow('owner-held secret');
    });

    // RED: a bare provider is resolvable (kept), but nothing private leaks.
    it('RED: domainOf rejects non-http(s) and garbage', () => {
        expect(domainOf('app://x')).toBeNull();
        expect(domainOf('claude.ai')).toBeNull(); // no scheme → not parseable as http(s)
        expect(domainOf('https://claude.ai/x')).toBe('claude.ai');
    });
});
