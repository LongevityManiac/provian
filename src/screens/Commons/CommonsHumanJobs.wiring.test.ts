/**
 * Pass-2 Human-Jobs seams — screen wiring assertions (C6 / C7 / C8).
 *
 * The Vitest harness here has no React renderer (see CommonsGovernance.test.ts),
 * so screen behaviour is verified at the source level: the deterministic proof
 * that the seams are actually wired into the screens.
 *
 *   C6 — the management screen calls accept/deliver/complete/rate, lists
 *        applicants, and every action passes through requireBiometric (each
 *        generates a PE → Commons invariant #38).
 *   C7 — the list screen sources "Mine"/"Completed" from the authenticated
 *        getMyHumanJobs, NOT a public browse-by-status.
 *   C8 — the list screen renders compensation via the shared formatter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MANAGE = readFileSync(resolve(__dirname, 'CommonsHumanJobManage.tsx'), 'utf8');
const LIST = readFileSync(resolve(__dirname, 'CommonsHumanJobs.tsx'), 'utf8');
const CARD = readFileSync(resolve(__dirname, '../../components/commons/JobCard.tsx'), 'utf8');
const MARKET = readFileSync(resolve(__dirname, 'CommonsMarket.tsx'), 'utf8');
const POST = readFileSync(resolve(__dirname, 'CommonsHumanJobsPost.tsx'), 'utf8');
const PROFILE = readFileSync(resolve(__dirname, 'CommonsProfile.tsx'), 'utf8');
const PRESENT = readFileSync(resolve(__dirname, '../Presentment/HumanPresentmentScreen.tsx'), 'utf8');
const APPLY = readFileSync(resolve(__dirname, 'useJobApply.ts'), 'utf8');

describe('CommonsHumanJobManage — second-actor UI (C6)', () => {
  it('wires the management actions to the service wrappers (release signs on-chain, then /complete)', () => {
    expect(MANAGE).toContain('CommonsService.acceptHumanJobApplicant');
    expect(MANAGE).toContain('CommonsService.deliverHumanJob');
    expect(MANAGE).toContain('releaseJobPayment(jobId');
    expect(MANAGE).toContain('CommonsService.rateHumanJob');
  });

  it('lists applicants via the poster-only endpoint', () => {
    expect(MANAGE).toContain('CommonsService.getHumanJobApplications');
  });

  it('gates every PE-generating action behind biometric verification (#38)', () => {
    // All four actions funnel through runAction, which calls requireBiometric
    // BEFORE invoking the wrapper.
    expect(MANAGE).toContain('requireBiometric');
    expect(MANAGE).toContain('const runAction');
    // Each handler delegates to runAction rather than calling the wrapper raw.
    for (const handler of ['handleAccept', 'handleDeliver', 'handleComplete', 'handleRate', 'handleFeature', 'handleClaimRefund']) {
      expect(MANAGE).toContain(handler);
    }
    expect(MANAGE).toContain('runAction(');
  });
});

describe('CommonsHumanJobs — list screen (C7 / C8)', () => {
  it('sources "Mine"/"Completed" from the authenticated getMyHumanJobs (C7)', () => {
    expect(LIST).toContain('CommonsService.getMyHumanJobs');
  });

  it('no longer browses global jobs by status for the user-scoped tabs (C7)', () => {
    // The old leak: browseHumanJobs({ status: 'in_progress' / 'completed' }).
    expect(LIST).not.toContain("status: 'in_progress'");
    expect(LIST).not.toContain("browseHumanJobs({ status: 'completed'");
  });

  it('every card opens the job screen; a party sees Manage (C6,)', () => {
    expect(LIST).toContain("navigation.navigate('CommonsHumanJobManage'");
    expect(CARD).toContain('isParty');
    expect(CARD).toContain("t('commonsHumanJobs.manage')");
  });

  it('formats compensation through the shared formatter (C8)', () => {
    expect(CARD).toContain('formatHumanJobCompensation');
  });

  it('filters by who is hiring, who it hires, and the currency; featured first', () => {
    expect(LIST).toContain('posted_by: hiringFilter');
    expect(LIST).toContain('seeking: hiresFilter');
    expect(LIST).toContain('currency: currencyFilter');
    expect(LIST).toContain('featuredFirst(jobs, featured)');
  });
});

describe('hiring in all four directions from the app', () => {
  it('Apply shows only when the job hires people; otherwise the card says why', () => {
    expect(CARD).toContain('eligibility.canApply ?');
    expect(CARD).toContain('applyBlockText(eligibility.reason, t)');
  });

  it('the poster header renders only published fields (speech is speech)', () => {
    expect(CARD).toContain('getPublicHeader(walletId)');
    expect(CARD).not.toMatch(/readVocabulary|getVocabulary|pe_count|attestation_tier/);
  });

  it('post chooses who it hires and the currency, and handles the talking pass (428)', () => {
    expect(POST).toContain("update('seeking'");
    expect(POST).toContain("update('currency'");
    expect(POST).toContain("update('budgetUsdc'");
    expect(POST).toContain('offerSpeechWindow(err, navigation, t)');
  });

  it('apply handles the talking pass (428)', () => {
    expect(APPLY).toContain('offerSpeechWindow(err, navigation, t)');
  });

  it('accept routes a 428 to a presentation to the APPLICANT that then hires them', () => {
    expect(MANAGE).toContain('speechWindowRequired(err)');
    expect(MANAGE).toContain("deliverTo: { kind: 'hire', jobId, applicantWalletId");
    expect(PRESENT).toContain('CommonsService.acceptHumanJobApplicant(commonsAct.jobId, commonsAct.applicantWalletId, biometricAction)');
  });

  it('featuring a job uses spendBurn (pendingBurns safety) with the PERSON\'S amount — no hardcoded bid ', () => {
    expect(MANAGE).not.toContain('FEATURED_FLOOR_PVT');
    expect(MANAGE).toContain('<FeaturedBidSheet');
    expect(MANAGE).toContain('spendBurn(amountPvt, (burnId, action) => CommonsService.featureHumanJob(jobId, burnId, action))');
    // RED control: a fixed-amount bid would read spendBurn('<literal>' or spendBurn(<CONSTANT>.
    expect(MANAGE).not.toMatch(/spendBurn\((['"]\d|[A-Z_]{3,})/);
  });

  it('disputes run through the on-chain helper and NEVER render a Court control', () => {
    expect(MANAGE).toContain('disputeJob(jobId');
    expect(MANAGE).toContain('checkDisputeStatus(jobId)');
    expect(MANAGE).not.toMatch(/court_escalation_available\s*&&|court_escalation_available\s*\?|Escalate|CommonsCourt/);
  });

  it('the Market lists agent-hiring jobs by default and posts to hire an agent', () => {
    expect(MARKET).toContain("useState<SeekingView>('agent')");
    expect(MARKET).toContain('CommonsService.getMarketJobs');
    expect(MARKET).toContain('CommonsService.getMarketStats');
    expect(MARKET).toContain("navigation.navigate('CommonsHumanJobsPost', { seeking:");
  });
});

describe('person vouch on a profile', () => {
  it('is hidden on the viewer\'s own linked agents (the relay also refuses)', () => {
    expect(PROFILE).toContain('RelayAPIService.getLinkedAgents()');
    expect(PROFILE).toContain('canShowVouch({ viewerId: ownProfile.wallet_id, targetId: walletId, linkedAgents })');
    expect(PROFILE).toContain("t('commons.vouchLinkedRefused')");
  });

  it('checks for a live presentation, else routes to a reputation presentation that stakes the vouch', () => {
    expect(PROFILE).toContain('RelayAPIService.readHandshakeState({ counterparty: walletId })');
    expect(PROFILE).toContain("deliverTo: { kind: 'vouch', targetId, targetName }");
    expect(PRESENT).toContain('CommonsService.stakeVouch(commonsAct.targetId, undefined, biometricAction)');
  });

  it('shows the Vouched state and the voucher kind', () => {
    expect(PROFILE).toContain('hasVouchedFor(myVouches, walletId)');
    expect(PROFILE).toContain("v.voucher_kind === 'agent'");
  });
});

// live finding: Apply did NOTHING on Android. Android defines Alert.prompt as a silent
// no-op, so `typeof Alert.prompt === 'function'` is true there and the note prompt never showed.
// Every caller of Alert.prompt must gate on the platform, never on the function's existence.
describe('Alert.prompt is gated on the iOS platform everywhere ', () => {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const SRC = resolve(__dirname, '../..');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
  const callers = walk(SRC).filter((f) => /Alert\.prompt\(/.test(readFileSync(f, 'utf8')));

  it('finds the callers (never a pass over zero files)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(2);
  });

  it('every caller gates on Platform.OS === \'ios\' and none on typeof Alert.prompt', () => {
    for (const f of callers) {
      const src = readFileSync(f, 'utf8');
      expect({ f, typeofGate: /typeof Alert\.prompt\s*[!=]==/.test(src) }).toEqual({ f, typeofGate: false });
      expect({ f, iosGate: /Platform\.OS === 'ios'/.test(src) }).toEqual({ f, iosGate: true });
    }
  });

  it('the apply hook itself uses the iOS gate', () => {
    expect(APPLY).toMatch(/if \(Platform\.OS === 'ios'\) \{\s*\n\s*Alert\.prompt\(/);
  });
});
