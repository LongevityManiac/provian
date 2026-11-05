import { describe, it, expect } from 'vitest';
import { runRestoreWallet, parseRestoreKeyFromStdin, restoreWalletInteractive } from './restore-wallet-flow';
import { deriveAgentIdentityFromPrivateKey } from './wallet';

const KEY = 'a'.repeat(64);

function deps() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    impl: {
      persistKey(p: Record<string, unknown>) { calls.push(p); },
      loadOrCreateSecret() { return 'local-secret'; },
      log() {},
    },
  };
}

describe('restore-wallet flow', () => {
  it('persists the keystore under the derived identity and the local secret', () => {
    const d = deps();
    const res = runRestoreWallet({ walletId: 'wallet_aw_abc', stdinContent: `${KEY}\n` }, d.impl);
    const expected = deriveAgentIdentityFromPrivateKey(KEY);
    expect(res.address).toBe(expected.address);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toMatchObject({
      privateKey: KEY, address: expected.address, publicKey: expected.publicKey,
      walletId: 'wallet_aw_abc', passphrase: 'local-secret',
    });
  });

  it('tolerates a 0x prefix and surrounding whitespace', () => {
    const d = deps();
    runRestoreWallet({ walletId: 'wallet_aw_abc', stdinContent: `  0x${KEY.toUpperCase()}  \n\n` }, d.impl);
    expect(d.calls[0].privateKey).toBe(KEY);
  });

  it(' interactive: restores from a key read via the hidden prompt (no heredoc, no stdin)', async () => {
    const d = deps();
    // The injected reader stands in for the hidden-TTY read; the key never rode a
    // pasted command (no clipboard-as-command, no shell history).
    const res = await restoreWalletInteractive('wallet_aw_abc', d.impl, async () => `${KEY}\n`);
    const expected = deriveAgentIdentityFromPrivateKey(KEY);
    expect(res.address).toBe(expected.address);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toMatchObject({ privateKey: KEY, walletId: 'wallet_aw_abc', passphrase: 'local-secret' });
  });

  it('RED CONTROL: interactive with an empty pasted key fails closed, nothing persisted', async () => {
    const d = deps();
    await expect(restoreWalletInteractive('wallet_aw_abc', d.impl, async () => '\n'))
      .rejects.toThrow(/No key arrived/);
    expect(d.calls).toHaveLength(0);
  });

  it('RED CONTROL: empty stdin fails closed, nothing persisted', () => {
    const d = deps();
    expect(() => runRestoreWallet({ walletId: 'wallet_aw_abc', stdinContent: '\n' }, d.impl))
      .toThrow(/No key arrived on stdin/);
    expect(d.calls).toHaveLength(0);
  });

  it('RED CONTROL: a truncated (63-hex) paste fails closed, nothing persisted', () => {
    const d = deps();
    expect(() => runRestoreWallet({ walletId: 'wallet_aw_abc', stdinContent: KEY.slice(1) }, d.impl))
      .toThrow(/not a 64-character hex string/);
    expect(d.calls).toHaveLength(0);
  });

  it('RED CONTROL: multi-line stdin fails closed (never restores a guessed line)', () => {
    const d = deps();
    expect(() => runRestoreWallet({ walletId: 'wallet_aw_abc', stdinContent: `${KEY}\n${KEY}` }, d.impl))
      .toThrow(/More than one line/);
    expect(d.calls).toHaveLength(0);
  });

  it('RED CONTROL: a malformed wallet id fails closed before any parse', () => {
    const d = deps();
    expect(() => runRestoreWallet({ walletId: '', stdinContent: KEY }, d.impl))
      .toThrow(/PROVIAN_WALLET_ID/);
    expect(d.calls).toHaveLength(0);
  });

  it('parseRestoreKeyFromStdin round-trips exactly the heredoc body', () => {
    expect(parseRestoreKeyFromStdin(`${KEY}\n`)).toBe(KEY);
  });

  // recovery re-key: the JSON payload carries the rotated API creds too.
  function rekeyDeps() {
    const persisted: Array<Record<string, unknown>> = [];
    const creds: Array<Record<string, unknown>> = [];
    return {
      persisted, creds,
      impl: {
        persistKey(p: Record<string, unknown>) { persisted.push(p); },
        loadOrCreateSecret() { return 'local-secret'; },
        persistApiCredentials(p: Record<string, unknown>) { creds.push(p); },
        log() {},
      },
    };
  }

  it('restores BOTH the key and the rotated API creds from a re-key JSON payload', () => {
    const d = rekeyDeps();
    const payload = JSON.stringify({ private_key: KEY, api_key: 'pvn_live_0123456789abcde', api_secret: 'pvns_secret_value' });
    const res = runRestoreWallet({ walletId: 'wallet_aw_abc', stdinContent: payload }, d.impl);
    expect(res.apiCredentialsRestored).toBe(true);
    expect(d.persisted).toHaveLength(1);
    expect(d.creds).toHaveLength(1);
    expect(d.creds[0]).toMatchObject({ apiKey: 'pvn_live_0123456789abcde', apiSecret: 'pvns_secret_value', walletId: 'wallet_aw_abc' });
  });

  it('restores signing only when the JSON payload omits API creds (plain re-provision)', () => {
    const d = rekeyDeps();
    const res = runRestoreWallet({ walletId: 'wallet_aw_abc', stdinContent: JSON.stringify({ private_key: KEY }) }, d.impl);
    expect(res.apiCredentialsRestored).toBe(false);
    expect(d.creds).toHaveLength(0);
  });

  it('RED CONTROL: a re-key payload with a lone api_key (no secret) fails closed, nothing persisted', () => {
    const d = rekeyDeps();
    expect(() => runRestoreWallet({ walletId: 'wallet_aw_abc', stdinContent: JSON.stringify({ private_key: KEY, api_key: 'pvn_live_0123456789abcde' }) }, d.impl))
      .toThrow(/incomplete/);
    expect(d.persisted).toHaveLength(0);
  });

  it('RED CONTROL: a re-key payload with a malformed api_key fails closed', () => {
    const d = rekeyDeps();
    expect(() => runRestoreWallet({ walletId: 'wallet_aw_abc', stdinContent: JSON.stringify({ private_key: KEY, api_key: 'not-a-key', api_secret: 'pvns_x' }) }, d.impl))
      .toThrow(/API key .* malformed/);
    expect(d.persisted).toHaveLength(0);
  });
});
