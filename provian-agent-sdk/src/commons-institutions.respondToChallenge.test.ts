/**
 * Burn-to-present PRESENTER convenience — respondToChallenge + parseChallengePayload.
 *
 * The direction-agnostic one-call presenter primitive: parse a requester's
 * challenge → burn the exact tier floor → present → return the token. Every
 * assertion is paired with its RED negative control : the parser's
 * guards are shown REJECTING, and the wiring is shown NOT firing when the input is
 * bad, so a green test cannot be vacuous.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommonsInstitutions, type CommonsInstitutionsConfig } from './commons-institutions';
import { parseChallengePayload } from './presentation-verify';
import { burnIdForTx } from './presentation';

const BASE_CONFIG: CommonsInstitutionsConfig = {
  relayUrl: 'https://relay.test',
  walletId: 'wallet_aw_test',
  apiKey: 'pvn_live_abc123',
  apiSecret: 'pvns_' + 'x'.repeat(64),
};

const KEY = 'a'.repeat(64);
const BURN_TX = '0x' + 'be'.repeat(32);
const BURN_ID = burnIdForTx('base', BURN_TX);
const fakeSendBurn = async (p: { amountAtomic: string | bigint }) =>
  ({ txHash: BURN_TX, burnId: BURN_ID, amountAtomic: String(p.amountAtomic), chain: 'base' as const });
const RPC = 'https://base-rpc.test';
const AUD = '0xe326648bdf12a802c8b811037c527ada833f5d77';
const CHAL = 'f113f5b5b81fae6c92a14c541795565 8e8dc4356010b6f356292a028d08e1628f'.replace(/ /g, '');

describe('parseChallengePayload', () => {
  it('parses a well-formed challenge with predicates', () => {
    const out = parseChallengePayload(
      JSON.stringify({ audience: AUD, challenge: CHAL, predicates: [{ field: 'continuity.streak_days', op: 'gte', threshold: 1 }] }),
    );
    expect(out).not.toBeNull();
    expect(out!.audience).toBe(AUD);
    expect(out!.challenge).toBe(CHAL);
    expect(out!.predicates).toEqual([{ field: 'continuity.streak_days', op: 'gte', threshold: 1 }]);
  });

  it('parses a bare challenge (no predicates → omitted)', () => {
    const out = parseChallengePayload(JSON.stringify({ audience: AUD, challenge: CHAL }));
    expect(out).not.toBeNull();
    expect(out!.predicates).toBeUndefined();
  });

  // RED negative controls — each MUST return null (the guard fires).
  it('rejects non-JSON', () => {
    expect(parseChallengePayload('not json')).toBeNull();
  });
  it('rejects a missing audience', () => {
    expect(parseChallengePayload(JSON.stringify({ challenge: CHAL }))).toBeNull();
  });
  it('rejects a too-short challenge (< 16 chars)', () => {
    expect(parseChallengePayload(JSON.stringify({ audience: AUD, challenge: 'short' }))).toBeNull();
  });
  it('rejects a malformed predicate (bad op)', () => {
    expect(
      parseChallengePayload(JSON.stringify({ audience: AUD, challenge: CHAL, predicates: [{ field: 'x', op: 'BOGUS', threshold: 1 }] })),
    ).toBeNull();
  });
});

describe('CommonsInstitutions.respondToChallenge', () => {
  let institutions: CommonsInstitutions;
  let burnSpy: ReturnType<typeof vi.spyOn>;
  let presentSpy: ReturnType<typeof vi.spyOn>;
  let floorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    institutions = new CommonsInstitutions(BASE_CONFIG);
    vi.spyOn(institutions, 'preflightPresentation').mockResolvedValue();
    burnSpy = vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    presentSpy = vi
      .spyOn(institutions, 'present')
      .mockResolvedValue({ tier: 'reputation', presentation: { ok: true }, token: 'TOKEN' });
    // 15 PVT atomic reputation floor by default; overridden per-test where needed.
    floorSpy = vi.spyOn(institutions, 'presentationFloorAtomic').mockResolvedValue(15n * 10n ** 18n);
  });

  it('predicated challenge → reputation tier, burns the resolved floor, echoes predicates', async () => {
    const predicates = [{ field: 'continuity.streak_days', op: 'gte' as const, threshold: 1 }];
    const r = await institutions.respondToChallenge(
      { audience: AUD, challenge: CHAL, predicates },
      { privateKeyHex: KEY, rpcUrl: RPC },
    );
    expect(r.token).toBe('TOKEN');
    expect(r.tier).toBe('reputation');
    expect(floorSpy).toHaveBeenCalledWith('reputation');
    // Burned EXACTLY the resolved floor (never an under-burn, never a guess).
    expect(burnSpy).toHaveBeenCalledWith(expect.objectContaining({ amountAtomic: 15n * 10n ** 18n, rpcUrl: RPC }));
    // Burn happens BEFORE present, and present consumes that burnId.
    expect(burnSpy.mock.invocationCallOrder[0]).toBeLessThan(presentSpy.mock.invocationCallOrder[0]);
    // present carries the burn's tx so the relay records it at finality inside /present.
    expect(presentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'reputation', burnId: BURN_ID, audience: AUD, challenge: CHAL, disclosure: { redact: [], predicates },
        burnTx: { txHash: BURN_TX, amountAtomic: '15000000000000000000', chain: 'base' },
      }),
    );
    expect(r.burnId).toBe(BURN_ID);
    expect(r.txHash).toBe(BURN_TX);
  });

  it('bare challenge → pe_fact tier (cheaper floor), no disclosure', async () => {
    floorSpy.mockResolvedValue(5n * 10n ** 18n);
    const r = await institutions.respondToChallenge({ audience: AUD, challenge: CHAL }, { privateKeyHex: KEY, rpcUrl: RPC });
    expect(r.tier).toBe('pe_fact');
    expect(floorSpy).toHaveBeenCalledWith('pe_fact');
    expect(presentSpy).toHaveBeenCalledWith(expect.objectContaining({ tier: 'pe_fact', disclosure: undefined }));
  });

  it('honors an explicit burnAmountAtomic override (does not re-query the floor)', async () => {
    await institutions.respondToChallenge({ audience: AUD, challenge: CHAL }, { privateKeyHex: KEY, rpcUrl: RPC, burnAmountAtomic: '7000000000000000000' });
    expect(floorSpy).not.toHaveBeenCalled();
    expect(burnSpy).toHaveBeenCalledWith(expect.objectContaining({ amountAtomic: 7n * 10n ** 18n }));
  });

  // RED controls — the guard fires and NOTHING is burned (no money moves).
  it('rejects predicates at the pe_fact tier — never burns', async () => {
    await expect(
      institutions.respondToChallenge(
        { audience: AUD, challenge: CHAL, predicates: [{ field: 'x', op: 'gte', threshold: 1 }] },
        { privateKeyHex: KEY, rpcUrl: RPC, tier: 'pe_fact' },
      ),
    ).rejects.toThrow(/reputation tier/);
    expect(burnSpy).not.toHaveBeenCalled();
    expect(presentSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed challenge string — never burns', async () => {
    await expect(institutions.respondToChallenge('not json', { privateKeyHex: KEY, rpcUrl: RPC })).rejects.toThrow();
    expect(burnSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing rpcUrl — never burns', async () => {
    await expect(
      institutions.respondToChallenge({ audience: AUD, challenge: CHAL }, { privateKeyHex: KEY, rpcUrl: '' }),
    ).rejects.toThrow(/rpcUrl/);
    expect(burnSpy).not.toHaveBeenCalled();
  });
});
