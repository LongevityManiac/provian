/**
 * F35: the sovereign key is never accepted on argv — only via
 * PROVIAN_AGENT_PRIVATE_KEY or `--from-stdin`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import { resolveSovereignPrivateKey, normalizeSovereignKey } from './sovereign-key-intake';

const KEY = 'a'.repeat(64);

describe('resolveSovereignPrivateKey (F35)', () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.PROVIAN_AGENT_PRIVATE_KEY;
    delete process.env.PROVIAN_AGENT_PRIVATE_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.PROVIAN_AGENT_PRIVATE_KEY;
    else process.env.PROVIAN_AGENT_PRIVATE_KEY = savedKey;
  });

  it('[RED] a --private-key flag on argv is IGNORED (no env, no stdin → empty)', async () => {
    // Pre-fix the CLI read flags['private-key'] and signed with it; argv is no
    // longer a recognized source, so a stray flag yields no key.
    const got = await resolveSovereignPrivateKey(
      { 'private-key': KEY },
      Readable.from([]) as unknown as NodeJS.ReadableStream,
    );
    expect(got).toBe('');
  });

  it('reads the key from PROVIAN_AGENT_PRIVATE_KEY (0x stripped)', async () => {
    process.env.PROVIAN_AGENT_PRIVATE_KEY = `0x${KEY}`;
    const got = await resolveSovereignPrivateKey({}, Readable.from([]) as unknown as NodeJS.ReadableStream);
    expect(got).toBe(KEY);
  });

  it('reads the key from stdin only with --from-stdin', async () => {
    const got = await resolveSovereignPrivateKey(
      { 'from-stdin': true },
      Readable.from([`${KEY}\n`]) as unknown as NodeJS.ReadableStream,
    );
    expect(got).toBe(KEY);
  });

  it('does NOT read stdin without --from-stdin (argv-only call yields empty)', async () => {
    const got = await resolveSovereignPrivateKey(
      {},
      Readable.from([`${KEY}\n`]) as unknown as NodeJS.ReadableStream,
    );
    expect(got).toBe('');
  });

  it('rejects a malformed key on stdin', async () => {
    await expect(
      resolveSovereignPrivateKey({ 'from-stdin': true }, Readable.from(['nothex\n']) as unknown as NodeJS.ReadableStream),
    ).rejects.toThrow(/64-character hex/i);
  });

  it('rejects more than one line on stdin', async () => {
    await expect(
      resolveSovereignPrivateKey({ 'from-stdin': true }, Readable.from([`${KEY}\n${KEY}\n`]) as unknown as NodeJS.ReadableStream),
    ).rejects.toThrow(/exactly one line/i);
  });

  it('normalizeSovereignKey strips 0x and validates length', () => {
    expect(normalizeSovereignKey(`0x${KEY}`)).toBe(KEY);
    expect(() => normalizeSovereignKey('0xdead')).toThrow(/64-character hex/i);
  });
});
