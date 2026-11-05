/**
 * settlement runtime — SERVER-AUTHORED PROVENANCE. The Genesis lane settles, honestly.
 *
 * ── THE HISTORY THIS FILE CARRIES ────────────────────────────────────────────
 * M7 shipped an inlet in which every Genesis grant was permanently and silently ineligible:
 * `signatureVerified` was a boolean fed from `attestation_verified`, the Genesis writer never
 * sets it, so eligibility rejected `signature_not_verified`. Worse, the fork harness had
 * hard-coded `attestation_verified: true` and thereby "proved" a 74.25 PVT settlement that
 * production could never reproduce.
 *
 * The resolution was NOT to set the flag. A Genesis PE is authored by the relay from a
 * qualifying act it observed; there is no earner signature, so claiming a verified one is a
 * security assertion nothing checked — the exact defect the false fixture embodied.
 * `submission-provenance.ts` introduces a third value instead: `server_authored`, distinct from
 * both verified and unverified, fully eligible, and priced by the attestation tier like any
 * other act.
 *
 * ── WHAT THIS FILE GUARDS NOW ────────────────────────────────────────────────
 * The rule the operator set, made executable: **nothing may ever write a verification-true value for a
 * server-authored PE.** If a writer starts doing so the PE does not become more valuable — it
 * becomes INELIGIBLE (`provenance_contradictory`) and these tests fail. The incentive points the
 * right way: a false attestation costs the mint rather than earning one.
 */

import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { GENESIS_PREV_HASH } from '../../pe/constants';
import type { PEHistoryDocument } from '../../../pe-history';
import { PVT9_ELIGIBILITY_CUT_LINE_MS, evaluateEligibility } from '../wp-ev/eligibility';
import {
  RELAY_VERIFIED_INTEGRATION_SOURCES,
  SERVER_AUTHORED_INTEGRATION_SOURCES,
  SUBMISSION_PROVENANCE_MULTIPLIERS,
  classifySubmissionProvenance,
} from '../wp-ev/submission-provenance';
import { projectEligibility } from './claim-inlet-source';

const BACKEND_ROOT = path.resolve(__dirname, '../../../..');

/** Every `.ts` under a root, so the source sweep binds to the tree and not to a hand-kept list. */
function walkTypeScript(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkTypeScript(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
const POST_CUT_LINE = PVT9_ELIGIBILITY_CUT_LINE_MS + 5_000;
const ANCHOR = `0x${'5a'.repeat(32)}`;

/**
 * A `pe_history` doc shaped the way the GENESIS path actually writes one.
 *
 * `attestation_verified` is ABSENT, because `generatePE` never sets it. That absence is now the
 * expected, correct shape rather than the thing that blocked the lane.
 */
function genesisHistoryAsProductionWritesIt(): Partial<PEHistoryDocument> {
  return {
    peId: 'pe-genesis-1',
    userId: 'user-1',
    timestamp: POST_CUT_LINE,
    attestationDepth: 'software',
    mint_status: 'eligible',
    record_points_atomic: '75000000000000000000',
    corroboration_status: 'none',
    is_genesis_grant: true,
    replication_pack: null,
  };
}

/** The envelope `generatePE` writes — including the `integration_source` that names its author. */
function sealedEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pe-genesis-1',
    prev_hash: GENESIS_PREV_HASH,
    hash: `0x${'6e'.repeat(32)}`,
    timestamp: POST_CUT_LINE,
    action_type: 'genesis_human_signup',
    user_id: 'user-1',
    integration_source: 'agent_bank_generate_pe',
    ...overrides,
  };
}

function judgeGenesisPe(
  history: Partial<PEHistoryDocument>,
  envelope: Record<string, unknown> = sealedEnvelope(),
) {
  return evaluateEligibility(projectEligibility({
    peId: 'pe-genesis-1',
    history: history as Record<string, unknown>,
    envelope,
    identity: {
      id: 'pe-genesis-1',
      prev_hash: GENESIS_PREV_HASH,
      hash: `0x${'6e'.repeat(32)}`,
      timestamp: POST_CUT_LINE,
      action_type: 'genesis_human_signup',
      user_id: 'user-1',
    },
    chainVerified: true,
    oneTimeAnchor: ANCHOR,
  }));
}

