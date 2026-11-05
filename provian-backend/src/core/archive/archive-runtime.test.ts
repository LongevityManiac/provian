/**
 * Launch listings — who settles a new Archive charge is decided by the flip's own
 * switch, read on every request: the gas key until `PUBLIC_LAUNCH=true`, Coinbase's CDP facilitator
 * after. Nothing may settle through CDP (and so list the Archive in the public Bazaar) before go.
 */
import { describe, it, expect } from '@jest/globals';
import {
  ARCHIVE_CDP_SWITCH_ENV,
  CDP_KEY_ID_ENV,
  CDP_PRIVATE_KEY_ENV,
  archiveSettlementFromEnv,
  cdpFacilitatorFromEnv,
} from './archive-runtime';

const KEYS = { [CDP_KEY_ID_ENV]: 'organizations/x/apiKeys/y', [CDP_PRIVATE_KEY_ENV]: Buffer.alloc(64, 7).toString('base64') };

describe('archive settlement switch', () => {
  it('the switch is the flip variable itself', () => {
    expect(ARCHIVE_CDP_SWITCH_ENV).toBe('PUBLIC_LAUNCH');
  });

  it.each([undefined, '', 'false', 'TRUE', '1', 'yes', ' true'])('PUBLIC_LAUNCH=%p settles with the gas key', (value) => {
    const env: NodeJS.ProcessEnv = { ...KEYS };
    if (value !== undefined) env[ARCHIVE_CDP_SWITCH_ENV] = value;
    expect(archiveSettlementFromEnv(env).mode()).toBe('relay_gas_key');
  });

  it("PUBLIC_LAUNCH='true' settles through CDP", () => {
    expect(archiveSettlementFromEnv({ ...KEYS, [ARCHIVE_CDP_SWITCH_ENV]: 'true' }).mode()).toBe('cdp_facilitator');
  });

  it('the switch is read per request, not at construction', () => {
    const env: NodeJS.ProcessEnv = { ...KEYS };
    const settlement = archiveSettlementFromEnv(env);
    expect(settlement.mode()).toBe('relay_gas_key');
    env[ARCHIVE_CDP_SWITCH_ENV] = 'true';
    expect(settlement.mode()).toBe('cdp_facilitator');
    env[ARCHIVE_CDP_SWITCH_ENV] = 'false';
    expect(settlement.mode()).toBe('relay_gas_key');
  });

  it('CDP is configured only when both halves of the onramp key are present', () => {
    expect(cdpFacilitatorFromEnv({})).toBeNull();
    expect(cdpFacilitatorFromEnv({ [CDP_KEY_ID_ENV]: KEYS[CDP_KEY_ID_ENV] })).toBeNull();
    expect(cdpFacilitatorFromEnv({ [CDP_PRIVATE_KEY_ENV]: KEYS[CDP_PRIVATE_KEY_ENV] })).toBeNull();
    expect(cdpFacilitatorFromEnv({ [CDP_KEY_ID_ENV]: '  ', [CDP_PRIVATE_KEY_ENV]: KEYS[CDP_PRIVATE_KEY_ENV] })).toBeNull();
    expect(cdpFacilitatorFromEnv(KEYS)).not.toBeNull();
    expect(archiveSettlementFromEnv(KEYS).cdp).not.toBeNull();
    expect(archiveSettlementFromEnv({}).cdp).toBeNull();
  });
});