describe('server-authored Genesis PEs are eligible, and honestly so', () => {
  it('ADMITS a Genesis PE written exactly the way production writes it', () => {
    const verdict = judgeGenesisPe(genesisHistoryAsProductionWritesIt());
    expect(verdict.kind).toBe('eligible');
    if (verdict.kind !== 'eligible') throw new Error('unreachable');
    // Priced by its TIER, like any other software-attested act. That is the point: eligibility
    // was never the right lever, and the tier is doing the pricing it was built for.
    expect(verdict.attestationTier).toBe('software');
    expect(verdict.weightMultiplier).toBe(0.8);
  });

  it('projects it as server_authored — not verified, and not unverified either', () => {
    const projected = projectEligibility({
      peId: 'pe-genesis-1',
      history: genesisHistoryAsProductionWritesIt() as Record<string, unknown>,
      envelope: sealedEnvelope(),
      identity: null,
      chainVerified: true,
      oneTimeAnchor: ANCHOR,
    });
    expect(projected.submissionProvenance).toBe('server_authored');

    // RED CONTROL: the same history with no recognised author is `unverified` and is REFUSED.
    // Without this, "server_authored" could be a value the projection hands to everything.
    const anonymous = projectEligibility({
      peId: 'pe-genesis-1',
      history: genesisHistoryAsProductionWritesIt() as Record<string, unknown>,
      envelope: sealedEnvelope({ integration_source: 'some_unclassified_writer' }),
      identity: null,
      chainVerified: true,
      oneTimeAnchor: ANCHOR,
    });
    expect(anonymous.submissionProvenance).toBe('unverified');
    expect(judgeGenesisPe(
      genesisHistoryAsProductionWritesIt(),
      sealedEnvelope({ integration_source: 'some_unclassified_writer' }),
    ).kind).toBe('ineligible');
  });

  it('THE RULE: a verification-true value on a server-authored PE makes it INELIGIBLE', () => {
    // The guard the operator asked for. This is the exact fixture that produced M7's false proof, and
    // it must now cost the mint rather than earn one.
    const verdict = judgeGenesisPe({
      ...genesisHistoryAsProductionWritesIt(),
      attestation_verified: true,
    });
    expect(verdict.kind).toBe('ineligible');
    if (verdict.kind !== 'ineligible') throw new Error('unreachable');
    expect(verdict.reasons).toEqual(['provenance_contradictory']);

    // And it cannot be laundered through the explicitly recorded field either.
    expect(classifySubmissionProvenance({
      attestationVerified: true,
      integrationSource: 'agent_bank_generate_pe',
      recordedProvenance: 'server_authored',
    })).toBe('contradictory');
    expect(classifySubmissionProvenance({
      attestationVerified: undefined,
      integrationSource: 'agent_bank_generate_pe',
      recordedProvenance: 'earner_signed',
    })).toBe('server_authored');
  });

  it('the relay-observed agent_linked source is classified, so its contradiction guard can fire', () => {
    // Reviewer defect 1 on. `relay_agent_connect` was added as a new
    // RELAY-AUTHORED writer without being registered in the allowlist. Two
    // consequences, both proved here rather than argued:
    //
    //  (a) unregistered, the relay's own observation classified as `unverified`
    //      — "a signature was expected and is not verified" — when in truth no
    //      earner signs a connect at all.
    //  (b) worse, the `contradictory` guard could not fire for it: an
    //      `attestation_verified: true` stamp would have yielded `earner_signed`
    //      and SETTLEABLE, which is precisely the conflation this module exists
    //      to refuse. Registration is what restores the guard.
    expect(classifySubmissionProvenance({
      attestationVerified: undefined,
      integrationSource: 'relay_agent_connect',
    })).toBe('server_authored');
    expect(classifySubmissionProvenance({
      attestationVerified: false,
      integrationSource: 'relay_agent_connect',
    })).toBe('server_authored');

    // THE CONTROL: verified-true on a server-authored act is a contradiction,
    // and it must fire for this source exactly as it does for `relay_action`.
    expect(classifySubmissionProvenance({
      attestationVerified: true,
      integrationSource: 'relay_agent_connect',
    })).toBe('contradictory');
    expect(classifySubmissionProvenance({
      attestationVerified: true,
      integrationSource: 'relay_action',
    })).toBe('contradictory');

    // ...and it cannot be laundered through the recorded field either.
    expect(classifySubmissionProvenance({
      attestationVerified: true,
      integrationSource: 'relay_agent_connect',
      recordedProvenance: 'server_authored',
    })).toBe('contradictory');
  });

  it('STRUCTURAL: every server-authored writer is swept, and the pairing is accounted for', () => {
    // M9 — THIS TEST USED TO BE A UNIVERSALLY-QUANTIFIED CLAIM OVER A POPULATION OF ONE.
    // Its comment said "every file that writes a server-authored `integration_source` is
    // checked"; it read exactly one hard-coded path (`agent-bank/pe-utils.ts`), never enumerated
    // `SERVER_AUTHORED_INTEGRATION_SOURCES`, and never scanned `server.ts`. It therefore missed
    // that `coinbase_onramp_verifier` is written together with `attestation_verified: true` — a
    // live earning path that M8 silently turned `contradictory` and permanently unsettleable.
    //
    // The sweep is now real: enumerate the allowlist, find every file that writes each source,
    // and require any file that ALSO writes the verified-true pairing to be declared
    // relay-verified. Counts are asserted so the sweep cannot pass over an empty population.
    const files = walkTypeScript(path.join(BACKEND_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(200);
    // The exclusion below must remove exactly one file, never quietly grow into a hole.
    expect(files.filter((f) => f.endsWith('submission-provenance.ts'))).toHaveLength(1);

    const VERIFIED_TRUE = /attestation_verified\s*:\s*true/;
    // Proximity, not file-level co-occurrence. `server.ts` is ~11k lines and writes many
    // unrelated PEs; "this file mentions the source somewhere and also says verified-true
    // somewhere" would flag everything and prove nothing. A shared builder pair sits within a
    // few dozen lines — the real one (`buildAccrualParams` / `buildOnrampStoredDoc`) is 25 apart.
    const WINDOW = 40;
    const sourcesFound = new Map<string, string[]>();
    const pairedWithVerifiedTrue = new Map<string, string[]>();

    // The classifier module itself is excluded: it DECLARES the two sets and its own doc comment
    // quotes the forbidden pairing to explain it. Counting the definition as a writer would make
    // every source look paired — the self-referential hit, where the check finds the data it was
    // built from. It writes no PE; `src/pe-history.ts` and `server.ts` do.
    const CLASSIFIER = path.join(BACKEND_ROOT, 'src/core/pvt/wp-ev/submission-provenance.ts');
    let sweptFiles = 0;

    for (const file of files) {
      if (file.endsWith('.test.ts') || file === CLASSIFIER) continue;
      sweptFiles += 1;
      const lines = readFileSync(file, 'utf8').split('\n');
      const rel = path.relative(BACKEND_ROOT, file);
      for (const source of SERVER_AUTHORED_INTEGRATION_SOURCES) {
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i].includes(`'${source}'`) && !lines[i].includes(`"${source}"`)) continue;
          sourcesFound.set(source, [...(sourcesFound.get(source) ?? []), `${rel}:${i + 1}`]);
          const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
          if (VERIFIED_TRUE.test(near)) {
            pairedWithVerifiedTrue.set(
              source, [...(pairedWithVerifiedTrue.get(source) ?? []), `${rel}:${i + 1}`],
            );
          }
        }
      }
    }

    // Every allowlisted source must be traceable to at least one real writer — an entry nothing
    // writes is a rule about nothing, and would make the sweep below vacuous for that source.
    for (const source of SERVER_AUTHORED_INTEGRATION_SOURCES) {
      expect({ source, writers: sourcesFound.get(source) ?? [] })
        .toEqual({ source, writers: expect.arrayContaining([expect.any(String)]) });
    }

    // THE ASSERTION: a source written alongside `attestation_verified: true` must be DECLARED
    // relay-verified. Otherwise the pairing is the contradiction the gate exists to catch, and
    // the writer's PEs would be refused without anyone deciding that.
    const undeclared = [...pairedWithVerifiedTrue.keys()]
      .filter((source) => !RELAY_VERIFIED_INTEGRATION_SOURCES.has(source))
      .sort();
    expect(undeclared).toEqual([]);

    // And the population that assertion ran over is non-empty in both directions: at least one
    // source IS paired (so the filter had something to reject), and the declared set is a strict
    // subset of the allowlist (so it did not simply swallow everything).
    expect(sweptFiles).toBeGreaterThan(200);
    expect(pairedWithVerifiedTrue.size).toBeGreaterThan(0);
    // The one real pairing, named — so a future change that stops finding it is visible rather
    // than silently reducing this to a sweep that rejects nothing.
    expect([...(pairedWithVerifiedTrue.get('coinbase_onramp_verifier') ?? [])].join(','))
      .toContain('src/server.ts:');
    expect(RELAY_VERIFIED_INTEGRATION_SOURCES.size)
      .toBeLessThan(SERVER_AUTHORED_INTEGRATION_SOURCES.size);
    for (const declared of RELAY_VERIFIED_INTEGRATION_SOURCES) {
      expect(SERVER_AUTHORED_INTEGRATION_SOURCES.has(declared)).toBe(true);
    }

    // The Genesis emitter specifically still sets nothing, which is what makes every Genesis
    // grant `server_authored` rather than `contradictory`.
    const emitter = readFileSync(
      path.join(BACKEND_ROOT, 'src/core/agent-bank/pe-utils.ts'), 'utf8',
    );
    expect(emitter.includes('attestation_verified')).toBe(false);

    // The default it therefore falls back to, read from the writer itself.
    const writer = readFileSync(path.join(BACKEND_ROOT, 'src/pe-history.ts'), 'utf8');
    expect(writer).toContain('attestation_verified: params.attestation_verified ?? false');

    // RED CONTROL: the predicate finds the string when it IS present, so the assertion above is
    // not passing because the check is broken.
    expect(writer.includes('attestation_verified')).toBe(true);
    // RED CONTROL for the sweep itself: the pairing regex matches the shape it is looking for.
    expect(VERIFIED_TRUE.test('  attestation_verified: true,')).toBe(true);
    expect(VERIFIED_TRUE.test('  attestation_verified: false,')).toBe(false);
  });

  it('RED — an UNdeclared server-authored source paired with verified-true is contradictory', () => {
    // The rule the sweep enforces, exercised directly: the relay-verified carve-out is a
    // subset, not a hole. Everything outside it keeps the strict behaviour.
    for (const source of SERVER_AUTHORED_INTEGRATION_SOURCES) {
      const expected = RELAY_VERIFIED_INTEGRATION_SOURCES.has(source)
        ? 'server_authored'
        : 'contradictory';
      expect(classifySubmissionProvenance({
        attestationVerified: true, integrationSource: source,
      })).toBe(expected);
    }
    // The live path this restored: eligible again, and priced by its tier like any other act.
    expect(classifySubmissionProvenance({
      attestationVerified: true, integrationSource: 'coinbase_onramp_verifier',
    })).toBe('server_authored');
  });

  it('2026-08-16 seam ruling: the human wallet_created writer is CLASSIFIED server-authored', () => {
    // `routes/human-wallet-registration.ts` — the relay authors the birth certificate from
    // a registration it processed itself; no earner signature exists on the PE. Unclassified,
    // both production wallet_created rows landed `unverified` and refused
    // `signature_not_verified` at settlement.
    expect(SERVER_AUTHORED_INTEGRATION_SOURCES.has('human_wallet_registration')).toBe(true);
    expect(classifySubmissionProvenance({
      attestationVerified: undefined, integrationSource: 'human_wallet_registration',
    })).toBe('server_authored');
    // RED CONTROL — the contradiction guard still protects the source: a future
    // verification-true stamp on it refuses rather than mints.
    expect(classifySubmissionProvenance({
      attestationVerified: true, integrationSource: 'human_wallet_registration',
    })).toBe('contradictory');
  });

  it('the server-authored source list is an ALLOWLIST — a new writer is not admitted by default', () => {
    expect(SERVER_AUTHORED_INTEGRATION_SOURCES.has('agent_bank_generate_pe')).toBe(true);
    expect(SERVER_AUTHORED_INTEGRATION_SOURCES.has('mobile_pe_submit')).toBe(false);
    expect(SERVER_AUTHORED_INTEGRATION_SOURCES.has('brand_new_writer')).toBe(false);
    // Unknown = block: an unclassified writer lands on `unverified`, which does not settle.
    expect(classifySubmissionProvenance({
      attestationVerified: undefined, integrationSource: 'brand_new_writer',
    })).toBe('unverified');
  });

  it('applies NO discount to server-authored acts — the dimension is named, not tuned', () => {
    // Discounting server-authored work relative to earner-signed work is an economic decision
    // and none has been approved. Both admissible values are 1.0 deliberately.
    expect(SUBMISSION_PROVENANCE_MULTIPLIERS.earner_signed).toBe(1.0);
    expect(SUBMISSION_PROVENANCE_MULTIPLIERS.server_authored).toBe(1.0);
    // The two inadmissible values are 0 because they do not settle — that is not a price.
    expect(SUBMISSION_PROVENANCE_MULTIPLIERS.unverified).toBe(0);
    expect(SUBMISSION_PROVENANCE_MULTIPLIERS.contradictory).toBe(0);
  });

  it('the earner-signed path still works and is still distinct', () => {
    const standard = evaluateEligibility(projectEligibility({
      peId: 'pe-standard-1',
      history: {
        peId: 'pe-standard-1',
        userId: 'user-2',
        timestamp: POST_CUT_LINE,
        attestationDepth: 'software',
        attestation_verified: true,
        mint_status: 'eligible',
        record_points_atomic: '1000000000000000000',
        corroboration_status: 'none',
        replication_pack: {
          input_hash: null,
          output_hash: `0x${'ab'.repeat(32)}`,
          model_id: null,
          model_checkpoint_hash: null,
          pack_hash: null,
        },
      } as Record<string, unknown>,
      envelope: sealedEnvelope({
        id: 'pe-standard-1',
        action_type: 'agent_task_completed',
        integration_source: 'mobile_pe_submit',
      }),
      identity: {
        id: 'pe-standard-1',
        prev_hash: GENESIS_PREV_HASH,
        hash: `0x${'7e'.repeat(32)}`,
        timestamp: POST_CUT_LINE,
        action_type: 'agent_task_completed',
        user_id: 'user-2',
      },
      chainVerified: true,
    }));
    expect(standard.kind).toBe('eligible');
  });
});
