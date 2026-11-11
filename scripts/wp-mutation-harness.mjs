#!/usr/bin/env node
// wp-mutation-harness.mjs — mutation-adequacy prover for the WP contract suites.
//
// WHY THIS EXISTS
// The institution parameters run recorded a mutation MISREAD: a surviving mutant was reported as
//   killed because the check scraped the tail of `forge test` output instead of
// reading the structured result (`institution parameters_RUN_LOG.md`, "Caught by re-grepping
//   before commit, not by the suite"). It also recorded harness INTERFERENCE:
//   two agents mutating the same tracked sources at once produced a contaminated
//   verdict ("never run a mutation harness on tracked sources while a review
//   subagent is mutating the same files").
//
//   This harness replaces that manual methodology. It:
//     1. runs the suite SCOPED to the target contract (never the whole tree),
//     2. decides KILLED / SURVIVED from forge's `--json` result — NEVER `tail -1`,
//     3. restores the source BYTE-IDENTICAL after every mutation (sha256-verified),
//     4. reports per mutation and exits non-zero if ANY mutant survives or errors.
//
//   EXCLUSIVE ACCESS: this harness mutates tracked sources in place. Nothing else
//   may write to contracts/src while it runs. The wp-reviewer agent therefore runs
//   in a SEPARATE git worktree (see .claude/agents/wp-reviewer.md), so its probes
//   never collide with a harness run in the build tree.
//
// USAGE
//   node scripts/wp-mutation-harness.mjs --contract ProvianPromiseV3
//   node scripts/wp-mutation-harness.mjs --contract ProvianPromiseV3 --list
//   node scripts/wp-mutation-harness.mjs --contract ProvianPromiseV3 --only M2,M5
//
// EXIT CODES
//   0  every selected mutation KILLED and the source restored byte-identical
//   1  a mutant SURVIVED, a mutation spec was stale/invalid, forge errored, or
//      the source could not be restored byte-identical (fatal)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// ---------------------------------------------------------------------------
// Mutation registry — one entry per target contract.
//
//   sourcePath    : contract source, relative to repo root (the file mutated).
//   testMatchPath : forge --match-path glob, relative to `contracts/` (the
//                   scoped suite; must cover EVERY test file exercising the
//                   contract, e.g. both the base suite and the cost-machinery
//                   suite).
//   mutations     : each { id, description, find, replace, expectedKilledBy }.
//                   `find` MUST occur exactly once in the pristine source (the
//                   harness asserts this) and `replace` MUST break PRODUCTION
//                   behavior — never a test. `expectedKilledBy` is documentation
//                   only; the pass/fail verdict comes from the suite, not the name.
//
// activation clock / institution parameters-rem / bond lifecycle / agent directory register ProvianEscrowV4, ProvianPoolV3,
// ProvianBondPool and ProvianCourtV2 here following the identical shape, and
// prove each with `--contract <Name>` before merging that WP.
// ---------------------------------------------------------------------------
const MUTATION_SETS = {
  'restoration-binding-log': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-binding-log.ts', testMatchPath: 'src/core/recourse/restoration-binding-log.test.ts src/core/recourse/determination-execution.test.ts',
    mutations: [{ id: 'BINDING-LOG-POSITIVE', description: 'missing historical binding is treated as a block before the loss',
      find: 'bound < 1n', replace: 'false', expectedKilledBy: 'unbound binding proof refuses' },
      { id: 'BINDING-LOG-ORDER', description: 'same-block binding after the loss grants protection',
        find: 'if (index >= loss.firstOutflowLogIndex)', replace: 'if (false)', expectedKilledBy: 'late-log binding proof refuses' },
      { id: 'BINDING-LOG-REORG', description: 'orphaned binding evidence survives the final checkpoint reread',
        find: 'if (await port.blockHash(loss.block) !== loss.blockHash)', replace: 'if (false)', expectedKilledBy: 'reorg binding proof refuses' }],
  },
  'restoration-succession-trace': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-succession-trace.ts', testMatchPath: 'src/core/recourse/restoration-succession-trace.test.ts',
    mutations: [{ id: 'TRACE-ACTUAL-SUCCESSOR', description: 'a phantom final-generation break turns current holdings into unreachable rights',
      find: 'sourceGeneration.index + 1 >= checkpoint.generations.length', replace: 'false', expectedKilledBy: 'observation of the current generation cannot invent a future break and turn reachable PVT into a pool shortfall' },
      { id: 'TRACE-CURRENT-KERNEL', description: 'retired real balances become current reversal sources',
      find: 'row.ref.kernel !== checkpoint.executionKernel', replace: 'false', expectedKilledBy: 'historical real balances cannot become current sources even without a restoration' },
      { id: 'TRACE-EXCHANGE', description: 'witnessed or unresolved consideration is treated as gratuitous',
        find: 'incomingProtected = carried;', replace: 'incomingReversible = carried;', expectedKilledBy: 'witnessed and unresolved exchange protection survives every carry and cannot become a reversal source' },
      { id: 'TRACE-CLOSING', description: 'missing history is accepted without endpoint balance reconciliation',
        find: 'value.balance !== amount(row.closingAtomic)', replace: 'false', expectedKilledBy: 'wrong-closing refuses instead of inflating a reversal or pool shortfall' },
      { id: 'TRACE-LOSS', description: 'a different ledger silently substitutes an absent original loss',
        find: 'if (seen.size !== expected.size)', replace: 'if (false)', expectedKilledBy: 'a reconciled ledger cannot silently substitute an absent original loss event' },
      { id: 'TRACE-CLEAN-ISSUANCE', description: 'new work replenishes a spent theft trail',
        find: 'min(source?.reversible ?? 0n, quantity)', replace: 'min(source?.balance ?? 0n, quantity)', expectedKilledBy: 'new work after spending the entire recovered trail cannot taint an unrelated later recipient' },
      { id: 'TRACE-REFUND-LIMIT', description: 'all reached value can reverse despite a lower refund-net loss',
        find: 'reversible = min(reachable, outstanding)', replace: 'reversible = reachable', expectedKilledBy: 'refund-net loss limits allocate only the exact outstanding amount across current sources' }],
  },
  'restoration-executor-runtime': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-executor-runtime.ts', testMatchPath: 'src/core/recourse/restoration-executor-runtime.test.ts',
    mutations: [{ id: 'EXECUTOR-CODE', description: 'changed executable byte is accepted as reviewed implementation',
      find: 'if (masked !== template.runtime)', replace: 'if (false)', expectedKilledBy: 'opcode implementation fails before its getters can be trusted' },
      { id: 'EXECUTOR-PRIVATE-PROOF', description: 'a substituted private proof verifier accepts arbitrary owner authorizations',
        find: 'if (keccak256(await port.code(proof, pin)) !== template.proofVerifierHash)', replace: 'if (false)', expectedKilledBy: 'private-verifier substitution refuses' },
      { id: 'EXECUTOR-ANCESTORS', description: 'inherited owner state is trusted from a fake prior executor',
        find: 'executor = account(words.previousAuthorization);', replace: 'executor = zero;', expectedKilledBy: 'ordinary inheritance authenticates the prior executor instead of trusting getter-shaped state' }],
  },
  'restoration-receipt-interval': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-receipt-interval.ts', testMatchPath: 'src/core/recourse/restoration-receipt-interval.test.ts src/core/recourse/restoration-break-receipt.test.ts',
    mutations: [{ id: 'RECEIPT-EXACT-MINT', description: 'restoration amount can be backed by a different mint amount',
      find: 'mints[0].transfer!.args.amount !== BigInt(owner.amount)', replace: 'false', expectedKilledBy: 'wrong-amount mint refuses' },
      { id: 'RECEIPT-INTERVAL', description: 'a mint outside this execution is counted as its restoration',
        find: 'log.logIndex > start.log.logIndex && log.logIndex < logIndex', replace: 'true', expectedKilledBy: 'several restorations with identical mint destinations and amounts remain distinct within one wrapper receipt' },
      { id: 'RECEIPT-OWNER', description: 'another binding authorizes this restoration',
        find: 'start.consumed.args.identity !== owner.identity', replace: 'false', expectedKilledBy: 'wrong-binding cannot substitute another execution' }],
  },
  'restoration-break-receipt': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-break-receipt.ts', testMatchPath: 'src/core/recourse/restoration-break-receipt.test.ts src/core/recourse/restoration-break-receipt-chain.test.ts',
    mutations: [{ id: 'BREAK-RECEIPT-ORIGINAL-PIN', description: 'a same-manifest new resolver checkpoint replaces the original readiness checkpoint',
      find: 'return lineage;', replace: 'return { ...lineage, blockHash: (await currentProtocolDeployment()).blockHash };', expectedKilledBy: 'runtime verification and final caller fence retain the original lineage checkpoint across a same-manifest resolver replacement' },
      { id: 'BREAK-RECEIPT-CUTOFF', description: 'discarded post-cutoff restoration is treated as a current entitlement',
      find: 'through > next.cutoff', replace: 'false', expectedKilledBy: 'discarded tail after the immediate successor cutoff cannot issue the same carried entitlement twice' },
      { id: 'BREAK-RECEIPT-RUNTIME', description: 'getter-shaped executor bypasses implementation checks',
        find: 'await port.authenticateExecutor(executor, kernel, pin);', replace: '', expectedKilledBy: 'lookalike executor getters do not bypass independent implementation authentication' },
      { id: 'BREAK-RECEIPT-COMPLETENESS', description: 'local restoration log can be omitted despite consumed entitlement',
      find: 'if (logs.length !== (local ? 1 : 0))', replace: 'if (false)', expectedKilledBy: 'inherited-with-local restoration history refuses' },
      { id: 'BREAK-RECEIPT-HEADER', description: 'checkpoint reorg after verification is accepted',
        find: 'await port.chain.blockHash(through) !== pin', replace: 'false', expectedKilledBy: 'checkpoint-reorg after asynchronous reads refuses' },
      { id: 'BREAK-RECEIPT-MANIFEST', description: 'pointer changes during verification are accepted',
        find: 'if (await port.manifest() !== manifest)', replace: 'if (false)', expectedKilledBy: 'manifest after asynchronous reads refuses' }],
  },
  'restoration-break-partition': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-break-partition.ts', testMatchPath: 'src/core/recourse/restoration-break-partition.test.ts',
    mutations: [{ id: 'PARTITION-EXACT-TOTAL', description: 'a changed historical balance partition authorizes the same aggregate',
      find: 'total !== BigInt(owner.amount)', replace: 'false',
      expectedKilledBy: 'omitted bindings, changed balances and substituted ownership refuse rather than becoming pool shortfalls' },
      { id: 'PARTITION-UNCLAIMED-ONLY', description: 'already issued entitlement is counted again at the next break',
        find: 'if (priorOwner && !restored) {', replace: 'if (priorOwner) {',
        expectedKilledBy: 'claimed state is read from the effective predecessor executor at cutoff, not the original origin today' }],
  },
  'restoration-break-partition-chain': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-break-partition-chain.ts', testMatchPath: 'src/core/recourse/restoration-break-partition-chain.test.ts',
    mutations: [{ id: 'PARTITION-FIRST-BINDING', description: 'incomplete registry history omits an earlier effective binding',
      find: "|| await call(original, 'boundBlock', [account], throughHash) !== BigInt(first)", replace: '|| false',
      expectedKilledBy: 'refuses birth rather than substituting artifact-supplied account metadata' },
      { id: 'PARTITION-FINAL-CUTOFF', description: 'a late cutoff reorg preserves the assembled account list',
        find: "if (await blockHash(through) !== throughHash) throw Error('recourse_partition_reorg');", replace: 'void throughHash;',
        expectedKilledBy: 'a reorg of the final cutoff after earlier historical checks invalidates the entire enumeration' }],
  },
  'break-artifact-store': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/break-artifact-store.ts', testMatchPath: 'src/core/recourse/break-artifact-store.test.ts',
    mutations: [{ id: 'BREAK-STORE-READ-AUTHORITY', description: 'stored self-described roots substitute for current pointer ancestry',
      find: 'return authenticateBreakArtifact(origin, JSON.parse(payload) as unknown, lineage);',
      replace: 'const parsed = object(JSON.parse(payload)); return verifyBreakArtifact(parsed, {predecessor:String(parsed.predecessor),block:Number(parsed.block),root:String(parsed.root)});',
      expectedKilledBy: 'complete artifacts span bounded chunks, omit uncommitted metadata, and reauthenticate on every read' },
      { id: 'BREAK-STORE-PUBLISH-RECHECK', description: 'a changed origin publishes a manifest after writing chunks',
        find: 'await authenticateBreakArtifact(origin, JSON.parse(payload) as unknown, lineage);', replace: 'void payload;',
        expectedKilledBy: 'interrupted chunk writes cannot publish a usable manifest; a clean retry is idempotent' }],
  },
  'restoration-succession-lineage': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-lineage.ts', testMatchPath: 'src/core/recourse/restoration-lineage.test.ts',
    mutations: [{ id: 'LINEAGE-CANONICAL-HEAD', description: 'an unchanged manifest accepts orphaned import-ready state',
      find: "if (canonical.some(header => headerNumber(header) !== height)) throw Error('recourse_lineage_changed');", replace: 'void canonical;',
      expectedKilledBy: 'a same-manifest reorg during the final resolver cannot preserve orphaned import-ready state' },
      { id: 'LINEAGE-TYPED-COLLECTOR', description: 'ordinary transfer tracing accepts unissued cryptographic-break balances',
        find: "if (lineage.migrations.some(migration => migration.kind !== 'ordinary')) throw Error('recourse_lineage_invalid');", replace: 'void lineage;',
        expectedKilledBy: 'typed succession domains authenticate breaks without enabling them in the ordinary transfer collector' },
      { id: 'LINEAGE-BREAK-ANCESTOR', description: 'a cryptographic break accepts a substituted previous authorization',
        find: '(broken ? previous !== zero : previous !== predecessorExecutor)', replace: '(!broken && previous !== predecessorExecutor)',
        expectedKilledBy: 'typed succession domains authenticate breaks without enabling them in the ordinary transfer collector' }],
  },
  'break-artifact-verifier': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/break-artifact.ts', testMatchPath: 'src/break-artifact.test.ts',
    mutations: [{ id: 'BREAK-ARTIFACT-COMPLETE-ROOT', description: 'individual proofs substitute for complete-root reconstruction',
      find: "if (level[0] !== root) throw Error('break_artifact_incomplete');", replace: 'void level;',
      expectedKilledBy: 'valid individual proofs with an omitted owner cannot prove that owner absent' },
      { id: 'BREAK-ARTIFACT-UNCOMMITTED-METADATA', description: 'verified output retains uncommitted account partitions and signing roots',
        find: 'owners.push(Object.freeze({ ...owner, proof:', replace: 'owners.push(Object.freeze({ ...entry, ...owner, proof:',
        expectedKilledBy: 'complete root authenticates owner presence and absence but never the serialized account partition' }],
  },
  'break-artifacts': {
    runner: 'native-vitest', sourcePath: 'scripts/recourse/break-artifacts.mjs', testMatchPath: 'scripts/recourse/break-artifacts.test.mjs',
    mutations: [{ id: 'BREAK-ANCESTRY-CARRY', description: 'a new break silently drops earlier unissued entitlement artifacts',
      find: 'ownership: pending.snapshot }, ...older]', replace: 'ownership: pending.snapshot }]',
      expectedKilledBy: 'the actual snapshot assembly preserves prior artifacts in both ordinary and repeated-break output' }],
  },
  'restoration-bridge-ledger': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-bridge-ledger.ts',
    testMatchPath: 'src/core/recourse/restoration-bridge-ledger.test.ts src/core/recourse/restoration-succession-trace.test.ts',
    mutations: [{ id: 'BRIDGE-SUCCESSION-DOMAIN', description: 'ordinary succession can relabel value within the same token generation',
      find: 'bridge.destination.kernel === bridge.kernel', replace: 'false', expectedKilledBy: 'ordinary succession carries the whole historical balance between kernel domains, never an entitlement' },
      { id: 'BRIDGE-DESTINATION-CUTOFF', description: 'a restoration resurrects an already retired token balance',
      find: "if (ledger.consumed.has(destination)) throw Error('recourse_bridge_destination_consumed');", replace: 'void destination;',
      expectedKilledBy: 'a later restoration cannot resurrect an account already consumed at its kernel cutoff' },
      { id: 'BRIDGE-PROTECTION', description: 'a bridge upgrades protected exchange value to reversible funds',
        find: 'reversible += value.reversible; protectedValue += value.protected;',
        replace: 'reversible += value.reversible + value.protected; protectedValue += 0n;',
        expectedKilledBy: 'two unclaimed breaks carry protected and reversible components without creating spendable balances' },
      { id: 'BRIDGE-EXACT-SOURCE', description: 'an altered per-source partition passes because the aggregate matches',
        find: 'checkedComponents(value).balance !== source.amount', replace: 'checkedComponents(value).balance < 0n',
        expectedKilledBy: 'duplicates, partial balances and altered partitions refuse atomically, even with the same aggregate' }],
  },
  'hash-account-delivery': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/hash-account-delivery.ts',
    testMatchPath: 'src/hash-account-delivery.test.ts',
    mutations: [{ id: 'HASH-DELIVERY-FINALITY', description: 'an unfinalized outer revert releases a fresh gas attempt',
      find: "if (!finalized.every(Boolean)) return 'pending';", replace: 'void finalized;',
      expectedKilledBy: 'a new gas attempt requires a proven finalized outer revert and an explicit later invocation' },
      { id: 'HASH-DELIVERY-REPLAY', description: 'unmined retry silently substitutes another signed gas transaction',
        find: "if (replayed !== last.hash) throw Error('hash_delivery_replay_changed');", replace: 'void replayed;',
        expectedKilledBy: 'an unmined retry must reuse the exact signed transaction hash and still refuse retired targets' }],
  },
  'protocol-transaction': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/protocol-transaction.ts',
    testMatchPath: 'src/protocol-transaction.test.ts',
    mutations: [{ id: 'HASH-INNER-RETIREMENT', description: 'a hash account wrapper hides a retired inner target or spender',
      find: "if (input.slice(0, 10) === HASH_ACCOUNT_ABI.getFunction('execute')!.selector) {", replace: 'if (false) {',
      expectedKilledBy: 'hash account wrappers cannot hide retired inner targets or token approval spenders' },
      { id: 'HASH-HEX-CASE', description: 'mixed-case calldata bypasses nested retirement checks',
        find: 'let input = data?.toLowerCase();', replace: 'let input = data;',
        expectedKilledBy: 'mixed-case hex cannot hide hash wrappers or token approval selectors' }],
  },
  'recourse-membership-client': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/recourse-membership-client.ts',
    testMatchPath: 'src/recourse-membership-client.test.ts',
    mutations: [{ id: 'MEMBERSHIP-POST-SIGN', description: 'a pointer change during owner signing reaches the relay',
      find: 'await validateMembershipConsent(challenge, input.account, input.kind, network);', replace: 'void challenge;',
      expectedKilledBy: 'consent signs raw validated bytes and refuses a pointer change during signing' },
      { id: 'MEMBERSHIP-ALLOWANCE', description: 'owner approval permits more than the exact debit',
        find: 'parsed.domain.pool, parsed.allowanceAtomic, parsed.debit.revision',
        replace: 'parsed.domain.pool, (1n << 256n) - 1n, parsed.debit.revision',
        expectedKilledBy: 'exact approval is only burn plus reserve and has independently verified current token and pool' }],
  },
  'membership-debit-preparation': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/membership-debit-preparation.ts',
    testMatchPath: 'src/core/recourse/membership-debit-preparation.test.ts',
    mutations: [{ id: 'DEBIT-CHECKPOINT', description: 'new debit reserves a nonce absent from its canonical reconciliation checkpoint',
      find: 'debitMatchesCheckpoint(state, await readHistoricalRecoursePoolState(binding, account.checkpoint));', replace: 'void state;',
      expectedKilledBy: 'a consumed or recovery-changed nonce must finalize into the private checkpoint before new signing' }],
  },
  'membership-debit-operation': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/membership-debit-operation.ts',
    testMatchPath: 'src/core/recourse/membership-debit-operation.test.ts',
    mutations: [{ id: 'DEBIT-EXACT-RESERVATION', description: 'valid replacement signature changes an already reserved financial amount',
      find: "if (planned.id !== request.reservationId || !isDeepStrictEqual(planned, r)) return fail('reservation');", replace: 'void planned;',
      expectedKilledBy: 'altered payment cannot obtain attestation: burn' }],
  },
  'identity-attestor': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/identity-attestor.ts',
    testMatchPath: 'src/core/recourse/identity-attestor.test.ts',
    mutations: [{ id: 'ATTESTOR-MAGIC', description: 'contract refusal accepts an invalid identity signature',
      find: "result.toLowerCase() !== CONTRACT.encodeFunctionResult('isValidSignature', ['0x1626ba7e'])", replace: 'false',
      expectedKilledBy: 'curve and contract signatures use exactly the consumer message digest and pinned block' }],
  },
  'membership-preparation': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/membership-preparation.ts',
    testMatchPath: 'src/core/recourse/membership-preparation.test.ts',
    mutations: [{ id: 'PREPARING-RECOVERY', description: 'recovery strands a preparing membership transition',
      find: 'operation = await refreshRecoveredMembershipTransition(db, operation.id);\n    operation = await openPrivateMembershipConsents',
      replace: 'operation = await openPrivateMembershipConsents',
      expectedKilledBy: 'recovery during interrupted preparation refreshes the replacement before opening consents' },
      { id: 'CONSENT-RESUME', description: 'queued consent is presented as a fresh signature request',
        find: 'if (inFlight.length) pending.push', replace: 'if (inFlight.length < 0) pending.push',
        expectedKilledBy: 'resume discovers exact queued consent without requesting a second signature or exposing signatures' }],
  },
  'membership-consent-operation': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/membership-consent-operation.ts',
    testMatchPath: 'src/core/recourse/membership-consent-operation.test.ts',
    mutations: [{ id: 'UNSIGNED-RECOVERY', description: 'obsolete unsigned request permanently holds the shared sponsor nonce',
      find: "['retired', 'finished', 'stale', 'owner']", replace: "['retired', 'finished', 'stale']",
      expectedKilledBy: 'recovery releases an interrupted unsigned gas reservation without erasing signed work' }],
  },
  'sponsored-operation-worker': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/sponsored-operation-worker.ts',
    testMatchPath: 'src/core/recourse/membership-consent-operation.test.ts',
    mutations: [{ id: 'DURABLE-RECEIPT', description: 'finalized gas transaction exits the retry queue before private receipt application',
      find: 'if (terminal.status === 1 && adapter.reconcileConfirmed) await adapter.reconcileConfirmed(request, keccak256(raw));',
      replace: 'void request;',
      expectedKilledBy: 'sponsored receipt failure retains exact bytes and nonce until durable reconciliation succeeds' }],
  },
  'private-membership-succession': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-membership-succession.ts',
    testMatchPath: 'src/core/recourse/private-membership-succession.test.ts',
    mutations: [{ id: 'SUCCESSION-ACTIVATION', description: 'relay catchup time incorrectly delays imported membership protection',
      find: 'const effective = publication;', replace: 'const effective = { block, blockHash, logIndex: Number.MAX_SAFE_INTEGER };',
      expectedKilledBy: 'imported protection starts at the publication position even when private replay arrives later' },
      { id: 'SUCCESSION-SETTLED', description: 'omitted issuance logs erase an actually settled batch during cutoff replay',
        find: "if (batch[0] !== false || cancelled !== false) return fail('pending_reconciliation');", replace: 'void batch; void cancelled;',
        expectedKilledBy: 'missing issuance logs cannot erase a batch that the cutoff kernel records as settled or cancelled' },
      { id: 'SUCCESSION-FIRST-JOIN', description: 'executed first join is silently discarded as never admitted',
        find: "return fail('first_join_reconciliation_pending');", replace: 'void 0;',
        expectedKilledBy: 'fully executed but unrecorded first-join consent must reconcile instead of being erased as unadmitted' }],
  },
  'private-membership-journal': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-membership-journal.ts',
    testMatchPath: 'src/core/recourse/private-membership-journal.test.ts',
    mutations: [{ id: 'JOURNAL-CONTENT', description: 'edited historical episode accepted under its prior immutable hash',
      find: 'id !== membershipJournalHash(body)', replace: 'false',
      expectedKilledBy: 'missing entry, edited episode and swapped owner refuse instead of rewriting history' }],
  },
  'membership-at-loss': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/membership-at-loss.ts',
    testMatchPath: 'src/core/recourse/membership-at-loss.test.ts',
    mutations: [{ id: 'LOSS-CUTOFF', description: 'post-loss payment or rejoin retroactively qualifies historical loss',
      find: 'activeMembershipJournal(journal).filter(entry => beforeMembershipPosition(entry.position, loss))', replace: 'activeMembershipJournal(journal)',
      expectedKilledBy: 'later payment cannot change earlier loss evidence, but a timely prior payment does qualify' }],
  },
  'private-membership-scan': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-membership-scan.ts',
    testMatchPath: 'src/core/recourse/private-membership-scan.test.ts',
    mutations: [{ id: 'SCAN-BINDING-CONFIRMATION', description: 'stale scan clears a later binding confirmation freeze',
      find: '|| hash(bindings(portfolio.docs)) !== proof.bindingHash', replace: '|| false',
      expectedKilledBy: 'a scan captured before atomic binding cannot clear its later confirmation freeze' }],
  },
  'private-membership-reservation': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-membership-reservation.ts',
    testMatchPath: 'src/core/recourse/private-membership-reservation.test.ts src/core/recourse/membership-debit-revocation.test.ts',
    mutations: [
      { id: 'RESERVATION-SNAPSHOT', description: 'caller can change signing bytes while durable reservation awaits reads',
        find: 'JSON.parse(stable(input)) as PrivateMembershipReservation', replace: 'input',
        expectedKilledBy: 'async caller mutation cannot alter the reserved signing bytes' },
      { id: 'RESERVATION-EFFECT', description: 'one physical payment can credit multiple private owner calendars',
        find: "const effectRefs = result.status === 'committed' ?", replace: 'const effectRefs = false ?',
        expectedKilledBy: 'a global effect fence prevents credit duplication even if private ownership metadata is later reassigned' },
    ],
  },
  'settlement-issuance': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/settlement-issuance.ts',
    testMatchPath: 'src/core/recourse/settlement-issuance.test.ts',
    mutations: [{ id: 'ISSUANCE-RATE', description: 'ticket gross ignores the frozen standard mint rate',
      find: 'input * rate / 10n ** 18n', replace: 'input',
      expectedKilledBy: 'standard sums claims before rate rounding, preserves ordinary recipient order and excludes treasury allocations' }],
  },
  'private-issuance-batch': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-issuance-batch.ts',
    testMatchPath: 'src/core/recourse/private-issuance-batch.test.ts',
    mutations: [
      { id: 'ISSUANCE-PARTITION', description: 'an omitted nonmember receives a ticket without its private classification fence',
        find: "if (covered.size !== input.tickets.length) return fail('partition');", replace: 'void covered;',
        expectedKilledBy: 'incomplete or fabricated recipient partitions and changed inner calldata cannot reserve' },
      { id: 'ISSUANCE-CANCEL-REVISION', description: 'same-domain republication permanently strands obsolete tickets',
        find: "if (cancelled.length === 1 && consumed.length === 0) return { status: 'cancelled', logIndexes: [] };",
        replace: "if (cancelled.length === 1 && consumed.length === 0 && cancelled[0].event.revision === batch.context.revision) return { status: 'cancelled', logIndexes: [] };",
        expectedKilledBy: 'same-domain pointer republication can cancel tickets from the previous revision' },
    ],
  },
  'settlement-issuance-runtime': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/settlement-issuance-runtime.ts',
    testMatchPath: 'src/core/recourse/settlement-issuance-runtime.test.ts',
    mutations: [{ id: 'ISSUANCE-POST-SIGN', description: 'retain authorization after the signing domain changes',
      find: 'const after=await assertCurrentPrivateIssuance(db,record,gasPayer);', replace: 'const after=check;',
      expectedKilledBy: 'pointer revision or calendar rollover during signing retains locks and refuses to retain an obsolete signature' }],
  },
  'issuance-parent-retention': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-issuance-batch.ts',
    testMatchPath: 'src/core/recourse/settlement-issuance-runtime.test.ts',
    mutations: [{ id: 'ISSUANCE-PARENT-RETENTION', description: 'retain executable authorization after the parent retires during verification',
      find: "!['reserved','submitted','mined'].includes(String(parent.get('status')))", replace: 'false',
      expectedKilledBy: 'parent retirement during signing, verification or signed retry never retains or returns executable bytes' }],
  },
  'issuance-succession-proof': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/issuance-succession-proof.ts',
    testMatchPath: 'src/core/recourse/issuance-succession-proof.test.ts',
    mutations: [{ id: 'ISSUANCE-RETIREMENT', description: 'release a batch before its source pair is irreversibly retired',
      find: "if ((await call(pointer,abi,'retired',[address]))[0] !== true) return fail('not_retired');",
      replace: 'void address;', expectedKilledBy: 'unretired, unpublished, premature, unfinalized, disagreeing or changed canonical checkpoints grant no release' }],
  },
  'private-issuance-succession': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-issuance-succession.ts',
    testMatchPath: 'src/core/recourse/private-issuance-succession.test.ts',
    mutations: [{ id: 'ISSUANCE-SUCCESSION-FENCE', description: 'release an address already reserved by a different batch',
      find: "if (fences.some(f => f.get('batchId') !== id)) return fail('fence');", replace: 'void fences;',
      expectedKilledBy: 'a replacement fence or concurrent coordinator mutation refuses the whole release' }],
  },
  'membership-coordinated-receipt': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-membership-reconcile.ts',
    testMatchPath: 'src/core/recourse/private-issuance-succession.test.ts',
    mutations: [{ id: 'ISSUANCE-WHOLE-BATCH', description: 'credit one owner and strand other recipients before succession',
      find: 'if (batchId && coordinated) {', replace: 'if (batchId && coordinated && batchId.length === 0) {',
      expectedKilledBy: 'one owner receipt catchup commits both owners and all fences before either can branch' }],
  },
  'membership-debit-revocation': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/membership-debit-revocation.ts',
    testMatchPath: 'src/core/recourse/membership-debit-revocation.test.ts src/core/recourse/private-membership-reservation.test.ts',
    mutations: [
      { id: 'REVOCATION-GAP', description: 'an omitted execution can be mistaken for a permanently cancelled debit',
        find: "if (cursor !== final) return fail('history_gap');", replace: "if (false) return fail('history_gap');",
        expectedKilledBy: 'missing execution, missing final leave, wrong baseline and gapped nonces fail closed' },
    ],
  },
  'ProvianMemberRecoursePool': {
    sourcePath: 'contracts/src/ProvianMemberRecoursePool.sol',
    testMatchPath: 'test/{ProvianMemberRecoursePool,ProvianRecourseHistory,ProvianRecourseKernel,RecoursePoolHistory}.t.sol',
    mutations: [
      { id: 'POOL-ELIGIBILITY', description: 'authority can allocate without independently attested private membership',
        find: '!approvedLossEligibility[sha256(abi.encode(d))] || authorization.reversalOutcome(d.request) != outcome',
        replace: 'authorization.reversalOutcome(d.request) != outcome',
        expectedKilledBy: 'testDeterminationNeedsAuthorityEligibilityAndExactOwnerReversalOutcome' },
    ],
  },
  'RecoursePoolHistory': {
    sourcePath: 'contracts/src/RecoursePoolHistory.sol',
    testMatchPath: 'test/{ProvianMemberRecoursePool,ProvianRecourseHistory,ProvianRecourseKernel,RecoursePoolHistory}.t.sol',
    mutations: [
      { id: 'POOL-PERIODS', description: 'a migration can activate while omitting old consent periods',
        find: '||remainingConsentPeriods!=0', replace: '',
        expectedKilledBy: 'testMissingHistoricalConsentPeriodCannotActivate' },
    ],
  },
  'member-settlement-probe': {
    sourcePath: 'contracts/src/ProvianMemberSettlement.sol',
    testMatchPath: 'test/{ProvianMemberSettlementTickets,ProvianMemberRecoursePool,ProvianRecourseHistory,ProvianRecourseKernel,RecoursePoolHistory}.t.sol',
    mutations: [
      { id: 'PROBE-ROLLBACK', description: 'successful unsigned probe commits kernel and pool effects',
        find: 'revert ProbeResult(success, result);', replace: 'return;',
        expectedKilledBy: 'testProbeSuccessAlwaysRevertsBothLanesAndCannotLeaveReusableTickets' },
      { id: 'PROBE-SELF', description: 'external caller can directly execute unsigned settlement',
        find: 'if (msg.sender != address(this)) revert Unauthorized();', replace: '',
        expectedKilledBy: 'testUnsignedProbeEntrypointsRefuseExternalExecution' },
    ],
  },
  'settlement-observed-evidence': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/settlement-transaction-evidence.ts',
    testMatchPath: 'src/core/recourse/settlement-transaction-evidence.test.ts',
    mutations: [{ id: 'OBSERVED-SENDER', description: 'accept transaction metadata from another gas payer',
      find: 'address(tx.from)!==address(gasPayer)', replace: 'false',
      expectedKilledBy: 'rejects changed transaction from' }],
  },
  'auxiliary-recovery': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/auxiliary-recovery.ts',
    testMatchPath: 'src/core/recourse/auxiliary-recovery.test.ts',
    mutations: [
      { id: 'AUXILIARY-PRIMARY-RACE', description: 'allow a binding promoted to primary during recovery to use the auxiliary transaction',
        find: "|| portfolio.get('primaryBinding') === input.identity", replace: '',
        expectedKilledBy: 'transaction-time owner substitution is refused after a valid chain proof' },
      { id: 'AUXILIARY-SECRET-LIFETIME', description: 'wipe the recovery secret before replay transaction checks it',
        find: 'return await deps.db.runTransaction(async tx => {', replace: 'return deps.db.runTransaction(async tx => {',
        expectedKilledBy: 'auxiliary recovery appends exactly one owner-chain record and fresh binding without changing login, primary wallet or earning proofs' },
    ],
  },
  'restoration-exit-discovery': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/recourse-restoration-exit.ts',
    testMatchPath: 'src/recourse-restoration-exit.test.ts',
    mutations: [{ id: 'EXIT-BINDING-AGREEMENT', description: 'derive an allocation binding despite independent RPC disagreement',
      find: 'results[0].identity !== results[1].identity || ', replace: '',
      expectedKilledBy: 'discovers the exact binding from the allocated request without relay history or a primary binding' }],
  },
  'agent-recovery-backup': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/agent-recovery-backup.ts',
    testMatchPath: 'src/agent-recovery-backup.test.ts',
    mutations: [
      { id: 'AGENT-BACKUP-PATH', description: 'accept authenticated archive paths outside the recovery state directory',
        find: '!allowed(name) || ', replace: '',
        expectedKilledBy: 'authenticated path traversal and forged curve headers are refused before creating a destination' },
      { id: 'AGENT-BACKUP-DIRECTORY-BARRIER', description: 'publish restored state without syncing nested directory entries',
        find: "const fd = fs.openSync(saved, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }", replace: '',
        expectedKilledBy: 'nested directory durability failure leaves the restored directory unpublished' },
      { id: 'AGENT-BACKUP-ACTIVE-EXPORT', description: 'export an active wallet without its matching encrypted key record',
        find: 'validateAgentHashBackup(directory, input.localPassphrase);', replace: '',
        expectedKilledBy: 'an active hash locator needs its decryptable matching key record before export succeeds' },
      { id: 'AGENT-BACKUP-ACTIVE-IMPORT', description: 'install an archive missing the active hash account key',
        find: 'validateAgentHashBackup(staging, payload.localPassphrase);', replace: '',
        expectedKilledBy: 'authenticated path traversal and forged curve headers are refused before creating a destination' },
      { id: 'AGENT-BACKUP-SNAPSHOT', description: 'export inconsistent pending nonce state after a concurrent change',
        find: "if (JSON.stringify(capture(directory)) !== JSON.stringify(files)) throw Error('recovery_backup_state_changed');", replace: '',
        expectedKilledBy: 'a concurrent committed nonce change prevents exporting a mixed snapshot and preserves the preceding backup' },
    ],
  },
  'agent-hash-owner-reservation': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/agent-hash-owner-operation.ts',
    testMatchPath: 'src/agent-hash-owner-operation.test.ts',
    mutations: [{ id: 'AGENT-HASH-RESERVED-LOSS', description: 'persist a different loss after an ordinary owner intent was reserved',
      find: "if (state.ownerIntent) throw Error('hash_replacement_loss_changed');", replace: '',
      expectedKilledBy: 'rejected loss addition cannot poison retained ordinary intent' }],
  },
  'agent-hash-credential-root': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/agent-hash-credentials.ts',
    testMatchPath: 'src/agent-hash-owner-operation.test.ts',
    mutations: [{ id: 'AGENT-HASH-INSTALL-ROOT', description: 'install a destination whose spending root changed during the relay cut',
      find: "if ((await readHashAccountState(plan.account, input.network)).root !== await recoverySigningRoot(seed)) throw Error('hash_replacement_spending_changed');", replace: '',
      expectedKilledBy: 'credential cut refuses stolen replacement roots, bad receipts, mismatched responses and post-response root changes' }],
  },
  'agent-hash-restoration-submission': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/agent-hash-recovery.ts',
    testMatchPath: 'src/agent-hash-recovery.test.ts',
    mutations: [{ id: 'AGENT-HASH-LOSS-REPLY', description: 'accept final submission response for another loss',
      find: 'response.requestId !== loss.scope.request || ', replace: '',
      expectedKilledBy: 'a wrong final restoration response remains pending and retry uses the original request' },
      { id: 'AGENT-HASH-CREDENTIAL-BINDING', description: 'use refreshed credentials bound to another wallet',
        find: ' || currentCredentials.wallet_id !== keystore.wallet_id', replace: '',
        expectedKilledBy: 'a different wallet credential file cannot be used for a retained restoration request' },
      { id: 'AGENT-HASH-TERMINAL-REQUEST', description: 'resubmit an already executed retained restoration',
        find: "if (status === 'executed') continue;", replace: '',
        expectedKilledBy: 'an executed retained ticket remains identified without resubmission or a second bounded authorization' }],
  },
  'agent-restoration-history-owner': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/recourse-restoration-ticket.ts',
    testMatchPath: 'src/recourse-restoration-ticket.test.ts',
    mutations: [{ id: 'RESTORATION-HISTORY-OWNER', description: 'accept another owner completed reversal history after a break',
      find: 'String(evidence.identity) !== identity || ', replace: '',
      expectedKilledBy: 'completed history without an intent is terminal only for its independently verified owner' }],
  },
  'agent-hash-replacement': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/agent-hash-replacement.ts',
    testMatchPath: 'src/agent-hash-replacement.test.ts',
    mutations: [{ id: 'AGENT-REPLACEMENT-RECOVERY-ROOT', description: 'prepare an agent replacement against a different current independent signing root',
      find: 'if (root !== owner.signingRoot || recoveryCommitment(secret, root) !== owner.commitment)', replace: 'if (false)',
      expectedKilledBy: 'changed owner authority, reused destination state and a changed caller plan cannot obtain sponsorship' }],
  },
  'agent-hash-record-lifetime': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/break-recovery-store.ts',
    testMatchPath: 'src/agent-hash-replacement.test.ts',
    mutations: [{ id: 'AGENT-REPLACEMENT-LOCK-LIFETIME', description: 'allow a stale persist callback to write after releasing the transition lock',
      find: "if (!active) throw Error('hash_replacement_record_lock_expired');", replace: '',
      expectedKilledBy: 'record persistence is revoked after the callback and queued inputs retain their original binding' }],
  },
  'agent-restoration-submission': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/recourse-recovery.ts',
    testMatchPath: 'src/recourse-recovery.test.ts',
    mutations: [{ id: 'AGENT-RESTORATION-REPLY-BINDING', description: 'finish a restoration submission after a response for another bounded request',
      find: ' || result.requestId !== journal.restoration.scope.request', replace: '',
      expectedKilledBy: 'prepares and signs one bounded loss scope, then resumes without a second authorization' },
      { id: 'AGENT-RESTORATION-PREARCHIVE', description: 'archive a recovery before its outstanding restoration submission completes',
        find: '      await submitRecoveredRestoration(journal, file, input);\n      saveJournal(path.join(directory,',
        replace: '      saveJournal(path.join(directory,',
        expectedKilledBy: 'prepares and signs one bounded loss scope, then resumes without a second authorization' }],
  },
  'active-hash-delivery': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/active-hash-delivery.ts',
    testMatchPath: 'src/active-hash-delivery.test.ts',
    mutations: [{ id: 'HASH-GAS-RETAINED-CALL', description: 'accept a retained gas transaction with another hash-account call',
      find: ' || tx.to?.toLowerCase() !== operation.account', replace: '',
      expectedKilledBy: 'a retained gas transaction with a changed call cannot be recovered' }],
  },
  'hash-delivery-journal': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/hash-delivery-journal.ts',
    testMatchPath: 'src/active-hash-delivery.test.ts',
    mutations: [{ id: 'HASH-GAS-JOURNAL-BINDING', description: 'allow a completed transport journal to be relocated to another operation or payer',
      find: "return Buffer.from(JSON.stringify(['provian.hash.delivery.v1', id, sender]));", replace: "return Buffer.from(JSON.stringify(['provian.hash.delivery.v1']));",
      expectedKilledBy: 'edited plaintext completion and modified ciphertext cannot invent a completed payment' }],
  },
  'hash-wallet-completed-history': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/break-recovery-store.ts',
    testMatchPath: 'src/break-recovery-store.test.ts',
    mutations: [{ id: 'HASH-COMPLETED-LOCATOR-BINDING', description: 'accept a history locator pointing at another completed operation',
      find: ' || !matches(saved.pendingAccount)', replace: '',
      expectedKilledBy: 'reserves one exact hash-wallet spend, keeps the next seed on retry and advances it even when the target fails' }],
  },
  'bound-spending-authority': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/human-bound-spending.ts',
    testMatchPath: 'src/core/recourse/human-bound-spending.test.ts',
    mutations: [{ id: 'BOUND-SPENDING-RECOVERY-ROOT', description: 'accept an auxiliary spending key without its independent recovery authority',
      find: 'if (root !== owner.signingRoot || recoveryCommitment(secret, root) !== owner.commitment)', replace: 'if (false)',
      expectedKilledBy: 'requires exact independent recovery authority and refuses wrong bindings, destination and racing state' }],
  },
  'curve-transfer-receipt': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/human-curve-transfer.ts',
    testMatchPath: 'src/core/recourse/human-curve-transfer.test.ts',
    mutations: [{ id: 'CURVE-TRANSFER-RECEIPT-TARGET', description: 'accept a finalized transaction to a different destination',
      find: ' || tx.to !== intent.target', replace: '',
      expectedKilledBy: 'two finalized canonical receipts and the exact call are required; a revert completes only as failed' },
      { id: 'CURVE-TRANSFER-REVIEW-COPY', description: 'let later caller edits change an already reviewed transfer',
        find: 'const intent = { ...reviewed };', replace: 'const intent = reviewed;',
        expectedKilledBy: 'caller mutation cannot change a queued review and a new explicit id archives a completed payment' },
      { id: 'CURVE-TRANSFER-FINAL-CANONICAL', description: 'finish an orphan receipt after a reorg during finality observation',
        find: "if (blocks.some(block => object(block).hash !== receipt.blockHash || quantity(object(block).number) !== BigInt(receipt.block)))", replace: 'if (false)',
        expectedKilledBy: 'a reorg during the second finality read cannot complete either success or failure or unlock a new payment' }],
  },
  'human-recovery-discovery': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/human-recovery-discovery.ts',
    testMatchPath: 'src/core/recourse/human-recovery-discovery.test.ts',
    mutations: [{ id: 'DISCOVERY-LOSS-EVIDENCE', description: 'accept changed original loss bytes on backup recovery',
      find: ' || sha256(toUtf8Bytes(raw)) !== scope.lossHash', replace: '',
      expectedKilledBy: 'a recovered bounded restoration retains the original loss occurrence authenticated by its on-chain intent' },
    { id: 'HISTORY-ABSENT-TICKET', description: 'retain prepared history absent from authenticated current state',
      find: "await readContinuedRestorationStatus(identity, owner.destination, restoration, network) !== 'absent'", replace: 'true',
      expectedKilledBy: 'private all-generation history works at the initial break nonce and independently filters absent candidates' }],
  },
  'continued-restoration-ticket': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/restoration-ticket.ts',
    testMatchPath: 'src/core/recourse/restoration-ticket.test.ts',
    mutations: [{ id: 'CONTINUED-TICKET-CEILING', description: 'carry a restoration whose actual authorized amount changed',
      find: ' || String(row.maximumLoss) !== scope.maximumLoss', replace: '',
      expectedKilledBy: 'foreign identity, changed amount, stale destination, manifest drift and RPC disagreement cannot create a continuation' }],
  },
  'restoration-evidence-order': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/determination.ts',
    testMatchPath: 'src/core/recourse/determination.test.ts',
    mutations: [{ id: 'EVIDENCE-ENCRYPTED-MAP-ORDER', description: 'rebuild packet evidence from storage-reordered maps',
      find: 'const snapshot = original.snapshot as LossSnapshot;', replace: "const snapshot = record.get('snapshot') as LossSnapshot;",
      expectedKilledBy: 'encrypted map ordering preserves the exact loss evidence and determination packet' }],
  },
  'human-replacement-authority': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/human-replacement-account.ts',
    testMatchPath: 'src/core/recourse/human-replacement-account.test.ts',
    mutations: [{ id: 'REPLACEMENT-RECOVERY-AUTHORITY', description: 'prepare a replacement without matching independent owner authority',
      find: "if (root !== owner.signingRoot || recoveryCommitment(secret, root) !== owner.commitment)", replace: 'if (false)',
      expectedKilledBy: 'replacement preparation needs independent recovery material and never the stolen account spending root' }],
  },
  'human-replacement-coordinator': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/human-recovery.ts',
    testMatchPath: 'src/core/recourse/human-recovery.test.ts',
    mutations: [{ id: 'REPLACEMENT-SUPERSEDED-AUTHORITY', description: 'publish an operation from a superseded replacement journal',
      find: "throw Error('recourse_replacement_state_changed');\n        }\n      }", replace: '/* negative control: superseded authority */\n        }\n      }',
      expectedKilledBy: 'refuses a superseded replacement journal before publishing another owner operation' },
      { id: 'RECOVERY-QUEUED-OPTIONS', description: 'let caller edits change a queued binding or loss',
        find: 'const retainedOptions = { ...options };', replace: 'const retainedOptions = options;',
        expectedKilledBy: 'copies queued recovery options before the caller can select a different binding or loss' },
      { id: 'RECOVERY-HISTORICAL-SCOPE', description: 'authorize an imported bounded loss a second time',
        find: "if (retainedLoss && await readContinuedRestorationStatus(identity, state.destination, retainedLoss.restoration, network) !== 'absent')", replace: 'if (false)',
        expectedKilledBy: 'an older-origin bounded loss survives into a fresh break journal' },
      { id: 'RECOVERY-ABSENT-SCOPE', description: 'return a discarded scope instead of the newly authorized occurrence',
        find: 'if (retainedLoss) inheritedLosses.splice(inheritedLosses.indexOf(retainedLoss), 1);', replace: '',
        expectedKilledBy: 'an absent pre-break scope cannot shadow the fresh surviving authorization for the same transaction' }],
  },
  'human-restoration-submission': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/service.ts', testMatchPath: 'src/core/recourse/service.test.ts',
    mutations: [{ id: 'HUMAN-RESTORATION-TERMINAL', description: 'resubmit an already executed restoration',
      find: "if (status === 'executed') return;", replace: '',
      expectedKilledBy: 'terminal observations suppress only the current submission and are rechecked after a reorg' },
    { id: 'HUMAN-RESTORATION-REPLY', description: 'accept a reply for another loss occurrence',
      find: 'response.requestId !== recovered.restoration.request || ', replace: '',
      expectedKilledBy: 'missing or changed tickets and wrong returned occurrence cannot complete a restoration request' }],
  },
  'private-restoration-history': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-history.ts', testMatchPath: 'src/core/recourse/restoration-history.test.ts',
    mutations: [{ id: 'HISTORY-SNAPSHOT-OWNER', description: 'accept evidence belonging to another binding',
      find: ' || snapshot.identity !== identity', replace: '',
      expectedKilledBy: 'changed evidence, scope, identity and transaction metadata are refused' }],
  },
  'retained-restoration-submission': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/restoration-request.ts', testMatchPath: 'src/core/recourse/restoration-request.test.ts',
    mutations: [{ id: 'RETAINED-LOSS-SNAPSHOT', description: 'rebuild a historical loss from current wallet bindings',
      find: 'const snapshot = original.snapshot as LossSnapshot, retainedMembership = original.membership as LossMembershipEvidence;',
      replace: 'const snapshot = await ports.snapshot(authenticatedIdentity, input.transactionHash, input.block, bindings), retainedMembership = original.membership as LossMembershipEvidence;',
      expectedKilledBy: 'submission preserves exact prior-kernel evidence across a break and checks the current imported ticket' },
    { id: 'RETAINED-LOSS-TRANSACTION', description: 'persist submission after its exact retained evidence changes',
      find: "existing.get('evidence') !== exact || ", replace: '',
      expectedKilledBy: 'retained evidence tampering and a concurrent scope rewrite cannot complete submission' }],
  },
  'current-restoration-ticket': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/current-restoration-ticket.ts', testMatchPath: 'src/core/recourse/current-restoration-ticket.test.ts',
    mutations: [{ id: 'CURRENT-TICKET-CANONICAL', description: 'accept an orphan current ticket when the deployment manifest stays unchanged',
      find: "if (canonical.some(header => headerNumber(header) !== height)) throw Error('recourse_determination_checkpoint_changed');", replace: '',
      expectedKilledBy: 'refuses changed or completed current ticket: reorg' },
    { id: 'CURRENT-TICKET-DETERMINED', description: 'admit a ticket already determined by the current pool',
      find: "|| await call(deployment.addresses.recoursePool.toLowerCase(), 'determined', [request])", replace: '',
      expectedKilledBy: 'refuses changed or completed current ticket: determined' }],
  },
  'replacement-deployment-owner': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/break-deployment-queue.ts',
    testMatchPath: 'src/core/recourse/break-deployment-queue.test.ts',
    mutations: [{ id: 'REPLACEMENT-CURRENT-NONCE', description: 'sponsor a replacement using an obsolete owner authorization nonce',
      find: "String(await call(authorization, 'ownerAuthorizationNonce', [request.identity])) !== String(request.nonce)", replace: 'false',
      expectedKilledBy: 'replacement deployment requires current independent owner authority and refuses retired, replayed or same-account requests' }],
  },
  'confirmed-transfer-occurrence': {
    runner: 'native-vitest', sourcePath: 'src/core/provenance/ProvenanceEnvelopeManager.ts',
    testMatchPath: 'src/core/provenance/__tests__/confirmedTransfer.test.ts',
    mutations: [{ id: 'OCCURRENCE-CORRUPT-RETRY', description: 'erase a corrupt occurrence index and mistake the next retry for a new act',
      find: 'getItemHmac<T>(key, { preserveInvalid: true })', replace: 'getItemHmac<T>(key)',
      expectedKilledBy: 'new occurrence keys never import plaintext or treat a damaged index as a new act' },
    { id: 'OCCURRENCE-FLUSH-INDEX', description: 'flush the only signed WAL record before repairing its occurrence index',
      find: 'for (const pe of batch) await this.indexConfirmedTransferOccurrence(pe);', replace: '',
      expectedKilledBy: 'flushing a recovered WAL rebuilds the occurrence index before clearing its only retry evidence' }],
  },
  'hash-transfer-review': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/human-hash-transfer.ts',
    testMatchPath: 'src/core/recourse/human-hash-transfer.test.ts',
    mutations: [{ id: 'TRANSFER-REVIEW-SNAPSHOT', description: 'let a caller mutate the reviewed transfer while queued',
      find: 'const intent = { ...reviewed };', replace: 'const intent = reviewed;',
      expectedKilledBy: 'caller edits after enqueue cannot change the transfer that was reviewed' }],
  },
  'hash-delivery-reconcile': {
    runner: 'sdk-vitest', sourcePath: 'provian-agent-sdk/src/hash-account-delivery.ts',
    testMatchPath: 'src/hash-account-delivery.test.ts',
    mutations: [{ id: 'RECONCILE-UNMINED-NO-SEND', description: 'attempt a broadcast while inspecting an unmined transaction',
      find: "if (!broadcast) return { status: 'pending', transactionHash: last.hash };", replace: '',
      expectedKilledBy: 'receipt-only reconciliation never broadcasts an absent, unmined or reverted attempt and still finalizes a real winner' }],
  },
  'bound-hash-account': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/human-bound-hash-account.ts',
    testMatchPath: 'src/core/recourse/human-bound-hash-account.test.ts',
    mutations: [{ id: 'BOUND-HASH-SPENDING-ROOT', description: 'accept a recovered account whose spending root does not match the backup',
      find: 'if (await recoverySigningRoot(spendingSeed) !== account.currentRoot)', replace: 'if (false)',
      expectedKilledBy: 'refuses wrong backups, missing spending or recovery authority, and a changed finalized observation' }],
  },
  'auxiliary-break-retry': {
    runner: 'native-vitest', sourcePath: 'src/core/recourse/human-break-recovery.ts',
    testMatchPath: 'src/core/recourse/human-break-recovery.test.ts',
    mutations: [{ id: 'AUXILIARY-REINSTALL-REQUEST', description: 'retry consumed break authority with a fresh device request ID',
      find: 'state.requestId = requestId; await save(key, state);', replace: 'await save(key, state);',
      expectedKilledBy: 'a completed auxiliary relay cut survives loss of the local journal without replaying consumed authority under a new request' },
    { id: 'INITIAL-THEFT-TYPED', description: 'ordinary receipt errors enter independent initial recovery',
      find: 'if (!(error instanceof BreakRecoverySpendingKeyChanged)) throw error;', replace: '',
      expectedKilledBy: 'ordinary receipt failures and changed owner nonces never enter the initial-theft recovery branch' },
    { id: 'INITIAL-THEFT-NONCE', description: 'a stale initial receipt replaces a later owner operation',
      find: 'if ((await readOwnerChainState(identity, network)).nonce !== 1) throw error;', replace: '',
      expectedKilledBy: 'ordinary receipt failures and changed owner nonces never enter the initial-theft recovery branch' },
    { id: 'INITIAL-THEFT-RESUME', description: 'interrupted replacement retries the consumed initial restoration',
      find: 'if (state.replacementStarted) return replaceInitialAccount();', replace: '',
      expectedKilledBy: 'interrupted independent recovery keeps a resume marker without falsely installing initial credentials' }],
  },
  'settlement-terminal-winner': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/pvt/wp4/settlement-cycle-runner.ts',
    testMatchPath: 'src/core/pvt/wp4/settlement-cycle-runner.test.ts',
    mutations: [{ id: 'TERMINAL-EXACT-WINNER', description: 'an orphan success hides the authenticated terminal winner',
      find: 'a.tx_hash===batch.terminal_transaction_hash&&', replace: '',
      expectedKilledBy: 'a discovered finalized winner applies once despite an earlier orphan=true' }],
  },
  'settlement-observed-fee': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/pvt/wp4/durable-settlement-store.ts',
    testMatchPath: 'src/core/recourse/settlement-transaction-evidence.test.ts',
    mutations: [{ id: 'OBSERVED-FEE-RESERVATION', description: 'an observed transaction consumes another local fee reservation',
      find: 'attempt.observed ? 0n : BigInt(attempt.max_fee_per_gas_wei)', replace: 'BigInt(attempt.max_fee_per_gas_wei)',
      expectedKilledBy: 'an observed settlement applies actual fees and counters without consuming an unrelated local fee reservation' }],
  },
  'issuance-terminal-position': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-issuance-batch.ts',
    testMatchPath: 'src/core/recourse/private-issuance-batch.test.ts',
    mutations: [{ id: 'ISSUANCE-TERMINAL-POSITION', description: 'accept changed receipt positions while retaining prior effect fences',
      find: 'return retained !== undefined && digest(retained) === digest(actual);', replace: 'return true;',
      expectedKilledBy: 'an all-unadmitted terminal batch rejects changed finalized event positions without rewriting effect fences' }],
  },
  'issuance-terminal-evidence': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/settlement-issuance-lifecycle.ts',
    testMatchPath: 'src/core/recourse/settlement-issuance-lifecycle.test.ts',
    mutations: [{ id: 'ISSUANCE-TERMINAL-RECEIPT', description: 'cached terminal status bypasses canonical receipt verification',
      find: "if(await finalizeSettlementIssuance(db,parent,record.transactionHash)!==status)return fail('receipt_state');",
      replace: 'void record.transactionHash;',
      expectedKilledBy: 'cached terminal status is revalidated against the actual finalized receipt on every reconciliation' }],
  },
  'issuance-cancellation-nonce': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/pvt/wp4/durable-settlement-store.ts',
    testMatchPath: 'src/core/pvt/wp4/durable-settlement-store.test.ts',
    mutations: [
      { id: 'CANCEL-NONCE-FINALITY', description: 'allocate cancellation before the previous gas nonce is consumed',
        find: 'params.consumedThrough <= priorNonce', replace: 'false',
        expectedKilledBy: 'a consumed member nonce reserves its successor once before signing and refuses premature allocation' },
      { id: 'CANCEL-NONCE-CONSUMED', description: 'reuse a reserved cancellation nonce already consumed while the signer was interrupted',
        find: ' && batch.cancellation_nonce.nonce >= params.consumedThrough', replace: '',
        expectedKilledBy: 'a consumed member nonce reserves its successor once before signing and refuses premature allocation' },
    ],
  },
  'issuance-retirement-intent': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-issuance-batch.ts',
    testMatchPath: 'src/core/recourse/private-issuance-batch.test.ts',
    mutations: [{ id: 'ISSUANCE-RETIREMENT-INTENT', description: 'retain executable authorization after cancellation starts',
      find: " || parent.get('retirement_reason') !== undefined", replace: '',
      expectedKilledBy: 'retiring parent cannot acquire or retain an issuance signature even while its status remains reserved' }],
  },
  'issuance-attempt-envelope': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/pvt/wp4/durable-settlement-store.ts',
    testMatchPath: 'src/core/pvt/wp4/durable-settlement-store.test.ts',
    mutations: [{ id: 'ISSUANCE-ATTEMPT-ENVELOPE', description: 'record inner kernel bytes instead of retained member authorization',
      find: 'params.attempt.calldata !== record.calldata', replace: 'false',
      expectedKilledBy: 'refuses a member attempt with inner_call before durable writes' }],
  },
  'issuance-runner-finalization': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/pvt/wp4/settlement-cycle-runner.ts',
    testMatchPath: 'src/core/pvt/wp4/settlement-cycle-runner.test.ts',
    mutations: [{ id: 'ISSUANCE-RUNNER-FINALIZATION', description: 'skip private receipt application before parent bookkeeping',
      find: 'const status = await deps.memberExecution.finalize(batch, winner.tx_hash);',
      replace: "const status = winner.kind === 'cancel' ? 'cancelled' : 'committed';",
      expectedKilledBy: 'a failed private receipt application retries without rebroadcast or premature parent application' }],
  },
  'issuance-parent-terminal': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/pvt/wp4/durable-settlement-store.ts',
    testMatchPath: 'src/core/pvt/wp4/durable-settlement-store.test.ts',
    mutations: [{ id: 'ISSUANCE-PARENT-TERMINAL', description: 'parent repair releases unresolved private issuance locks',
      find: 'if (id === undefined) return true;', replace: 'if (id === undefined || id.length === 66) return true;',
      expectedKilledBy: 'chain-evidence and stale repair cannot bypass pending private coordination or a missing parent' }],
  },
  'issuance-lifecycle': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/settlement-issuance-lifecycle.ts',
    testMatchPath: 'src/core/recourse/settlement-issuance-lifecycle.test.ts',
    mutations: [{ id: 'ISSUANCE-LIFECYCLE-REORG', description: 'private receipt commits after its endpoint checkpoint changes',
      find: "if(await createRecourseChainPort().blockHash(block)!==deployment.blockHash)return fail('reorg');",
      replace: 'void block;', expectedKilledBy: 'wrong signer, changed domain or reorg prevents a new cancellation or private release' }],
  },
  'issuance-probe-rpc': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/settlement-issuance-probe.ts',
    testMatchPath: 'src/core/recourse/settlement-issuance-probe.test.ts',
    mutations: [{ id: 'PROBE-REORG', description: 'an orphaned simulation block is accepted with an unchanged manifest',
      find: "if (canonical.some(header => object(header)?.hash !== input.blockHash || object(header)?.number !== height)) return fail('reorg');",
      replace: 'void canonical;', expectedKilledBy: 'same-manifest reorg after both calls refuses the old block result' }],
  },
  'ProvianMemberSettlement': {
    sourcePath: 'contracts/src/ProvianMemberSettlement.sol',
    testMatchPath: 'test/{ProvianMemberSettlementTickets,ProvianMemberRecoursePool,ProvianRecourseHistory,ProvianRecourseKernel,RecoursePoolHistory}.t.sol',
    mutations: [
      { id: 'ADAPTER-SELECTOR', description: 'an otherwise valid unknown kernel entry point can execute',
        find: 'if ((context.lane == 0 && selector != ProvianPVT9.settleStandardPEBatch.selector)\n'
          + '            || (context.lane == 1 && selector != ProvianPVT9.settleGenesisPEBatch.selector)\n'
          + '            || context.lane > 1) revert InvalidConfiguration();',
        replace: 'if (false) revert InvalidConfiguration();',
        expectedKilledBy: 'testUnknownSelectorRefusesEvenWhenItsHeaderTicketsAndResultWouldMatch' },
    ],
  },
  'RecourseIssuanceTickets': {
    sourcePath: 'contracts/src/RecourseIssuanceTickets.sol',
    testMatchPath: 'test/{RecourseIssuanceTickets,ProvianMemberSettlementTickets,ProvianMemberRecoursePool,ProvianRecourseHistory,ProvianRecourseKernel,RecoursePoolHistory}.t.sol',
    mutations: [
      { id: 'TICKET-REPLAY', description: 'already settled ticket context can be reinstalled',
        find: '|| cancelledIssuanceBatch[context.batchId] || alreadySettled',
        replace: '|| cancelledIssuanceBatch[context.batchId]',
        expectedKilledBy: 'testCompletedContextCannotBeReinstalledForAnotherSameShapedBatch' },
      { id: 'TICKET-AMOUNT', description: 'attestor can divert beyond the exact gross percentage bound',
        find: 'if (ticket.contribution < floor || ticket.contribution > ceil) revert InvalidIssuanceTicket();',
        replace: 'if (false) revert InvalidIssuanceTicket();',
        expectedKilledBy: 'testAttestorCannotChooseMoreThanExactFloorOrCeilOrTakeProtocolAllocations' },
      { id: 'TICKET-UNUSED', description: 'a settlement can finish with unconsumed tickets',
        find: '|| _get(2, 0) != _get(1, 0)', replace: '|| false',
        expectedKilledBy: 'testMissingExtraOrWrongActualMintRevertsWholeBatch' },
    ],
  },
  'RecourseAddressConsent': {
    sourcePath: 'contracts/src/RecourseAddressConsent.sol',
    testMatchPath: 'test/{RecourseAddressConsent,ProvianOwnershipRegistry*,ProvianMemberRecoursePool,ProvianRecourseHistory,ProvianRecourseKernel,RecoursePoolHistory}.t.sol',
    mutations: [
      { id: 'DEBIT-OWNER', description: 'attestor can debit without the owner exact-amount mandate',
        find: '|| (debit.burn == 0 && debit.reserve == 0) || !_signature(owner, digest, ownerSignature)',
        replace: '|| (debit.burn == 0 && debit.reserve == 0)',
        expectedKilledBy: 'testAllowanceOrAttestorAloneCannotDebitAndExactOwnerMandateExecutesOnce' },
      { id: 'DEBIT-NONCE', description: 'a consumed or cancelled debit nonce can execute again',
        find: '|| !current.joined || debit.generation != current.generation || debit.nonce != debitNonce[debit.binding]',
        replace: '|| !current.joined || debit.generation != current.generation',
        expectedKilledBy: 'testCancellationInvalidatesRetainedSignedBytesBeforePayerSwitch' },
    ],
  },
  'private-membership-calendar': {
    runner: 'jest', sourcePath: 'provian-backend/src/core/recourse/private-membership-calendar.ts',
    testMatchPath: 'src/core/recourse/private-membership-calendar.test.ts',
    mutations: [
      { id: 'CALENDAR-GRACE', description: 'a late keeper fails to close the expired membership episode',
        find: 'if (state.firstUnpaidMonth + 1 < cursor) return',
        replace: 'if (false) return',
        expectedKilledBy: 'late keeper preserves the original deadline and neither late payment nor issuance can revive it' },
    ],
  },
  // -------------------------------------------------------------------------
  // the first TypeScript surface in this harness. Same contract as the
  // Solidity targets: mutate ONE conjunct, run the SCOPED suite, decide from
  // structured runner output, restore byte-identical. `runner: 'jest'` selects
  // the backend runner; everything else is identical.
  //
  // M6 SURVIVED on its first run and is recorded rather than re-baselined: every
  // case then in the suite was caught EARLIER (by the key-hash equality or the
  // frozen-digest check), so nothing exercised the cryptographic verification
  // itself. The forgery control — the configured key's hash claimed over another
  // key's armored body — was added to close it, and M6 now dies.
  // -------------------------------------------------------------------------
  'approved-genesis-activation-approval': {
    runner: 'jest',
    sourcePath: 'provian-backend/src/core/pvt/policy/approved-genesis-activation-approval.ts',
    testMatchPath: 'src/core/pvt/policy/approved-genesis-activation-approval.test.ts '
      + 'src/core/pvt/genesis-activation-rail-open.test.ts',
    mutations: [
      {
        id: 'M1',
        description: 'the frozen Gate 1 manifest binding is dropped (a moved manifest would admit)',
        find: '    if (liveDigest !== scope.bound_gate1_manifest_sha256',
        replace: '    if (false && liveDigest !== scope.bound_gate1_manifest_sha256',
        expectedKilledBy: 'a MOVED frozen manifest refuses, however correct the document',
      },
      {
        id: 'M2',
        description: 'the campaign (ledger namespace) scope check is dropped',
        find: '    if (candidate.ledger_namespace !== scope.campaign_ledger_namespace) {',
        replace: '    if (false) {',
        expectedKilledBy: 'a DIFFERENT campaign is named, not merely refused',
      },
      {
        id: 'M3',
        description: 'the canonical PVT manifest id scope check is dropped',
        find: '    if (candidate.canonical_pvt_manifest_id !== scope.canonical_pvt_manifest_id) {',
        replace: '    if (false) {',
        expectedKilledBy: 'a DIFFERENT canonical manifest id is named',
      },
      {
        id: 'M4',
        description: 'the approved window is widened by 10 ms on each edge',
        find: '      || candidate.effective_at_ms < scope.window_start_ms\n'
          + '      || candidate.effective_at_ms > scope.window_end_ms) {',
        replace: '      || candidate.effective_at_ms < scope.window_start_ms - 10\n'
          + '      || candidate.effective_at_ms > scope.window_end_ms + 10) {',
        expectedKilledBy: 'an effective instant one ms BEFORE/AFTER the window',
      },
      {
        id: 'M5',
        description: 'the signature key-hash equality is dropped',
        find: '    if (signature.public_key_sha256 !== config.publicKeySha256) {',
        replace: '    if (false) {',
        expectedKilledBy: 'a signature by a DIFFERENT key than the configured one',
      },
      {
        id: 'M6',
        description: 'the REAL cryptographic verification is skipped (forgery would admit)',
        find: "    if (!verify(genesisApprovalSigningBytes(scope), signature, config)) return 'signature_not_verified';",
        replace: '    verify(genesisApprovalSigningBytes(scope), signature, config);',
        expectedKilledBy: 'a FORGERY: the configured key hash claimed over another key\'s signature',
      },
      {
        id: 'M7',
        description: 'the null-record fail-open is restored (an absent record would admit; '
          + 'also drops the own-property check the reviewer flagged)',
        find: "    const record = Object.prototype.hasOwnProperty.call(deps, 'record')\n"
          + '      ? deps.record\n'
          + '      : APPROVED_GENESIS_ACTIVATION;',
        replace: '    const record = deps.record ?? APPROVED_GENESIS_ACTIVATION;',
        expectedKilledBy: 'a malformed record (null) refuses',
      },
      {
        id: 'M8',
        description: 'the nothing-approved status self-gate is dropped',
        find: "    if (statusGatesEverything(record.status)) return 'status_gates_everything';",
        replace: '    /* mutated */',
        expectedKilledBy: 'the nothing-approved sentinel gates everything',
      },
    ],
  },
  ProvianPromiseV3: {
    // institution deployment addendum-3 GLOB AUDIT. The narrow-glob defect was found twice, one
    // contract apart, each time only because a new pin happened to expose it. All five
    // institution globs were therefore audited against the actual set of suites that
    // CONSTRUCT each contract, not against a naming convention. A suite that exercises
    // the contract but sits outside the glob means its pins are mutated with no test in
    // scope: the mutant either survives (loud) or is killed by an unrelated in-scope
    // test (silent, and reported as if the pin were proven). Deliberately EXCLUDED, with
    // EVERY GLOB IS VERIFIED BY EXPANSION, not by reading. The first attempt at this fix
    // was inert: a brace alternative inherits only the PATTERN'S OWN SUFFIX, so
    // `ProvianPVT9AgentBankSinks` under a `.sol` pattern expands to
    // `ProvianPVT9AgentBankSinks.sol` — a file that does not exist — and three of the five
    // "fixes" silently matched nothing while the registry claimed otherwise. (Under a
    // `.t.sol` pattern the same alternative WOULD have matched; the suffix is what decides,
    // not the wildcard. Every alternative here now carries a trailing `*` anyway, so the
    // rule holds uniformly rather than by accident of which suffix a given set uses.)
    //
    // `--list` IS NOT THE CHECK — it never touches the filesystem; it prints
    // `testMatchPath` verbatim and exits 0 even for a glob matching nothing. That mistake
    // was in this comment for one commit. The real detectors are `--verify-registry`
    // (which expands every glob below and fails on a zero match) and, at run time,
    // `FATAL: scoped suite matched 0 tests`.
    // reasons: the chainId-8453 fork suites (BondCourtRedeployFork, WS5ForkRedeploy,
    // Pass3CascadeFork, ProvianCommonsFork, ProvianPVTv7Cascade, ProvianPVTv8Cascade)
    // fail without a Base fork and would trip the harness's own non-green-baseline
    // FATAL; EchidnaAgentBank.sol and ProvianAgentBankHalmos.t.sol declare ZERO `function
    // test` and so contribute no assertions to a forge run.
    sourcePath: 'contracts/src/ProvianPromiseV3.sol',
    // audit: ProvianPVT9AgentBankSinks.t.sol constructs a real ProvianPromiseV3
    // and was out of scope.
    testMatchPath: 'test/{ProvianPromiseV3*,ProvianPVT9AgentBankSinks*}.t.sol',
    // activation clock: the activation clock is now the kernel epoch (openNextEpoch/lastOpenedEpoch
    // deleted). These mutations target the kernel-bound machinery: prospectivity vs
    // currentEpoch, the lazy forward-fill resolver, the fail-closed try/catch, and the
    // baseline literal + immutable bound.
    mutations: [
      {
        id: 'M1',
        description: 'prospectivity guard weakened (the current kernel epoch becomes schedulable)',
        find: 'if (effectiveEpoch <= _currentEpoch()) revert PolicyNotProspective();',
        replace: 'if (effectiveEpoch < _currentEpoch()) revert PolicyNotProspective();',
        expectedKilledBy: 'test_promise_scheduleSettlementFeeBps_rejectsCurrentEpoch',
      },
      {
        id: 'M2',
        description: 'settlement-fee upper bound accepts one bp above the immutable max',
        find: 'if (bps > SETTLEMENT_FEE_BPS_MAX) revert CostOutOfDomain();',
        replace: 'if (bps > SETTLEMENT_FEE_BPS_MAX + 1) revert CostOutOfDomain();',
        expectedKilledBy: 'test_promise_scheduleSettlementFeeBps_rejectsAboveMax',
      },
      {
        id: 'M3',
        description: 're-schedule guard disabled (an already-scheduled epoch may be overwritten)',
        find: 'if (scheduledSettlementFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();',
        replace: 'if (false) revert PolicyAlreadyScheduled();',
        expectedKilledBy: 'test_promise_scheduleSettlementFeeBps_rejectsReschedulingTakenEpoch',
      },
      {
        id: 'M4',
        description: 'unset-fee baseline literal changed from 25 bps',
        find: '(repayAmount * 25) / 10000;',
        replace: '(repayAmount * 30) / 10000;',
        expectedKilledBy: 'test_promise_fee_unset_chargesTheBaseline25bpsLiteral',
      },
      {
        id: 'M5',
        description: 'resolver activation boundary off-by-one (a value never activates at its own epoch)',
        find: 'if (e <= nowEpoch && (!found || e > best)) {',
        replace: 'if (e < nowEpoch && (!found || e > best)) {',
        expectedKilledBy: 'test_promise_feeBps_activatesExactlyWhenItsEpochOpens',
      },
      {
        id: 'M6',
        description: 'fail-closed clock catch returns max epoch (unarmed kernel silently activates every schedule)',
        find: '        } catch {\n            return 0;\n        }',
        replace: '        } catch {\n            return type(uint64).max;\n        }',
        expectedKilledBy: 'test_promise_unarmedKernel_failsClosedToBaseline',
      },
      {
        // institution deployment — the item-4 retirement. Deleting the loud refusal restores the exact
        // silent-fallback bug the change removed: payFeeInPVT=true would fall through
        // to the USDC branch with no revert. Killed by the retirement test.
        id: 'M7',
        description: 'PVT-fee-discount retirement guard removed (silent USDC fallback returns)',
        find: 'if (payFeeInPVT) revert PVTFeeDiscountRetired();',
        replace: 'if (false) revert PVTFeeDiscountRetired();',
        expectedKilledBy: 'test_USDC_pvtFeeDiscount_isRetired_andRevertsLoudly',
      },
    ],
  },

  // institution parameters-rem — ProvianPoolV3 cost machinery (4 params) on the merged Escrow/Promise shape.
  ProvianPoolV3: {
    sourcePath: 'contracts/src/ProvianPoolV3.sol',
    // audit: ProvianPVT9AgentBankSinks.t.sol constructs a real ProvianPoolV3 and
    // was out of scope.
    // Security pass 2026-10-02 (S1-A): SecurityPass20261002Pool.t.sol constructs a real
    // ProvianPoolV3 (the phantom-contribution exploit + its control).
    // Shutdown coverage 2026-10-20: ShutdownCoveragePool.t.sol pins the permissionless
    // refund of a Funded pool past its deadline (no Provian key needed to recover funds).
    testMatchPath: 'test/{ProvianPoolV3*,ProvianPVT9AgentBankSinks*,SecurityPass20261002Pool*,ShutdownCoveragePool*}.t.sol',
    mutations: [
      // Shutdown coverage 2026-10-20: a Funded pool past its deadline is refundable by anyone.
      {
        id: 'SC-1',
        description: 'shutdown exit removed: a non-admin may refund only an Open pool again',
        find: '} else {\n            if (p.status != Status.Open && p.status != Status.Funded) {',
        replace: '} else {\n            if (p.status != Status.Open) {',
        expectedKilledBy: 'test_fundedPool_pastDeadline_anyoneRefunds_USDC',
      },
      {
        id: 'SC-2',
        description: 'shutdown exit deadline off-by-one (refund refused at the deadline instant itself)',
        find: 'if (block.timestamp < p.deadline) revert DeadlineNotReached();',
        replace: 'if (block.timestamp <= p.deadline) revert DeadlineNotReached();',
        expectedKilledBy: 'test_fundedPool_pastDeadline_anyoneRefunds_USDC',
      },
      // Security pass 2026-10-02 (S1-A): the existence guard on contribute() removed — a
      // contribution to a never-created pool is accepted again and survives createPool.
      {
        id: 'SP-1',
        description: 'S1-A guard removed: contribute() accepts a pool nobody created',
        find: 'if (p.creator == address(0)) revert PoolNotFound();\n        if (p.status != Status.Open) {',
        replace: 'if (p.status != Status.Open) {',
        expectedKilledBy: 'test_contributeToNeverCreatedPool_reverts',
      },
      {
        id: 'M1',
        description: 'prospectivity guard weakened (the current kernel epoch becomes schedulable)',
        find: 'if (effectiveEpoch <= _currentEpoch()) revert PolicyNotProspective();',
        replace: 'if (effectiveEpoch < _currentEpoch()) revert PolicyNotProspective();',
        expectedKilledBy: 'test_pool_scheduleFeeBps_rejectsCurrentEpoch',
      },
      {
        id: 'M2',
        description: 'execution-fee upper bound accepts one bp above the immutable max',
        find: 'if (bps > FEE_BPS_MAX) revert CostOutOfDomain(); // lower band is 0',
        replace: 'if (bps > FEE_BPS_MAX + 1) revert CostOutOfDomain(); // lower band is 0',
        expectedKilledBy: 'test_pool_scheduleFeeBps_rejectsAboveMax',
      },
      {
        id: 'M3',
        description: 're-schedule guard disabled (an already-scheduled epoch may be overwritten)',
        find: 'if (scheduledFeeBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();',
        replace: 'if (false) revert PolicyAlreadyScheduled();',
        expectedKilledBy: 'test_pool_scheduleFeeBps_rejectsReschedulingTakenEpoch',
      },
      {
        id: 'M4',
        description: 'unset-fee baseline literal changed from 50 bps',
        find: '            : (threshold * 5) / 1000;',
        replace: '            : (threshold * 6) / 1000;',
        expectedKilledBy: 'test_pool_fee_unset_chargesTheBaseline50bpsLiteral',
      },
      {
        id: 'M5',
        description: 'resolver activation boundary off-by-one (a value never activates at its own epoch)',
        find: 'if (e <= nowEpoch && (!found || e > best)) {',
        replace: 'if (e < nowEpoch && (!found || e > best)) {',
        expectedKilledBy: 'test_pool_fee_openedOverride_drivesTheStoredFee',
      },
      {
        id: 'M6',
        description: 'fail-closed clock catch returns max epoch (unarmed kernel silently activates every schedule)',
        find: '        } catch {\n            return 0;\n        }',
        replace: '        } catch {\n            return type(uint64).max;\n        }',
        expectedKilledBy: 'test_pool_unarmedKernel_failsClosedToBaseline',
      },
      {
        id: 'M7',
        description: 'threshold-cap gate flips to inclusive (a threshold exactly at the cap is wrongly rejected)',
        find: 'if (currencyType == Currency.PVT && capExists && threshold > capValue) {',
        replace: 'if (currencyType == Currency.PVT && capExists && threshold >= capValue) {',
        expectedKilledBy: 'test_pool_thresholdCap_allowsPVTExactlyAtCap',
      },
      {
        id: 'M8',
        description: 'contributor-cap gate flips to inclusive (one contributor over the active limit is admitted)',
        find: 'contributorList[poolId].length < contributorLimit,',
        replace: 'contributorList[poolId].length <= contributorLimit,',
        expectedKilledBy: 'test_pool_maxContributors_openedOverride_tightensTheGate',
      },
      {
        // institution deployment — the item-4 retirement guard (see the Promise note).
        id: 'M9',
        description: 'PVT-fee-discount retirement guard removed (silent USDC fallback returns)',
        find: 'if (payFeeInPVT) revert PVTFeeDiscountRetired();',
        replace: 'if (false) revert PVTFeeDiscountRetired();',
        expectedKilledBy: 'test_USDC_pvtFeeDiscount_isRetired_andRevertsLoudly',
      },
    ],
  },

  // institution deployment — ProvianEscrowV4. The harness never registered EscrowV4 (pre-existing gap);
  // its only institution deployment change is the item-4 price-read retirement, so it gets a focused
  // registration that mutation-verifies exactly that guard.
  ProvianEscrowV4: {
    sourcePath: 'contracts/src/ProvianEscrowV4.sol',
    // institution deployment addendum-2: include the institution deployment suites, or 's infeasibility pins (the
    // burn-at-funding fact the whole STOP rests on) are mutated with no test in scope.
    // audit: ProvianPVT9AgentBankSinks + ProvianPVT9SinkCostPolicy both construct
    // a real ProvianEscrowV4 and were out of scope.
    // InstitutionSafety constructs a real EscrowV4 (fix 2 + the escrow seed), and
    // ProvianCourtV2.t.sol's two end-to-end suites now run on a real EscrowV4 (ported from V3).
    testMatchPath: 'test/{ProvianEscrowV4*,Institution*,ProvianPVT9AgentBankSinks*,ProvianPVT9SinkCostPolicy*,InstitutionSafety*,ProvianCourtV2.t*,RetiredContractReachability.t*}.sol',
    mutations: [
      // fix 2: the escrow must record WHEN it settled outside the Court.
      {
        id: 'SUCCESSOR_GUARD-1',
        description: 'fix 2 dropped on the admin path: resolveDispute does not record disputeSettledAt',
        find: '        e.status = Status.Resolved;\n        disputeSettledAt[escrowId] = block.timestamp;\n        _settleResolution(escrowId, e, releaseToRecipient);',
        replace: '        e.status = Status.Resolved;\n        _settleResolution(escrowId, e, releaseToRecipient);',
        expectedKilledBy: 'test_fix2_adminResolvesOnEscrow_panelKeepsCollateral',
      },
      {
        id: 'SUCCESSOR_GUARD-2',
        description: 'fix 2 dropped on the timeout path: claimDisputeTimeout does not record disputeSettledAt',
        find: '        e.status = Status.Resolved;\n        disputeSettledAt[escrowId] = block.timestamp;\n        _settleResolution(escrowId, e, false); // refund the depositor',
        replace: '        e.status = Status.Resolved;\n        _settleResolution(escrowId, e, false); // refund the depositor',
        expectedKilledBy: 'test_fix2_escrowTimeout_panelKeepsCollateral',
      },
      {
        id: 'M1',
        description: 'PVT-fee-discount retirement guard removed (silent USDC fallback returns)',
        find: 'if (payFeeInPVT) revert PVTFeeDiscountRetired();',
        replace: 'if (false) revert PVTFeeDiscountRetired();',
        expectedKilledBy: 'test_USDC_pvtFeeDiscount_isRetired_andRevertsLoudly',
      },
      {
        // The surviving USDC path still charges the fee at the literal 50 bps. Bumping
        // it proves the fee-in-settlement-currency behaviour is asserted, not assumed.
        id: 'M2',
        description: 'USDC fee literal changed (fee-in-settlement-currency not enforced)',
        find: 'bool ok2 = usdc.transfer(feeWallet, e.fee);',
        replace: 'bool ok2 = usdc.transfer(feeWallet, e.fee + 1);',
        expectedKilledBy: 'test_USDC_feeStaysInSettlementCurrency',
      },
      // institution deployment addendum-2. The STOP on extending the arbitrator fee share to
      // escrow disputes rests on three facts about this contract. Each is mutated here,
      // so "escrow cannot fund a panel" is a checked claim and not a comment.
      {
        id: 'M3',
        description: 'PVT-principal fee no longer burned at funding (a fee pot would survive to the dispute)',
        find: 'pvt.burn(e.fee);',
        replace: '// pvt.burn(e.fee);',
        expectedKilledBy: 'test_pvtPrincipalFee_isBurnedAtFunding_soNothingSurvivesToPayAPanel',
      },
      {
        id: 'M4',
        description: 'shipped principal-fee rate changed (the reported per-case economics are not derived)',
        find: ': (amount * 5) / 1000;',
        replace: ': (amount * 6) / 1000;',
        expectedKilledBy: 'test_report_perCaseEconomics_escrowCounterfactualIsAVariableNotAFloor',
      },
      {
        id: 'M5',
        description: 'zero bps rejected (the rate would gain a floor the band does not give it)',
        find: 'if (bps > FEE_BPS_MAX) revert CostOutOfDomain(); // lower band is 0',
        replace: 'if (bps > FEE_BPS_MAX || bps == 0) revert CostOutOfDomain();',
        expectedKilledBy: 'test_theEscrowFeeRateCanBeScheduledToZero_soThisIncomeHasNoFloor',
      },
      // institution deployment addendum-3. The flat escrow ADJUDICATION FEE. Each pin is a fact
      // the design rests on, so "the fee is charged, routed, and floored" is checked
      // rather than asserted in a comment.
      {
        id: 'M6',
        description: 'the adjudication fee is never charged (escalation becomes free again)',
        find: 'bool ok = pvt.transferFrom(msg.sender, courtContract, fee);',
        replace: 'bool ok = true;',
        expectedKilledBy: 'test_feeIsRoutedStraightThrough_escrowNeverHoldsIt',
      },
      {
        id: 'M7',
        description: 'the index floor direction is inverted (a measurement could LOWER the fee)',
        find: 'return fromIndex > baseline ? fromIndex : baseline;',
        replace: 'return fromIndex > baseline ? baseline : fromIndex;',
        expectedKilledBy: 'test_indexFloor_bindsOnceIssuanceExceedsTheAnchor / _neverLowersTheFee',
      },
      {
        id: 'M8',
        description: 'the constructor zero-check on the issuance index is dropped',
        find: '            _issuanceIndex == address(0)) {',
        replace: '            false) {',
        expectedKilledBy: 'test_constructorRejectsAZeroIssuanceIndex',
      },
    ],
  },

  // institution parameters-rem — ProvianCourtV2 COST param: panel voting period (override-else-48h).
  ProvianCourtV2: {
    sourcePath: 'contracts/src/ProvianCourtV2.sol',
    // institution deployment: include the arbitrator-collateral and issuance-index suites, or the
    // guards they cover are mutated with no test in scope to catch them.
    // audit: ProvianEscrowV4Pass3.t.sol runs a real EscrowV4 + real CourtV2
    // end-to-end (the #18 blacklisted-recipient verdict and the #4 late-panel race)
    // and was out of scope.
    // InstitutionSafety runs a real Court against a real BondPool + EscrowV4.
    testMatchPath: 'test/{ProvianCourtV2*,Institution*,ProvianEscrowV4Pass3*,InstitutionSafety*}.sol',
    mutations: [
      // fix 2 / the fix-1 backstop: each is mutated out and must be caught.
      {
        id: 'SUCCESSOR_GUARD-1',
        description: 'fix 2 dropped: an escrow settled outside the Court leaves the case Pending (collateral locked)',
        find: '        uint256 settledAt = escrowContract.disputeSettledAt(escrowId);\n        if (settledAt == 0) return false;',
        replace: '        uint256 settledAt = escrowContract.disputeSettledAt(escrowId);\n        if (true) return false;',
        expectedKilledBy: 'test_fix2_adminResolvesOnEscrow_panelKeepsCollateral',
      },
      {
        id: 'SUCCESSOR_GUARD-2',
        description: 'fix 2 dropped: a panel can still act on a case whose escrow already settled',
        find: 'if (escrowContract.disputeSettledAt(escrowId) != 0) revert EscrowSettledOutsideCourt();',
        replace: 'if (false) revert EscrowSettledOutsideCourt();',
        expectedKilledBy: 'test_fix2_closeRefusedWhileStillDisputed',
      },
      {
        id: 'SUCCESSOR_GUARD-3',
        description: 'fix 1 backstop dropped: an assigned-but-abandoned bond panel can never be closed without the admin',
        find: 'if (!_assemblyFailed(p) && !_bondPanelAbandoned(p)) revert PanelStillAssemblable();',
        replace: 'if (!_assemblyFailed(p)) revert PanelStillAssemblable();',
        expectedKilledBy: 'test_fix1_abandonedUnassembledPanel_closesWithoutAdmin',
      },
      {
        id: 'SUCCESSOR_GUARD-4',
        description: 'bondClaimCaseOpen always false: the BondPool cannot see a live panel',
        find: '    function bondClaimCaseOpen(bytes32 claimId) external view returns (bool) {\n',
        replace: '    function bondClaimCaseOpen(bytes32 claimId) external view returns (bool) {\n        if (true) return false;\n',
        expectedKilledBy: 'test_fix1_expiryRefusedUnderLivePanel_slashLands_collateralReturns',
      },
      {
        id: 'M1',
        description: 'prospectivity guard weakened (the current kernel epoch becomes schedulable)',
        find: 'if (effectiveEpoch <= _currentEpoch()) revert PolicyNotProspective();',
        replace: 'if (effectiveEpoch < _currentEpoch()) revert PolicyNotProspective();',
        expectedKilledBy: 'test_court_schedule_rejectsCurrentEpoch',
      },
      {
        id: 'M2',
        description: 'voting-period upper bound accepts one second above the immutable max',
        find: 'if (periodSeconds < PANEL_VOTING_PERIOD_MIN || periodSeconds > PANEL_VOTING_PERIOD_MAX) revert CostOutOfDomain();',
        replace: 'if (periodSeconds < PANEL_VOTING_PERIOD_MIN || periodSeconds > PANEL_VOTING_PERIOD_MAX + 1) revert CostOutOfDomain();',
        expectedKilledBy: 'test_court_schedule_rejectsAboveCeiling',
      },
      {
        id: 'M3',
        description: 're-schedule guard disabled (an already-scheduled epoch may be overwritten)',
        find: 'if (scheduledPanelVotingPeriod[effectiveEpoch].exists) revert PolicyAlreadyScheduled();',
        replace: 'if (false) revert PolicyAlreadyScheduled();',
        expectedKilledBy: 'test_court_schedule_rejectsReschedulingTakenEpoch',
      },
      {
        id: 'M4',
        description: 'unset baseline voting period shifted off the 48-hour literal',
        find: 'return exists ? value : DEFAULT_PANEL_VOTING_PERIOD;',
        replace: 'return exists ? value : DEFAULT_PANEL_VOTING_PERIOD + 1 hours;',
        expectedKilledBy: 'test_court_escrowPanel_unset_arms48hBaseline',
      },
      {
        id: 'M5',
        description: 'resolver activation boundary off-by-one (a value never activates at its own epoch)',
        find: 'if (e <= nowEpoch && (!found || e > best)) {',
        replace: 'if (e < nowEpoch && (!found || e > best)) {',
        expectedKilledBy: 'test_court_escrowPanel_openedOverride_drivesArmedDeadline',
      },
      {
        id: 'M6',
        description: 'fail-closed clock catch returns max epoch (unarmed kernel silently activates every schedule)',
        // institution deployment disambiguation: `_trailingIssuance` now shares the fail-closed
        // `catch { return 0; }` shape, so anchor on the clock's own try-body or this
        // finds two sites and applies to neither.
        find: 'returns (uint64 e) {\n            return e;\n        } catch {\n            return 0;\n        }',
        replace: 'returns (uint64 e) {\n            return e;\n        } catch {\n            return type(uint64).max;\n        }',
        expectedKilledBy: 'test_court_unarmedKernel_failsClosedToBaseline',
      },
      {
        // institution deployment — the ISSUANCE-INDEX fail-closed guard, distinct from the clock one
        // above. If an unreachable index resolved to a huge number instead of 0, the
        // arbitrator collateral would spike rather than standing at its literal.
        id: 'M7',
        description: 'fail-closed index catch returns a huge average (unreachable kernel inflates collateral)',
        find: 'returns (uint256 avg) {\n            return avg;\n        } catch {\n            return 0;\n        }',
        replace: 'returns (uint256 avg) {\n            return avg;\n        } catch {\n            return type(uint128).max;\n        }',
        expectedKilledBy: 'test_failClosed_revertingIndexResolvesToTheLiteral',
      },
      {
        // institution deployment — the floor must be a MAX against the baseline. Flipping it to a MIN
        // turns a cost floor into a cost CEILING, which is the exact inversion the
        // directive forbids.
        id: 'M8',
        description: 'collateral floor becomes a ceiling (max -> min against the baseline)',
        find: 'uint256 base = fromIndex > ARBITRATOR_COLLATERAL_BASELINE ? fromIndex : ARBITRATOR_COLLATERAL_BASELINE;',
        replace: 'uint256 base = fromIndex < ARBITRATOR_COLLATERAL_BASELINE ? fromIndex : ARBITRATOR_COLLATERAL_BASELINE;',
        expectedKilledBy: 'test_floorNeverLowersAParameter',
      },
      {
        // institution deployment addendum — the reward must be paid to the seat that VOTED and
        // burned for the one that did not. Flipping the predicate pays non-voters and
        // burns voters — the exact "posting alone can claim it" hole the directive forbids.
        id: 'M9',
        description: 'arbitrator reward paid to the NON-voting seat (voted predicate inverted)',
        // DE-NESTED this payout (it used to sit inside `if (family == CASE_BOND) {`),
        // which moved the continuation from 20 spaces to 16 and silently made this find
        // string match ZERO times. Re-pinned to the current shape. It now covers BOTH
        // families, which is the point of the generalisation.
        find: 'if (voted) {\n                bool rok = pvt.transfer(arb, rewardShare);',
        replace: 'if (!voted) {\n                bool rok = pvt.transfer(arb, rewardShare);',
        expectedKilledBy: 'test_nonVotingSeat_forfeitsRewardButKeepsCollateral',
      },
      {
        // The fee is split into three equal SEAT shares. /2 over-pays each seat and
        // strands nothing to burn — the split arithmetic is asserted, not assumed.
        id: 'M10',
        description: 'reward share mis-divided (amount/3 -> amount/2)',
        // added `fundEscrowDisputeReward`, which duplicates this statement verbatim,
        // so the bare literal began matching TWICE and errored. Anchored to the bond
        // funder's own assignment line, which is unique.
        find: 'uint256 share = amount / 3;\n        bondRewardSharePerSeat[caseKey] = share;',
        replace: 'uint256 share = amount / 2;\n        bondRewardSharePerSeat[caseKey] = share;',
        expectedKilledBy: 'test_processingFee_fundsThePanel_notProvianTech',
      },
      {
        id: 'M11',
        description: 'fundBondClaimReward onlyBondPool gate disabled (any caller may fund a reward)',
        find: 'if (msg.sender != address(bondPool)) revert NotBondPool();',
        replace: 'if (false) revert NotBondPool();',
        expectedKilledBy: 'test_fundBondClaimReward_onlyBondPool',
      },
      {
        id: 'M12',
        description: 'reward fund-once guard disabled (a claim may be funded twice)',
        find: 'if (bondRewardFunded[caseKey]) revert RewardAlreadyFunded();',
        replace: 'if (false) revert RewardAlreadyFunded();',
        expectedKilledBy: 'test_fundBondClaimReward_isFundedOnce',
      },
      {
        // The 3-way division remainder must BURN, or it is stranded in the Court forever.
        id: 'M13',
        description: 'division-dust burn skipped (remainder stranded, not burned)',
        // Same duplication as M10 — anchored to the bond funder's emit, which is unique.
        find: 'if (dust != 0) pvt.burn(dust);\n\n        emit BondClaimRewardFunded',
        replace: 'if (false) pvt.burn(dust);\n\n        emit BondClaimRewardFunded',
        expectedKilledBy: 'test_fundBondClaimReward_burnsDivisionDust',
      },
      {
        // institution deployment addendum-2. The escrow/bond case-key namespacing is what makes
        // "an escrow seat can never be paid a bond reward" true. Funding under the wrong
        // family strands the reward where no settlement reads it.
        id: 'M14',
        description: 'reward funded under the ESCROW family (bond seats would find no share)',
        find: `        bytes32 caseKey = _caseKey(CASE_BOND, claimId);
        if (bondRewardFunded[caseKey]) revert RewardAlreadyFunded();`,
        replace: `        bytes32 caseKey = _caseKey(CASE_ESCROW, claimId);
        if (bondRewardFunded[caseKey]) revert RewardAlreadyFunded();`,
        expectedKilledBy: 'test_reward_paidToEverySeatThatPostedAndVoted',
      },
      // institution deployment addendum-3. The escrow adjudication-fee rail: its authority, its
      // gate, who it pays, where a forfeited share goes, and the sweep that keeps every
      // funded unit accounted for.
      {
        id: 'M15',
        description: 'onlyEscrow dropped on fundEscrowDisputeReward (anyone could fund a panel reward)',
        find: 'if (msg.sender != address(escrowContract)) revert NotEscrow();',
        replace: 'if (false) revert NotEscrow();',
        expectedKilledBy: 'test_fundEscrowDisputeReward_onlyEscrow',
      },
      {
        id: 'M16',
        description: 'the adjudication-fee gate on assignPanel is dropped (a panel nobody paid for)',
        find: 'if (!escrowRewardFunded[feeKey] || escrowRewardSwept[feeKey]) revert AdjudicationFeeNotPaid();',
        replace: 'if (false) revert AdjudicationFeeNotPaid();',
        expectedKilledBy: 'test_assignPanelIsGatedOnTheFee',
      },
      {
        id: 'M17',
        description: 'the reward is paid without having voted (posting alone would earn it)',
        find: '            if (voted) {\n                bool rok = pvt.transfer(arb, rewardShare);',
        replace: '            if (true) {\n                bool rok = pvt.transfer(arb, rewardShare);',
        expectedKilledBy: 'test_postedButDidNotVote_cannotClaimTheShare_whileVotersArePaid',
      },
      {
        id: 'M18',
        description: 'a forfeited share is redistributed to the next seat instead of burned',
        find: '                pvt.burn(rewardShare);\n                emit ArbitratorRewardForfeited',
        replace: '                pvt.transfer(arb, rewardShare);\n                emit ArbitratorRewardForfeited',
        expectedKilledBy: 'test_forfeitedShare_isBurned_neverRedistributed',
      },
      {
        id: 'M19',
        description: 'the sweep counts postedAmount, not postedMask (double-burns an already-PAID share)',
        find: 'if (p.postedMask & uint8(1 << i) == 0) unclaimable++;',
        replace: 'if (p.postedAmount[i] == 0) unclaimable++;',
        expectedKilledBy: 'test_sweepAfterSettlement_doesNotBurnAnAlreadyPaidShare',
      },
      {
        // 's escrow funder duplicates the bond funder's split and dust burn, and the
        // review that found M10/M13 broken also found that the escrow copies had NEVER
        // been given a mutation. Both rails are now pinned independently.
        id: 'M21',
        description: 'ESCROW reward share mis-divided (amount/3 -> amount/2)',
        find: 'uint256 share = amount / 3;\n        escrowRewardSharePerSeat[caseKey] = share;',
        replace: 'uint256 share = amount / 2;\n        escrowRewardSharePerSeat[caseKey] = share;',
        expectedKilledBy: 'test_shippedFee_mirrorsTheBondAdjudicationEconomics / _paysFromItsOwnFee',
      },
      {
        id: 'M22',
        description: 'ESCROW division-dust burn skipped (remainder stranded, not burned)',
        find: 'if (dust != 0) pvt.burn(dust);\n\n        emit EscrowDisputeRewardFunded',
        replace: 'if (false) pvt.burn(dust);\n\n        emit EscrowDisputeRewardFunded',
        expectedKilledBy: 'test_fundingBurnsTheDivisionDust_andADivisibleFeeBurnsNone',
      },
      {
        id: 'M20',
        description: 'the never-assigned sweep delay is dropped (a live case could be swept immediately)',
        find: '                revert SweepDelayNotElapsed();',
        replace: '                { }',
        expectedKilledBy: 'test_sweepRefusedWhileTheCaseIsStillLive',
      },
    ],
  },

  // institution parameters-rem — ProvianBondPool additive cost overlay (per-param scheduled override else storage).
  ProvianBondPool: {
    sourcePath: 'contracts/src/ProvianBondPool.sol',
    // audit: ProvianCourtV2.t.sol (ProvianCourtV2BondClaimTest composes a REAL
    // BondPool), ProvianPVT9AgentBankSinks and ProvianPVT9SinkCostPolicy all construct a
    // real ProvianBondPool and were all out of scope.
    // institution deployment: see the ProvianCourtV2 note — the index/grandfathering guards live in
    // the institution deployment suites.
    // InstitutionSafety constructs a real BondPool (fixes 1 + 3, the bond seed).
    testMatchPath: 'test/{ProvianBondPool*,Institution*,ProvianCourtV2*,ProvianPVT9AgentBankSinks*,ProvianPVT9SinkCostPolicy*,InstitutionSafety*}.sol',
    mutations: [
      // fix 1 / fix 3: each guard is mutated out and must be caught.
      {
        id: 'SUCCESSOR_GUARD-1',
        description: 'fix 1 dropped: a bond claim may expire while the Court holds an open panel on it',
        find: 'if (courtContract != address(0) && IBondClaimCourt(courtContract).bondClaimCaseOpen(claimId)) {',
        replace: 'if (false) {',
        expectedKilledBy: 'test_fix1_expiryRefusedUnderLivePanel_slashLands_collateralReturns',
      },
      {
        id: 'SUCCESSOR_GUARD-2',
        description: 'fix 3 dropped: abandonment burns a bond that still has a pending claim',
        find: '        // decrement or slash a later bond it was not filed against.\n        if (bond.pendingClaims > 0) revert ClaimsPending();',
        replace: '        // decrement or slash a later bond it was not filed against.\n        if (false) revert ClaimsPending();',
        expectedKilledBy: 'test_fix3_abandonmentWaitsForPendingClaim_nextBondStartsClean',
      },
      {
        id: 'SUCCESSOR_GUARD-3',
        description: 'fix 3 backstop dropped: postBond overwrites a stale pending-claim count',
        find: 'if (bonds[msg.sender].pendingClaims != 0) revert ClaimsPending();',
        replace: 'if (false) revert ClaimsPending();',
        expectedKilledBy: 'test_fix3_postBondRefusesStaleCount',
      },
      {
        id: 'M1',
        description: 'prospectivity guard weakened (the current kernel epoch becomes schedulable)',
        find: 'if (effectiveEpoch <= _currentEpoch()) revert PolicyNotProspective();',
        replace: 'if (effectiveEpoch < _currentEpoch()) revert PolicyNotProspective();',
        expectedKilledBy: 'test_bond_schedule_rejectsCurrentEpoch',
      },
      {
        id: 'M2',
        description: 'deposit-burn upper bound accepts one bp above the immutable max',
        find: 'if (bps > BOND_DEPOSIT_BURN_BPS_MAX) revert CostOutOfDomain();',
        replace: 'if (bps > BOND_DEPOSIT_BURN_BPS_MAX + 1) revert CostOutOfDomain();',
        expectedKilledBy: 'test_bond_depositBurn_bounds',
      },
      {
        id: 'M3',
        description: 're-schedule guard disabled (an already-scheduled epoch may be overwritten)',
        find: 'if (scheduledDepositBurnBps[effectiveEpoch].exists) revert PolicyAlreadyScheduled();',
        replace: 'if (false) revert PolicyAlreadyScheduled();',
        expectedKilledBy: 'test_bond_schedule_rejectsReschedulingTakenEpoch',
      },
      {
        id: 'M4',
        description: 'slash-share sum coupling disabled (burn + payout need not total MAX_BPS)',
        find: 'if (burnBps + payoutBps != MAX_BPS) revert SlashBpsInvariant();',
        replace: 'if (false) revert SlashBpsInvariant();',
        expectedKilledBy: 'test_bond_slashShares_couplingInvariants',
      },
      {
        id: 'M5',
        description: 'slash-payout floor coupling disabled (payout may drop below the 50% victim-recovery floor)',
        find: 'if (payoutBps < MIN_SLASH_PAYOUT_BPS) revert SlashPayoutBelowFloor();',
        replace: 'if (false) revert SlashPayoutBelowFloor();',
        expectedKilledBy: 'test_bond_slashShares_couplingInvariants',
      },
      {
        id: 'M6',
        description: 'deposit-burn override ignored by the lifecycle (postBond always uses the storage baseline)',
        find: '        (bool e, uint256 v) = activeDepositBurnBps();\n        return e ? v : depositBurnBps;',
        replace: '        activeDepositBurnBps();\n        return depositBurnBps;',
        expectedKilledBy: 'test_bond_depositBurn_override_drivesPostBondBurn',
      },
      {
        id: 'M7',
        description: 'base-bond override ignored by the lifecycle (getRequiredBond always uses the storage ladder)',
        // institution deployment re-anchor: `_effBaseBonds` now floors each rung through the issuance
        // index, so the override collapse moved to its own line. Same mutation:
        // ignore the scheduled override and always read the storage ladder.
        find: '        (uint256 baseL2, uint256 baseL3) = e ? (a, b) : (level2BaseBond, level3BaseBond);',
        replace: '        (uint256 baseL2, uint256 baseL3) = (level2BaseBond, level3BaseBond); e;',
        expectedKilledBy: 'test_bond_baseBonds_override_drivesGetRequiredBond',
      },
      {
        id: 'M8',
        description: 'fail-closed clock catch returns max epoch (unarmed kernel silently activates every schedule)',
        // institution deployment disambiguation — see the Court note above.
        find: 'returns (uint64 e) {\n            return e;\n        } catch {\n            return 0;\n        }',
        replace: 'returns (uint64 e) {\n            return e;\n        } catch {\n            return type(uint64).max;\n        }',
        expectedKilledBy: 'test_bond_unarmedKernel_failsClosedToBaseline',
      },
      {
        // institution deployment — the issuance-index fail-closed guard (distinct from the clock one).
        id: 'M14',
        description: 'fail-closed index catch returns a huge average (unreachable kernel inflates every bond cost)',
        find: 'returns (uint256 avg) {\n            return avg;\n        } catch {\n            return 0;\n        }',
        replace: 'returns (uint256 avg) {\n            return avg;\n        } catch {\n            return type(uint128).max;\n        }',
        expectedKilledBy: 'test_failClosed_revertingIndexResolvesToTheLiteral',
      },
      {
        // institution deployment — the floor must be a MAX. As a MIN it becomes a ceiling that DROPS
        // every requirement below its literal.
        id: 'M15',
        description: 'index floor becomes a ceiling (max -> min against the baseline)',
        find: 'return fromIndex > baseline ? fromIndex : baseline;',
        replace: 'return fromIndex < baseline ? fromIndex : baseline;',
        expectedKilledBy: 'test_floorNeverLowersAParameter',
      },
      {
        // institution deployment — GRANDFATHERING. Reverting the downgrade threshold to a LIVE
        // re-derivation is exactly the retroactive revaluation the directive bans.
        id: 'M16',
        description: 'slashBond re-derives the requirement LIVE instead of reading the grandfathered snapshot',
        find: 'uint256 required = requiredAtPost[agent];',
        replace: 'uint256 required = getRequiredBond(bond.autonomyLevel, 0);',
        expectedKilledBy: 'test_grandfathering_existingBondIsNeverRepricedWhenTheFloorRises',
      },
      {
        // institution deployment — the same retroactive-revaluation hole on the top-up ceiling.
        id: 'M17',
        description: 'topUpBond re-derives the ceiling LIVE instead of reading the grandfathered snapshot',
        find: 'uint256 requiredLock = requiredAtPost[msg.sender];',
        replace: 'uint256 requiredLock = getRequiredBond(bond.autonomyLevel, 0);',
        expectedKilledBy: 'test_grandfathering_existingBondIsNeverRepricedWhenTheFloorRises',
      },
      // bond lifecycle — topUpBond (shortfall restore: no burn, no fee, 100% slashable
      // collateral, bounded by the undiscounted base lock).
      {
        id: 'M9',
        description: 'top-up shortfall bound disabled (arbitrary buffer above the base-lock requirement)',
        find: 'if (bond.amount + amount > requiredLock) revert TopUpExceedsRequirement();',
        replace: 'if (false) revert TopUpExceedsRequirement();',
        expectedKilledBy: 'test_topUpBond_shortfallBounded_neverAboveRequirement',
      },
      {
        id: 'M10',
        description: 'top-up zero-amount guard dropped',
        find: 'if (amount == 0) revert InvalidAmount();',
        replace: 'if (false) revert InvalidAmount();',
        expectedKilledBy: 'test_topUpBond_zeroAmountReverts',
      },
      {
        id: 'M11',
        description: 'top-up collateral accounting halved (credited less than transferred)',
        find: 'bond.amount += amount;',
        replace: 'bond.amount += amount / 2;',
        expectedKilledBy: 'test_topUpBond_restoresErodedCollateral_noBurnNoFee',
      },
      {
        id: 'M12',
        description: 'top-up transfer skipped (free collateral: credited without moving PVT)',
        find: 'bool ok = pvt.transferFrom(msg.sender, address(this), amount);',
        replace: 'bool ok = true; // MUTANT: no transfer',
        expectedKilledBy: 'test_topUpBond_restoresErodedCollateral_noBurnNoFee (pool/agent balance deltas)',
      },
      {
        id: 'M13',
        description: 'top-up event lies about the resulting collateral (backend chain-truth source corrupted)',
        find: 'emit BondToppedUp(msg.sender, amount, bond.amount);',
        replace: 'emit BondToppedUp(msg.sender, amount, amount);',
        expectedKilledBy: 'test_topUpBond_emitsEvent',
      },
      {
        // institution deployment addendum — the SLASH path must route the processing fee into the
        // arbitrator reward. Deleting the funding callback leaves the fee at the Court with
        // no reward recorded, so no seat can ever claim it. (The callback line appears in
        // both slashBond and dismissClaim; the trailing downgrade comment makes this the
        // slash site uniquely.)
        id: 'M18',
        description: 'slash path does not fund the arbitrator reward (funding callback removed)',
        find: '            IArbitratorRewardSink(courtContract).fundBondClaimReward(claimId, effProcessingFee);\n        }\n\n        // Emit downgrade event if bond falls below its required minimum.',
        replace: '        }\n\n        // Emit downgrade event if bond falls below its required minimum.',
        expectedKilledBy: 'test_partialSlash_stillFundsTheReward',
      },
      {
        // institution deployment addendum — same for the DISMISS path (unique via the ClaimDismissed emit).
        id: 'M19',
        description: 'dismiss path does not fund the arbitrator reward (funding callback removed)',
        find: '            IArbitratorRewardSink(courtContract).fundBondClaimReward(claimId, effProcessingFee);\n        }\n\n        emit ClaimDismissed(claimId, agent);',
        replace: '        }\n\n        emit ClaimDismissed(claimId, agent);',
        expectedKilledBy: 'test_processingFee_fundsThePanel_notProvianTech',
      },
    ],
  },

  // authorized PVT9 BOOTSTRAP_ADMIN move. The kernel pair had no registry entry
  // before; both are registered here so the change is mutation-proven and every later edit
  // has a scoped adequacy check. The first two mutations of each set target the authority
  // surface the move touches (the constant itself and its gate); the rest hold the
  // economic core that must not have drifted with it.
  ProvianPVT9: {
    sourcePath: 'contracts/src/ProvianPVT9.sol',
    // the derived-suite check caught four *CostMachinery suites that construct a
    // real ProvianPVT9 (as their kernel clock / issuance index) and were out of scope.
    // KernelArmingInputs constructs a real kernel (the arming-time cap policy + window).
    testMatchPath: 'test/{ProvianPVT9*,ProvianRecourseKernel,ProvianRecourseHistory,ProvianBondPoolCostMachinery*,ProvianCourtV2CostMachinery*,ProvianEscrowV4CostMachinery*,ProvianPoolV3CostMachinery*,KernelArmingInputs*,RetiredContractReachability}.t.sol',
    mutations: [
      // the arming-time cap policy and the pre-epoch-zero Genesis open.
      {
        id: 'SUCCESSOR_GUARD-1',
        description: 'arming ignores the configured cap mode (epoch zero falls back to Automatic)',
        find: '_activeCombinedCapMode = config.combinedCapMode;',
        replace: '_activeCombinedCapMode = CombinedCapMode.Automatic;',
        expectedKilledBy: 'test_armedUncapped_everyEpochOpensFixedMax',
      },
      {
        id: 'SUCCESSOR_GUARD-2',
        description: 'arming ignores the configured Genesis cap (epoch zero keeps the 7.5M seed)',
        find: '_activeGenesisCap = config.genesisCap;',
        replace: '_activeGenesisCap = INITIAL_GENESIS_EPOCH_CAP;',
        expectedKilledBy: 'test_armedUncapped_everyEpochOpensFixedMax',
      },
      {
        id: 'SUCCESSOR_GUARD-3',
        description: 'the Genesis window may close at or before epoch zero',
        find: '|| config.genesisEndsAt <= config.epochZeroStartsAt',
        replace: '|| false',
        expectedKilledBy: 'test_datesRefused',
      },
      {
        id: 'SUCCESSOR_GUARD-4',
        description: 'a zero Genesis start is accepted',
        find: 'config.epochZeroStartsAt <= block.timestamp || config.genesisStartsAt == 0',
        replace: 'config.epochZeroStartsAt <= block.timestamp',
        expectedKilledBy: 'test_datesRefused',
      },
      {
        id: 'SUCCESSOR_GUARD-5',
        description: 'Automatic mode may carry a fixed combined cap',
        find: 'if (config.combinedCapMode == CombinedCapMode.Automatic && config.fixedCombinedCap != 0) {',
        replace: 'if (false) {',
        expectedKilledBy: 'test_automaticWithFixedCap_refused',
      },
      {
        id: 'M1',
        description: 'BOOTSTRAP_ADMIN constant moved off the authorized address',
        find: 'address public constant BOOTSTRAP_ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;',
        replace: 'address public constant BOOTSTRAP_ADMIN = 0x000000000000000000000000000000000000dEaD;',
        expectedKilledBy: 'ProvianPVT9Core: assertEq(fresh.BOOTSTRAP_ADMIN(), ADMIN)',
      },
      {
        id: 'M2',
        description: 'bootstrap-admin gate disabled (any caller may arm, appoint, hold, close Genesis)',
        find: 'if (msg.sender != BOOTSTRAP_ADMIN) revert OnlyBootstrapAdmin();',
        replace: 'if (false) revert OnlyBootstrapAdmin();',
        expectedKilledBy: 'ProvianPVT9Core: non-admin callers must revert OnlyBootstrapAdmin',
      },
      {
        id: 'M3',
        description: 'operational-minter gate disabled (any caller may settle a batch)',
        find: 'if (msg.sender != operationalMinter || msg.sender == address(0)) revert OnlyOperationalMinter();',
        replace: 'if (false) revert OnlyOperationalMinter();',
        expectedKilledBy: 'ProvianPVT9Core: non-minter settlement must revert OnlyOperationalMinter',
      },
      {
        id: 'M4',
        description: 'administrative hold ignored (settlement proceeds while held)',
        find: 'if (administrativeHold) revert AdministrativeHoldActive();',
        replace: 'if (false) revert AdministrativeHoldActive();',
        expectedKilledBy: 'ProvianPVT9Core: held kernel must refuse settlement',
      },
      {
        id: 'M5',
        description: 'Genesis epoch cap off-by-one (one wei above the armed cap mints)',
        find: 'if (nextGenesisIssued > policy.genesisCap) revert GenesisEpochCapExceeded();',
        replace: 'if (nextGenesisIssued > policy.genesisCap + 1) revert GenesisEpochCapExceeded();',
        // Killed by an overflow panic in testProspectiveMintRateHasNoPermanentMaximumAndUsesFullPrecision,
        // NOT by a settle-exactly-at-cap+1 case -- no suite settles that exact boundary today.
        expectedKilledBy: 'testProspectiveMintRateHasNoPermanentMaximumAndUsesFullPrecision',
      },
      {
        id: 'M6',
        description: 'combined epoch cap off-by-one (one wei above the armed cap mints)',
        find: 'if (nextTotalIssued > policy.combinedCap) revert CombinedEpochCapExceeded();',
        replace: 'if (nextTotalIssued > policy.combinedCap + 1) revert CombinedEpochCapExceeded();',
        // Same as M5: the killer is the full-precision mint-rate case, not a cap-boundary case.
        expectedKilledBy: 'testProspectiveMintRateHasNoPermanentMaximumAndUsesFullPrecision',
      },
      {
        id: 'M7',
        description: 'immutable human contributor share cut (99% floor silently reduced)',
        find: 'uint256 contributorShare = recipientGross.mulDiv(HUMAN_CONTRIBUTOR_BPS, BPS_DENOMINATOR);',
        replace: 'uint256 contributorShare = recipientGross.mulDiv(HUMAN_CONTRIBUTOR_BPS - 1, BPS_DENOMINATOR);',
        expectedKilledBy: 'ProvianPVT9Policy: Genesis 99/0.5/0.5 split',
      },
    ],
  },

  ProvianPVT9EligibilityVerifier: {
    sourcePath: 'contracts/src/ProvianPVT9EligibilityVerifier.sol',
    // ProvianPVT9SettlementGasCurve.t.sol constructs a real verifier and was out of scope.
    testMatchPath: 'test/{ProvianPVT9EligibilityVerifier,ProvianPVT9SettlementGasCurve}.t.sol',
    mutations: [
      {
        id: 'M1',
        description: 'BOOTSTRAP_ADMIN constant moved off the kernel constant',
        find: 'address public constant BOOTSTRAP_ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;',
        replace: 'address public constant BOOTSTRAP_ADMIN = 0x000000000000000000000000000000000000dEaD;',
        expectedKilledBy: 'assertEq(verifier.BOOTSTRAP_ADMIN(), pvt.BOOTSTRAP_ADMIN())',
      },
      {
        id: 'M2',
        description: 'bootstrap-admin gate disabled (any caller may appoint the batch approver or lift the hold)',
        find: 'if (msg.sender != BOOTSTRAP_ADMIN) revert OnlyBootstrapAdmin();',
        replace: 'if (false) revert OnlyBootstrapAdmin();',
        expectedKilledBy: 'non-admin appointBatchApprover must revert OnlyBootstrapAdmin',
      },
      {
        id: 'M3',
        description: 'batch-approver gate disabled (any caller may record an approval)',
        find: 'if (msg.sender != approver) revert OnlyBatchApprover();',
        replace: 'if (false) revert OnlyBatchApprover();',
        expectedKilledBy: 'non-approver approveStandardBatch must revert OnlyBatchApprover',
      },
      {
        id: 'M4',
        description: 'administrative hold ignored (approvals recorded while held)',
        find: 'if (administrativeHold) revert Held();',
        replace: 'if (false) revert Held();',
        expectedKilledBy: 'held verifier must refuse approvals',
      },
      {
        id: 'M5',
        description: 'approval recorded under a fixed lane (a Genesis approval satisfies the standard lane)',
        find: 'approval.lane = lane;',
        replace: 'approval.lane = ProvianPVT9.SettlementLane.StandardPE;',
        expectedKilledBy: 'test_genesisApproval_doesNotSatisfyStandardLane',
      },
      // NOT registered: dropping the `claimsHash != KERNEL.hashStandardClaims(...)` guard.
      // With the mirror pristine it is an EQUIVALENT mutant -- that guard can only fire
      // once the mirrored domain separator has ALSO drifted, so no single-edit mutation of
      // this file can be caught by it, and registering it would report a coverage gap that
      // is not one. The drift it defends against is a second, separate source change.
    ],
  },
  // B1 (x402 facilitator) — the immutable fee settler. Its fork suite
  // (ProvianX402FeeSettlerFork.t.sol) is live-RPC and excluded below; the mock suite
  // carries every killer.
  ProvianX402FeeSettler: {
    sourcePath: 'contracts/src/ProvianX402FeeSettler.sol',
    testMatchPath: 'test/ProvianX402FeeSettler.t.sol',
    mutations: [
      {
        id: 'M1',
        description: 'onlyOperator gate removed (any caller may settle and pull a fee)',
        find: 'if (msg.sender != operator) revert NotOperator();',
        replace: '',
        expectedKilledBy: 'test_settleWithAuthorization_nonOperator_reverts',
      },
      {
        id: 'M2',
        description: 'USDC-path fee cap removed (fee above MAX_FEE accepted)',
        find: 'if (fee == 0 || fee > MAX_FEE) revert FeeOutOfRange();\n        if (fee >= value) revert FeeNotBelowValue();',
        replace: 'if (fee == 0) revert FeeOutOfRange();\n        if (fee >= value) revert FeeNotBelowValue();',
        expectedKilledBy: 'test_settleWithAuthorization_feeAboveMax_reverts',
      },
      {
        id: 'M3',
        description: 'Permit2-path fee range check removed (zero or above-cap fee accepted)',
        find: 'if (fee == 0 || fee > MAX_FEE) revert FeeOutOfRange();\n        address token = permit.permitted.token;',
        replace: 'address token = permit.permitted.token;',
        expectedKilledBy: 'test_settleWithPermit2_feeAboveMax_reverts',
      },
      {
        id: 'M4',
        description: 'USDC-path zero-fee lower bound removed',
        find: 'if (fee == 0 || fee > MAX_FEE) revert FeeOutOfRange();\n        if (fee >= value)',
        replace: 'if (fee > MAX_FEE) revert FeeOutOfRange();\n        if (fee >= value)',
        expectedKilledBy: 'test_settleWithAuthorization_zeroFee_reverts',
      },
      {
        id: 'M5',
        description: 'fee < value check removed on the USDC path (seller can go net negative)',
        find: 'if (fee >= value) revert FeeNotBelowValue();',
        replace: '',
        expectedKilledBy: 'test_settleWithAuthorization_feeEqualsValue_reverts',
      },
      {
        id: 'M6',
        description: 'fee < amount check removed on the Permit2 path when the token is USDC',
        find: 'if (token == usdc && fee >= amount) revert FeeNotBelowValue();',
        replace: '',
        expectedKilledBy: 'test_settleWithPermit2_usdcFeeEqualsAmount_reverts',
      },
      {
        id: 'M7',
        description: 'seller balance-delta check removed (a fee is pulled without the payment landing)',
        find: 'if (afterBal < before || afterBal - before < amount) revert PaymentNotReceived();',
        replace: 'if (afterBal < before) revert PaymentNotReceived();',
        expectedKilledBy: 'test_settleWithPermit2_nonDeliveringProxy_paymentNotReceived',
      },
      {
        id: 'M8',
        description: 'fee sent to the caller (msg.sender) instead of the immutable feeRecipient',
        find: 'usdc.call(abi.encodeWithSelector(0x23b872dd, seller, feeRecipient, fee));',
        replace: 'usdc.call(abi.encodeWithSelector(0x23b872dd, seller, msg.sender, fee));',
        expectedKilledBy: 'test_settleWithAuthorization_happyPath',
      },
      {
        id: 'M9',
        description: 'false-returning fee transferFrom accepted (safe-transfer bool check dropped)',
        find: 'if (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1)) revert FeeTransferFailed();',
        replace: '',
        expectedKilledBy: 'test_settleWithAuthorization_falseReturningTransferFrom_reverts',
      },
      {
        id: 'M10',
        description: 'Permit2 token allowlist removed (payment in any token, e.g. a worthless one, accepted)',
        find: 'if (token != pvt && token != usdc) revert TokenNotAccepted();',
        replace: '',
        expectedKilledBy: 'test_settleWithPermit2_unknownToken_revertsTokenNotAccepted',
      },
    ],
  },
  ProvianSuccessionImporter: {
    sourcePath: 'contracts/src/ProvianSuccessionImporter.sol',
    testMatchPath: 'test/ProvianSuccessionImporter.t.sol',
    mutations: [
      {
        id: 'IMPORTER-1', description: 'failed proof no longer rolls back its batch',
        find: 'if (!ok) revert InvalidImport();', replace: 'if (false) revert InvalidImport();',
        expectedKilledBy: 'testBadLaterProofRollsBackEveryEarlierImport',
      },
      {
        id: 'IMPORTER-2', description: 'history batch accepts an unrelated target function',
        find: ': selector != ProvianRecoveryHistory.importEntry.selector && selector != ProvianRecoveryHistory.importBatch.selector)',
        replace: ': false)',
        expectedKilledBy: 'testCannotRedirectCallsInvokeOtherFunctionsOrCrossImportFamilies',
      },
      {
        id: 'IMPORTER-3', description: 'completed balance import accepts an altered destination',
        find: 'if (digest != source.restorationRoot()) revert InvalidImport();', replace: 'if (false) revert InvalidImport();',
        expectedKilledBy: 'testPermissionlessBatchPreservesExactEntryBatchAndBalanceArguments',
      },
      {
        id: 'IMPORTER-4', description: 'already imported leaves are executed a second time',
        find: 'if (balances ? _balanceDone(data) : _historyDone(selector, data)) continue;', replace: 'if (false) continue;',
        expectedKilledBy: 'testPermissionlessBatchPreservesExactEntryBatchAndBalanceArguments',
      },
    ],
  },
  ProvianOwnershipRegistry: {
    sourcePath: 'contracts/src/ProvianOwnershipRegistry.sol',
    testMatchPath: 'test/ProvianOwnershipRegistry*.t.sol',
    mutations: [{
      id: 'BINDING-HISTORICAL-EVIDENCE', description: 'a valid pre-break loss loses evidence admission after registry reset',
      find: 'previous.ownerOf(account) == identity && bound != 0 && bound <= lossBlock', replace: 'false',
      expectedKilledBy: 'testSnapshotPreservesAdmissionOfTheOriginalPreBreakLoss',
    }, {
      id: 'BINDING-EVIDENCE-CUTOFF', description: 'discarded post-cutoff loss can use an older binding',
      find: 'if (cutoff < lossBlock) return 0;', replace: 'if (false) return 0;',
      expectedKilledBy: 'testHistoricalEvidenceCannotBackdateBindingOrUseDiscardedLossBlocks',
    }, {
      id: 'BINDING-EVIDENCE-FIRST-BLOCK', description: 'binding after the loss is accepted as historical protection',
      find: 'bound <= lossBlock) return bound;', replace: 'true) return bound;',
      expectedKilledBy: 'testHistoricalEvidenceCannotBackdateBindingOrUseDiscardedLossBlocks',
    }, {
      id: 'BINDING-SNAPSHOT-COMMITMENT', description: 'old snapshot wallet can replace its independent commitment through prospective binding',
      find: 'if (existing == bytes32(0) && _boundBeforeBreak(b.account)) revert InvalidBinding();',
      replace: 'if (false) revert InvalidBinding();',
      expectedKilledBy: 'testOldSnapshotAddressCannotReplaceItsOriginalCommitment',
    }, {
      id: 'BINDING-ORDINARY-SNAPSHOT', description: 'ordinary successor permits poisoning a prior unclaimed break entitlement',
      find: 'existing == bytes32(0) && _boundBeforeBreak(b.account)',
      replace: 'afterCryptographicBreak && existing == bytes32(0) && _boundBeforeBreak(b.account)',
      expectedKilledBy: 'testOrdinarySuccessorStillProtectsUnclaimedBreakOwnership',
    }, {
      id: 'BINDING-ANCESTRAL-SNAPSHOT', description: 'only the latest reset protects pre-cutoff wallets',
      find: 'origin = IRegisteredOwnerAuthorization(\n                IRegisteredRecourseKernel(previousKernel).ownerAuthorization()).breakOrigin();',
      replace: 'origin = address(0);',
      expectedKilledBy: 'testRepeatedBreakStillProtectsEarlierUnclaimedOwnership',
    }, {
      id: 'BINDING-CUTOFF', description: 'post-cutoff bindings can falsely disqualify a new independent binding',
      find: 'bound != 0 && bound <= cutoff', replace: 'bound != 0',
      expectedKilledBy: 'testPostCutoffBindingCannotBeBackdatedIntoTheSnapshot',
    }, {
      id: 'BINDING-1',
      description: 'unrelated original addresses may share a public owner identifier',
      find: '(existing == bytes32(0) ? b.identity != addressBinding(b.account) : existing != b.identity)',
      replace: '(existing != bytes32(0) && existing != b.identity)',
      expectedKilledBy: 'testPrivateOwnerCannotBePublishedAsSharedAddressBindingEvenWithBothSignatures',
    }, {
      id: 'BINDING-MEMBER-DOMAIN', description: 'atomic identity signature can be stripped and used for a plain binding',
      find: `return MessageHashUtils.toEthSignedMessageHash(sha256(abi.encode("Provian atomic member address binding",
            block.chainid, address(this), address(pointer), b, consent)));`,
      replace: 'return bindingDigest(b);',
      expectedKilledBy: 'testBindingAndMemberConsentAreAtomicWithBothIndependentOwnerSignatures',
    }],
  },
  ProvianProtocolPointer: {
    "sourcePath": "contracts/src/ProvianProtocolPointer.sol",
    "testMatchPath": "test/{ProvianProtocolPointer,ProvianMemberRecoursePool,ProvianMemberSettlementTickets,ProvianRecourseKernel,ProvianRecourseHistory,ProvianOwnershipRegistry*,RecoursePoolHistory}.t.sol",
    "mutations": [
        {
            "id": "POINTER-1",
            "description": "runtime pin removed",
            "find": "hashes[i] != next[i].codehash",
            "replace": "false",
            "expectedKilledBy": "testUnauthorizedEmptyStaleAndMismatchedCodeRefused"
        },
        {
            "id": "POINTER-2",
            "description": "revision guard removed",
            "find": "if (revision != expectedRevision) revert StaleRevision();",
            "replace": "if (false) revert StaleRevision();",
            "expectedKilledBy": "testUnauthorizedEmptyStaleAndMismatchedCodeRefused"
        },
        {
            "id": "POINTER-3",
            "description": "pool replaced without token succession",
            "find": "if (revision != 0 && next[8] != components[8] && next[0] == components[0]) revert InvalidManifest();",
            "replace": "if (false) revert InvalidManifest();",
            "expectedKilledBy": "testPoolReplacementRequiresTokenSuccessionToPreserveCustodyProtection"
        },
        {
            "id": "POINTER-4",
            "description": "custody institution replaced while retaining its liability token",
            "find": "if (slot != 4 && next[slot] != components[slot]) revert InvalidManifest();",
            "replace": "if (false) revert InvalidManifest();",
            "expectedKilledBy": "testCustodyReplacementRequiresTokenSuccession"
        }
    ]
},
  ProvianRecourseBondPool: {
    "sourcePath": "contracts/src/ProvianRecourseBondPool.sol",
    "testMatchPath": "test/{ProvianRecourseBondPool,ProvianRecourseCourt,ProvianRecourseEscrowPass3}.t.sol",
    "mutations": [
      { "id": "BOND-CUSTODY-1", "description": "bond deposits no longer reserve their backing",
        "find": "encumberedPVT += lockedAmount;", "replace": "encumberedPVT += 0;",
        "expectedKilledBy": "testEncumbranceTracksBondAndFilingDepositButNotDonations" },
      { "id": "BOND-CUSTODY-2", "description": "carried bond obligations omitted",
        "find": "encumberedPVT += s.amount;", "replace": "encumberedPVT += 0;",
        "expectedKilledBy": "testSeededBondObligationExistsBeforeBackingAndRemainsExact" }
    ]
  },
  ProvianRecourseEscrow: {
    "sourcePath": "contracts/src/ProvianRecourseEscrow.sol",
    "testMatchPath": "test/{ProvianRecourseBondPool,ProvianRecourseCourt,ProvianRecourseEscrowPass3}.t.sol",
    "mutations": [
      { "id": "ESCROW-CUSTODY-1", "description": "successful credited withdrawal retains a false obligation",
        "find": "if (cur == Currency.PVT) encumberedPVT -= amount;", "replace": "if (false) encumberedPVT -= amount;",
        "expectedKilledBy": "test_18_resolveRelease_toBlacklistedRecipient_creditsPull_PVT" }
    ]
  },
  ProvianRecourseProjectPool: {
    "sourcePath": "contracts/src/ProvianRecourseProjectPool.sol",
    "testMatchPath": "test/ProvianRecourseProjectPoolPass3.t.sol",
    "mutations": [
      { "id": "PROJECT-CUSTODY-1", "description": "project contributions omit their backing obligation",
        "find": "encumberedPVT += amount;", "replace": "encumberedPVT += 0;",
        "expectedKilledBy": "testPVTRefundCreditRemainsEncumberedUntilSuccessfulPull" }
    ]
  },
  ProvianRecourseCourt: {
    "sourcePath": "contracts/src/ProvianRecourseCourt.sol",
    "testMatchPath": "test/{ProvianRecourseBondPool,ProvianRecourseCourt,ProvianRecourseEscrowPass3}.t.sol",
    "mutations": [
      { "id": "COURT-CUSTODY-1", "description": "bond-panel funded awards omit their obligation",
        "find": "bondRewardSharePerSeat[caseKey] = share;\n        encumberedPVT += share * 3;",
        "replace": "bondRewardSharePerSeat[caseKey] = share;\n        encumberedPVT += 0;",
        "expectedKilledBy": "testCourtEncumbranceTracksCollateralAndRewardsButNotDonations" }
    ]
  },
  RecourseOwnerAuthorization: {
    "sourcePath": "contracts/src/RecourseOwnerAuthorization.sol",
    "testMatchPath": "test/{ProvianRecourse*,ProvianMemberRecoursePool,ProvianOwnershipRegistrySnapshot,Recourse*,ProvianHashAccount,SlhDsaSha2128s}.t.sol",
    "mutations": [
        {
            "id": "OWNER-1",
            "description": "owner hash signature verification bypassed",
            "find": "if (!proofVerifier.verify(intent, proof.signature, proof.publicKey)) revert InvalidOwnerAuthorization();",
            "replace": "if (false) revert InvalidOwnerAuthorization();",
            "expectedKilledBy": "testAuthoritySeeingPreimageCannotSubstituteDestinationOrNextRoot"
        }
    ]
},
  ProvianRestorationAuthorization: {
    "sourcePath": "contracts/src/ProvianRestorationAuthorization.sol",
    "testMatchPath": "test/{ProvianRecourse*,ProvianMemberRecoursePool,ProvianOwnershipRegistrySnapshot,Recourse*,ProvianHashAccount,SlhDsaSha2128s}.t.sol",
    "mutations": [
        {
            "id": "RESTORE-REVISION-FENCE",
            "description": "execute a determination from before an entitlement became spendable",
            "find": "reversal.restorationRevision != restorationRevision || ",
            "replace": "",
            "expectedKilledBy": "testImportedFundsInvalidateAStaleReversalWithoutAnOutgoingTransfer"
        },
        {
            "id": "RESTORE-REVISION-ORDINARY",
            "description": "ordinary import does not advance the restoration checkpoint",
            "find": "ordinaryImportedBalance += amount;\n        ++restorationRevision;",
            "replace": "ordinaryImportedBalance += amount;",
            "expectedKilledBy": "testImportedFundsInvalidateAStaleReversalWithoutAnOutgoingTransfer"
        },
        {
            "id": "RESTORE-REVISION-BREAK",
            "description": "free restoration does not invalidate stale reachability",
            "find": "_restoredIdentity[r.identity] = true;\n        ++restorationRevision;",
            "replace": "_restoredIdentity[r.identity] = true;",
            "expectedKilledBy": "testCryptographicBreakUsesSnapshotAndRealHashAuthorityWithOwnerProof"
        },
        {
            "id": "RESTORE-REVISION-INSTITUTION",
            "description": "institutional restoration does not advance the checkpoint",
            "find": "++importedInstitutionCount;importedInstitutionAmount += amount;\n        ++restorationRevision;",
            "replace": "++importedInstitutionCount;importedInstitutionAmount += amount;",
            "expectedKilledBy": "testBreakInstitutionCustodyIsExactAndCannotRedirectOrReplay"
        },
        {
            "id": "RESTORE-1",
            "description": "authority requirement bypassed",
            "find": "executing || msg.sender != IRestorationKernel(kernel).restorationAuthority()",
            "replace": "executing",
            "expectedKilledBy": "testNeitherAuthorityNorOwnerAloneCanReverseAndDestinationCannotChange"
        },
        {
            "id": "RESTORE-2",
            "description": "pool obligations no longer protected from reversal",
            "find": "if (balance < encumbered || poolDebit > balance - encumbered) revert InvalidRestoration();",
            "replace": "if (false) revert InvalidRestoration();",
            "expectedKilledBy": "testReversalProtectsContributionsAndAllocatedAwardsButReachesUnallocatedDonation"
        },
        {
            "id": "RESTORE-3",
            "description": "duplicate pool sources spend the same surplus twice",
            "find": "poolDebit += reversal.amounts[i];",
            "replace": "poolDebit = reversal.amounts[i];",
            "expectedKilledBy": "testRepeatedPoolSourceCannotSpendTheSameUnencumberedSurplusTwice"
        },
        {
            "id": "RESTORE-4",
            "description": "institution obligations no longer protected from reversal",
            "find": "if (balance < obligations || debit > balance - obligations) revert InvalidRestoration();",
            "replace": "if (false) revert InvalidRestoration();",
            "expectedKilledBy": "testBondObligationsProtectedAndDonationReversible"
        },
        {
            "id": "RESTORE-5",
            "description": "duplicate institution sources reuse encumbered surplus",
            "find": "debit += reversal.amounts[i];",
            "replace": "debit = reversal.amounts[i];",
            "expectedKilledBy": "testEscrowObligationsProtectedAndDonationReversible"
        }
    ]
},
  RecourseMonthlyAccounting: {
    "sourcePath": "contracts/src/RecourseMonthlyAccounting.sol",
    "testMatchPath": "test/{ProvianRecourse*,ProvianMemberRecoursePool,Recourse*,ProvianHashAccount,SlhDsaSha2128s}.t.sol",
    "mutations": [
        {
            "id": "MONTH-1",
            "description": "grace extended an unauthorized month",
            "find": "uint256 expiry = m + 2;",
            "replace": "uint256 expiry = m + 3;",
            "expectedKilledBy": "testReadOnlyStatusDistinguishesPaidGraceAndLapsedWithoutKeeper"
        }
    ]
},
  RecourseReserveAccounting: {
    "sourcePath": "contracts/src/RecourseReserveAccounting.sol",
    "testMatchPath": "test/{ProvianRecourse*,ProvianMemberRecoursePool,Recourse*,ProvianHashAccount,SlhDsaSha2128s}.t.sol",
    "mutations": [
      { id: 'RESERVE-RATIO', description: 'published allocation ratio differs from the amounts actually used',
        find: 'emit RestorationRatio(reserve, liabilities, distributable);', replace: 'emit RestorationRatio(reserve, liabilities, reserve);',
        expectedKilledBy: 'testOnlyAllocatedRestorationsExitAndContributionsCannotBeRedeemed' },
        {
            "id": "RESERVE-1",
            "description": "allocated restoration counted as available reserve",
            "find": "return balance - allocatedRestorations;",
            "replace": "return balance;",
            "expectedKilledBy": "testDeterminationAllocationsSurviveMemberExitAndRequireActualMembership"
        }
    ]
},
  SlhDsaSha2128s: {
    "sourcePath": "contracts/src/crypto/SlhDsaSha2128s.sol",
    "testMatchPath": "test/{ProvianRecourse*,ProvianMemberRecoursePool,ProvianMemberSettlementTickets,Recourse*,ProvianHashAccount*,SlhDsaSha2128s,ProvianBreakRecoveryHistory,ProvianOwnershipRegistry*,ProvianProtocolPointer}.t.sol",
    "mutations": [
        {
            "id": "SLH-1",
            "description": "hash root comparison bypassed",
            "find": "return root == pkRoot;",
            "replace": "return true;",
            "expectedKilledBy": "testFuzzRejectMutatedSignature"
        },
        {
            "id": "SLH-2",
            "description": "external message domain omitted",
            "find": "abi.encodePacked(r, pkSeed, pkRoot, bytes2(0), message)",
            "replace": "abi.encodePacked(r, pkSeed, pkRoot, message)",
            "expectedKilledBy": "testIndependentOpenSslVectorsAndStatelessRepeatedKey"
        }
    ]
},
  ProvianRecourseKernel: {
    "sourcePath": "contracts/src/ProvianRecourseKernel.sol",
    "testMatchPath": "test/{ProvianRecourseKernel,ProvianRecourseHistory}.t.sol",
    "mutations": [
        {
            "id": "KERNEL-1",
            "description": "authority can bypass owner executor for balance import",
            "find": "function importAuthorizedBalance(address destination, uint256 amount) external {\n        if (msg.sender != address(ownerAuthorization) || destination == address(0)",
            "replace": "function importAuthorizedBalance(address destination, uint256 amount) external {\n        if (destination == address(0)",
            "expectedKilledBy": "testAuthorityCannotInvokeRestrictedLedgerWithoutOwnerExecutor"
        },
        {
            "id": "KERNEL-2",
            "description": "authority can bypass owner executor for reversal",
            "find": "if (msg.sender != address(ownerAuthorization) || destination == address(0)\n            || sources.length == 0",
            "replace": "if (destination == address(0)\n            || sources.length == 0",
            "expectedKilledBy": "testAuthorityCannotInvokeRestrictedLedgerWithoutOwnerExecutor"
        }
    ]
},
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Read a path's bytes AS OF HEAD (the committed blob). Returns null when the path
// is not present in HEAD or git is unavailable — both of which the pre-run check
// treats as "differs from HEAD": a target git cannot vouch for cannot be proven
// un-mutated.
function gitHeadBytes(relPath) {
  const res = spawnSync('git', ['show', `HEAD:${relPath}`], {
    cwd: REPO_ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout) return null;
  return res.stdout;
}

// (a) PRE-RUN CLEAN CHECK. Before mutating anything, assert EVERY registered target
// source is byte-identical to HEAD. The scenario this closes is a RESUME after an
// interrupted run: if a prior run died with a `.sol` left mutated on disk, reading
// that file as the "original" would silently restore-to-MUTATED and verify the WRONG
// source. A finish-time check cannot catch it (the finish restores to the already
// corrupted baseline, sha-matches it, and reports success) — only a start-time check
// against the committed blob can. It is deliberately whole-registry, not just the
// contract under test: the near-miss was a leftover mutation in a DIFFERENT file than
// the one being run. Returns the list of targets that differ from HEAD (empty === clean).
function preRunDirtyTargets() {
  const dirty = [];
  const seen = new Set();
  for (const set of Object.values(MUTATION_SETS)) {
    const rel = set.sourcePath;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(REPO_ROOT, rel);
    let workingSha;
    try {
      workingSha = sha256(fs.readFileSync(abs));
    } catch {
      dirty.push(`${rel}  (missing from working tree)`);
      continue;
    }
    const head = gitHeadBytes(rel);
    if (head === null) {
      dirty.push(`${rel}  (not present in HEAD / git unavailable)`);
      continue;
    }
    if (sha256(head) !== workingSha) {
      dirty.push(`${rel}  (working tree differs from HEAD)`);
    }
  }
  return dirty;
}

// Run the scoped suite and read the RESULT STRUCTURALLY from forge --json.
// Returns { ran, passed, failed, total, exitCode, stderr }. `ran` is false when
// forge produced no parseable JSON (a compile error or a forge crash) — that is
// distinct from a suite that ran and had failures.
function runScopedSuite(testMatchPath) {
  const res = spawnSync(
    'forge',
    ['test', '--root', 'contracts', '--ffi', '--match-path', testMatchPath, '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // No JSON => compilation failed or forge could not run the suite.
    return { ran: false, passed: 0, failed: 0, total: 0, exitCode: res.status, stderr: (stderr || stdout).trim() };
  }
  let passed = 0;
  let failed = 0;
  for (const suite of Object.values(parsed)) {
    for (const r of Object.values(suite.test_results || {})) {
      if (r.status === 'Success') passed++;
      else failed++;
    }
  }
  return { ran: true, passed, failed, total: passed + failed, exitCode: res.status, stderr: stderr.trim() };
}

/**
 * Run a jest suite SCOPED to the target's test files and decide from jest's
 * structured `--json` output. Never `tail -1`: a compile failure yields no JSON
 * and is reported as "did not run", which the caller treats as ERROR, not KILLED.
 */
function runScopedJestSuite(testMatchPath, sdkVitest = false) {
  const res = spawnSync(
    'npx',
    [...(sdkVitest ? ['vitest', 'run', '--config', 'vitest.config.ts', '--reporter=json'] : ['jest', '--json', '--silent']), ...testMatchPath.split(/\s+/).filter(Boolean)],
    { cwd: sdkVitest === 'native' ? REPO_ROOT : path.join(REPO_ROOT, sdkVitest ? 'provian-agent-sdk' : 'provian-backend'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const start = stdout.indexOf('{');
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return { ran: false, passed: 0, failed: 0, total: 0, exitCode: res.status, stderr: (stderr || stdout).trim() };
  }
  const passed = parsed.numPassedTests ?? 0;
  const failed = parsed.numFailedTests ?? 0;
  // A suite that failed to COMPILE reports 0/0 with failed suites — that is not a kill.
  if (passed + failed === 0 && (parsed.numFailedTestSuites ?? 0) > 0) {
    return { ran: false, passed: 0, failed: 0, total: 0, exitCode: res.status, stderr: 'suite failed to run/compile' };
  }
  return { ran: true, passed, failed, total: passed + failed, exitCode: res.status, stderr: stderr.trim() };
}

function parseArgs(argv) {
  const out = { contract: null, list: false, only: null, selftest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--contract' || a === '--module') out.contract = argv[++i];
    else if (a === '--list') out.list = true;
    else if (a === '--only') out.only = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    // --selftest [signal|throw] proves guard (b): apply a mutation, then interrupt the
    // run (self-SIGTERM, or an uncaught throw) and let the trap restore before exit.
    // The default fault is `throw`, exercising the uncaughtException handler.
    else if (a === '--selftest') out.selftest = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'throw';
    else if (a === '--verify-registry') out.verifyRegistry = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/**
 * REGISTRY VALIDATION. Every `find` must occur EXACTLY ONCE in its pinned source.
 * The harness already enforces that per mutation at run time — but only ~30 minutes in, one
 * contract at a time, and only for the contract being run. That is how three ProvianCourtV2
 * mutations sat broken across two commits: de-indented the reward payout (M9's find
 * went to 0 matches) and duplicated the split/dust statements into a second funding function
 * (M10 and M13 went to 2), and nothing said so until a reviewer checked every literal by hand.
 *
 * This checks the WHOLE registry in under a second and compiles nothing, so a source edit
 * that silently unpins a mutation is caught immediately instead of at the end of a long run.
 * A find that matches 0 times pins nothing; one that matches 2 times aborts its run.
 */
/**
 * Expand a forge `--match-path` glob against the filesystem. Supports the two constructs
 * the registry actually uses — `{a,b}` alternation and `*` — and nothing else, so it
 * cannot quietly disagree with forge about something subtler.
 */
function expandGlob(glob, rootDir) {
  const alts = [];
  const brace = glob.match(/^(.*)\{([^}]*)\}(.*)$/);
  if (brace) for (const part of brace[2].split(',')) alts.push(brace[1] + part + brace[3]);
  else alts.push(glob);

  // PER-ALTERNATIVE, deliberately. Returning only the union was a guard that could not
  // catch its own defect: reintroducing the exact mistake (dropping one trailing
  // `*`) silently cut a set from 8 suites to 7 while the union stayed non-empty, so the
  // check printed `ok` and exited 0. The control caught that, which is the only
  // reason it is not shipped. An alternative that matches NOTHING is dead weight in the
  // pattern and is exactly what a botched brace edit looks like.
  const perAlt = [];
  const matched = new Set();
  for (const alt of alts) {
    const dir = path.dirname(alt);
    const base = path.basename(alt);
    const re = new RegExp('^' + base.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    let entries = [];
    try { entries = fs.readdirSync(path.join(rootDir, dir)); } catch { /* missing dir -> no match */ }
    const hits = entries.filter((e) => re.test(e));
    for (const e of hits) matched.add(path.join(dir, e));
    perAlt.push({ alt, count: hits.length });
  }
  return { files: [...matched].sort(), perAlt };
}

/**
 * Suites deliberately kept OUT of every scope, with the reason each one is excluded —
 * written down so an exclusion is a decision on the record rather than a silent omission.
 */
/**
 * Suites that can never legitimately be in a mutation scope, with the reason each is
 * excluded — on the record rather than silently omitted. NOTE this excludes them from
 * being COUNTED AS A SUITE; it does NOT exclude them from the construction scan below,
 * which is a separate question (a base contract is not a suite but its `new` calls still
 * belong to whatever inherits it).
 */
const NOT_A_RUNNABLE_SUITE = Object.freeze({
  // These two are NOT in the known-failing set: they pass when the RPC serves them. They
  // are excluded because they reach a LIVE endpoint through `vm.createSelectFork`, which
  // would make any mutation verdict depend on network weather.
  'PVT9ThirdPartyPoolabilityFork.t.sol': 'live-RPC fork suite (vm.createSelectFork) — RPC-dependent, excluded to keep mutation verdicts deterministic',
  // 's RED/GREEN institution controls against the DEPLOYED set on a Base fork. The
  // in-process twins of every GREEN case live in InstitutionSafety (in scope above).
  'SuccessorMigrationFork.t.sol': 'live-RPC fork suite (vm.createSelectFork) — RPC-dependent, excluded to keep mutation verdicts deterministic',
  // B1: the settler against the REAL Base USDC / Permit2 / x402 proxy / PVT9; its mock twin
  // ProvianX402FeeSettler.t.sol is in scope and carries every killer.
  'ProvianX402FeeSettlerFork.t.sol': 'live-RPC fork suite (vm.createSelectFork) — RPC-dependent, excluded to keep mutation verdicts deterministic',
  'EchidnaAgentBank.sol': 'zero `function test` — contributes no forge assertions',
  'ProvianAgentBankHalmos.t.sol': 'zero `function test` — contributes no forge assertions',
  'ProvianPVT9TestBase.sol': 'shared base contract, zero `function test` of its own',
});

/**
 * Which suites exercise a given contract, DERIVED FROM SOURCE and resolved THROUGH
 * INHERITANCE.
 *
 * The naive version — grep `new <C>(` per file — was wrong in a way that mattered: four
 * ProvianPVT9 suites obtain the kernel from `ProvianPVT9TestBase`, which is itself not a
 * suite, so none of them contained the literal and all four were classified "extra". A
 * glob narrowed to exactly the "derived" set would then have dropped the settlement and
 * policy suites for the live money kernel while the check said ok. So the scan reads EVERY
 * file (including bases), maps contract -> declaring file and its bases, and a suite counts
 * as exercising C when C is constructed anywhere in its own inheritance chain.
 */
function buildConstructionIndex() {
  const testDir = path.join(REPO_ROOT, 'contracts', 'test');
  // RECURSIVE: a suite or a base parked in a subdirectory would otherwise be invisible to
  // both the suite list and the construction scan.
  const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), path.join(prefix, e.name))
      : (e.name.endsWith('.sol') ? [path.join(prefix, e.name)] : []));
  const files = walk(testDir);
  const sourceDir = path.join(REPO_ROOT, 'contracts', 'src');
  const sources = walk(sourceDir).map(f => `../src/${f}`);
  const byFile = new Map();
  const declaredIn = new Map();
  const libraryNames = new Set();
  for (const f of [...files, ...sources]) {
    const src = fs.readFileSync(path.join(testDir, f), 'utf8');
    const constructs = new Set([...src.matchAll(/new\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{[^}]*\})?\s*\(/g)].map(m => m[1]));
    const declares = [...src.matchAll(/(?:contract|library)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:is\s+([^{]+))?\{/g)]
      .map(m => ({ name: m[1], bases: (m[2] || '').split(',').map(b => b.trim().split(/[\s(]/)[0]).filter(Boolean) }));
    for (const m of src.matchAll(/library\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)) libraryNames.add(m[1]);
    byFile.set(f, { constructs, declares, src, libraries: new Set() });
    for (const d of declares) declaredIn.set(d.name, f);
  }
  for (const entry of byFile.values()) {
    for (const name of libraryNames) if (new RegExp(`\\b${name}\\s*\\.`).test(entry.src)) entry.libraries.add(name);
  }
  return { files, byFile, declaredIn };
}

/**
 * THE EXCLUSION TABLE IS AN INPUT TO THE GUARD, so it has to be guarded too. Every entry
 * subtracts a file from `expected` for EVERY set, and the historical-defect controls cannot
 * see it: adding one line — `'InstitutionEscrowAdjudicationFee.t.sol' 'slow; covered elsewhere'` * plus a narrowed glob dropped EscrowV4 from 215 tests to 125, removing the only suite
 * carrying the M6/M7/M8 killers, while all five controls still passed and the run exited 0.
 * Free text cannot be a load-bearing input.
 *
 * So the REASON is now executable. Only two forms are admissible and each is checked
 * against the file: a zero-test claim must actually have zero `function test`, and a fork
 * claim must actually carry a fork marker. Anything else — including a plausible-sounding
 * excuse like "slow; covered elsewhere" is refused outright.
 */
function auditExclusions() {
  const testDir = path.join(REPO_ROOT, 'contracts', 'test');
  const problems = [];
  for (const [file, reason] of Object.entries(NOT_A_RUNNABLE_SUITE)) {
    const full = path.join(testDir, file);
    if (!fs.existsSync(full)) { problems.push(`exclusion '${file}' names a file that does not exist`); continue; }
    const src = fs.readFileSync(full, 'utf8');
    const tests = (src.match(/function\s+test/g) || []).length;
    if (/zero `function test`|shared base contract/.test(reason)) {
      if (tests !== 0) problems.push(`exclusion '${file}' claims zero tests but declares ${tests}`);
    } else if (/fork suite/.test(reason)) { // covers 'chainId-8453 fork suite' and 'live-RPC fork suite'
      // Two admissible fork signatures, because the repo genuinely uses both: an explicit
      // chainId/createFork guard, OR a suite whose every test is `test_fork_*` and which
      // therefore only runs under `--fork-url`. WS5ForkRedeploy and ProvianPVTv7Cascade are
      // the second kind — the first version of this audit flagged them, correctly, as
      // unverifiable under a marker set that was too narrow. The disjunction is exact:
      // it holds for all 8 fork entries and for neither of the normal suites checked.
      // MATCH AT THE CALL SITE. A bare `8453` substring certified nothing: it matched
      // `uint256 internal constant VECTOR_CHAIN_ID = 8453;` in
      // ProvianPVT9EligibilityVerifier.t.sol — an 80-test, non-fork suite that passes in the
      // ordinary run — so that suite was falsely excludable, which would have collapsed the
      // verifier set from 84 tests to 4 and removed every killer for the verifier deployed
      // at 0xEfbC0651. Dropping the literal loses nothing: all 8 fork entries verify through
      // a real `vm.createSelectFork` call or through allForkNamed.
      const forkTests = (src.match(/function\s+test_fork/g) || []).length;
      const hasMarker = /vm\.(createSelectFork|createFork)\s*\(/.test(src);
      const allForkNamed = tests > 0 && forkTests === tests;
      if (!hasMarker && !allForkNamed) {
        problems.push(`exclusion '${file}' claims to be a fork suite but carries no fork marker and not every test is test_fork_*`);
      }
      // THE TWO KINDS OF FORK SUITE ARE NOT INTERCHANGEABLE, and I mislabelled three
      // entries before this check existed. A suite that calls `vm.createSelectFork` against
      // a live endpoint is normally GREEN and merely RPC-dependent; a suite that fails
      // deterministically without `--fork-url` is known-failing. Calling the first kind
      // "chainId-8453" is what put Pass3CascadeFork in neither STATUS category and made the
      // documented "anything failing outside these suites is real" rule off by one. The
      // reason must now match what the file actually does, in both directions.
      if (hasMarker && /chainId-8453 fork suite/.test(reason)) {
        problems.push(`exclusion '${file}' is labelled 'chainId-8453' but calls vm.createSelectFork — it is a LIVE-RPC suite (normally green); use the live-RPC reason`);
      }
      if (!hasMarker && /live-RPC/.test(reason)) {
        problems.push(`exclusion '${file}' is labelled 'live-RPC' but makes no vm.createSelectFork call`);
      }
    } else {
      problems.push(`exclusion '${file}': reason is not machine-checkable ("${reason}") — an exclusion must claim zero tests or fork-only, and be true`);
    }
  }
  return problems;
}

let CONSTRUCTION_INDEX = null;

function derivedSuitesFor(contractName) {
  if (!CONSTRUCTION_INDEX) CONSTRUCTION_INDEX = buildConstructionIndex();
  const { files, byFile, declaredIn } = CONSTRUCTION_INDEX;

  const exercises = (file, seen = new Set()) => {
    if (seen.has(file)) return false;
    seen.add(file);
    const entry = byFile.get(file);
    if (!entry) return false;
    if (entry.constructs.has(contractName) || entry.libraries.has(contractName)) return true;
    for (const dependency of [...entry.constructs, ...entry.libraries]) {
      const dependencyFile = declaredIn.get(dependency);
      if (dependencyFile && dependencyFile !== file && exercises(dependencyFile, seen)) return true;
    }
    for (const d of entry.declares) {
      for (const b of d.bases) {
        if (b === contractName) return true;
        const baseFile = declaredIn.get(b);
        if (baseFile && baseFile !== file && exercises(baseFile, seen)) return true;
      }
    }
    return false;
  };

  return files.filter((f) => !NOT_A_RUNNABLE_SUITE[f]).filter((f) => exercises(f)).sort();
}

/**
 * EVERY glob defect this repo has actually shipped, replayed on every run as the guard's
 * own negative control.
 *
 * claimed the `b4964267` configuration was "the standing regression case". It was
 * not — it was a one-shot run by hand, which is precisely what CLAUDE.md's paragraph
 * says to prefer against, asserted inside the decision whose conclusion is that lesson.
 * That was the fourth instance of the pattern. These are the actual permanent controls: if
 * ANY of them is accepted, the guard has stopped being able to fail and the run is a
 * failure regardless of what the live registry says.
 */
const HISTORICAL_GLOB_DEFECTS = Object.freeze([
  { set: 'RecourseOwnerAuthorization', glob: 'test/ProvianHashAccount.t.sol', was: 'abstract owner proof omitted through production inheritance' },
  { set: 'SlhDsaSha2128s', glob: 'test/SlhDsaSha2128s.t.sol', was: 'library verifier integration omitted through production constructors' },
  { set: 'ProvianProtocolPointer', glob: 'test/ProvianProtocolPointer.t.sol', was: 'pointer consumers omitted while direct tests remained' },
  { set: 'ProvianCourtV2', glob: 'test/{ProvianCourtV2*,Institution*}.sol',
    was: 'the literal pre-audit glob at b4964267 (loses ProvianEscrowV4Pass3)' },
  { set: 'ProvianBondPool', glob: 'test/{ProvianBondPool*,Institution*}.sol',
    was: 'the literal pre-audit glob at b4964267 (loses ProvianCourtV2* + both PVT9 sink suites)' },
  { set: 'ProvianCourtV2', glob: 'test/{ProvianCourtV2*,Institution*,ProvianEscrowV4Pass3}.sol',
    was: 'a brace alternative with the trailing * dropped — matched nothing, silently' },
  { set: 'ProvianEscrowV4', glob: 'test/{ProvianEscrowV4.t*,InstitutionArbitrator*,ProvianPVT9AgentBankSinks*,ProvianPVT9SinkCostPolicy*}.sol',
    was: 'wildcards narrowed until scope fell 215 -> 77 tests, dropping the M6/M7/M8 killers' },
  { set: 'ProvianPVT9', glob: 'test/{ProvianPVT9Core*,ProvianPVT9EligibilityVerifier*,ProvianPVT9SettlementGasCurve*,ProvianBondPoolCostMachinery*,ProvianCourtV2CostMachinery*,ProvianEscrowV4CostMachinery*,ProvianPoolV3CostMachinery*}.t.sol',
    was: 'narrowed to only the DIRECTLY-constructing suites, dropping four that inherit ProvianPVT9TestBase' },
]);

/** Audit one set's glob. Returns problem strings; empty means the glob is acceptable. */
function auditGlob(name, set, globOverride) {
  const glob = globOverride ?? set.testMatchPath;
  const problems = [];
  const { files, perAlt } = expandGlob(glob, path.join(REPO_ROOT, 'contracts'));
  for (const { alt, count } of perAlt) {
    if (count === 0) problems.push(`${name}: glob alternative '${alt}' matches NO files (dead alternative)`);
  }
  if (files.length === 0) problems.push(`${name}: testMatchPath '${glob}' matches NO files`);

  // Key on the SOURCE FILE, never on the registry key: a set whose key is not the Solidity
  // contract name would otherwise derive [] and accept ANY glob.
  const contractName = path.basename(set.sourcePath, '.sol');
  const expected = derivedSuitesFor(contractName);
  if (expected.length === 0) {
    problems.push(`${name}: derivation found NO suite constructing ${contractName} — the guard cannot work`);
  }
  const inScope = new Set(files.map((f) => path.basename(f)));
  const missing = expected.filter((f) => !inScope.has(f));
  if (missing.length) {
    problems.push(`${name}: ${missing.length} suite(s) construct this contract but are OUT OF SCOPE — ${missing.join(', ')}`);
  }
  return { problems, files, expected, inScope };
}

function verifyRegistry() {
  let checked = 0;
  const bad = [];
  for (const [name, set] of Object.entries(MUTATION_SETS)) {
    const src = fs.readFileSync(path.join(REPO_ROOT, set.sourcePath), 'utf8');
    for (const m of set.mutations) {
      checked += 1;
      const n = src.split(m.find).length - 1;
      if (n !== 1) bad.push(`${name}  ${m.id}: find occurs ${n}x (must be exactly 1)`);
    }
    // Solidity sets only: the jest sets use a space-separated path list, not a glob.
    if (!['jest', 'sdk-vitest', 'native-vitest'].includes(set.runner)) {
      const { problems, files, expected, inScope } = auditGlob(name, set);
      bad.push(...problems);
      const extra = [...inScope].filter((f) => !expected.includes(f)).sort();
      console.log(`#   ${name}: ${files.length} in scope (${expected.length} derived`
        + `${extra.length ? `, ${extra.length} extra` : ''}) — ${files.map((f) => path.basename(f)).join(', ')}`);
    }
  }
  console.log(`# registry: ${checked} find-string(s) checked across ${Object.keys(MUTATION_SETS).length} set(s)`);

  // THE GUARD'S OWN NEGATIVE CONTROL, run every time. A guard observed only passing is a
  // guard nobody has tested; this replays each defect the repo actually shipped and
  // requires the audit to REJECT it.
  bad.push(...auditExclusions());

  const blind = [];
  for (const d of HISTORICAL_GLOB_DEFECTS) {
    const set = MUTATION_SETS[d.set];
    if (!set) { blind.push(`control references unknown set '${d.set}'`); continue; }
    const { problems } = auditGlob(d.set, set, d.glob);
    if (problems.length === 0) blind.push(`${d.set}: ACCEPTED a known-bad glob — ${d.was}`);
  }
  console.log(`# controls: ${HISTORICAL_GLOB_DEFECTS.length} historical glob defect(s) replayed`
    + `${blind.length ? '' : ', all correctly REJECTED'}`);
  for (const b of blind) console.error(`  BLIND  ${b}`);

  for (const b of bad) console.error(`  BAD  ${b}`);
  if (bad.length || blind.length) {
    console.error(`\n# FAIL: ${bad.length} registry problem(s), ${blind.length} control(s) the guard failed to catch.`);
    process.exit(1);
  }
  console.log('# ok: every mutation pinned to exactly one site; every glob covers its derived suites; every historical defect still caught.');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verifyRegistry) return verifyRegistry();
  if (args.help || (!args.contract && !args.list)) {
    console.log('usage: node scripts/wp-mutation-harness.mjs --contract <Name> | --module <Name> [--list] [--only M1,M2] | --verify-registry');
    console.log('registered contracts:', Object.keys(MUTATION_SETS).join(', ') || '(none)');
    process.exit(args.help ? 0 : 1);
  }

  const set = MUTATION_SETS[args.contract];
  if (!set) {
    console.error(`no mutation set registered for "${args.contract}".`);
    console.error('registered:', Object.keys(MUTATION_SETS).join(', ') || '(none)');
    process.exit(1);
  }

  let mutations = set.mutations;
  if (args.only) {
    mutations = mutations.filter((m) => args.only.includes(m.id));
    const missing = args.only.filter((id) => !set.mutations.some((m) => m.id === id));
    if (missing.length) {
      console.error(`unknown mutation id(s): ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  if (args.list) {
    console.log(`#   ${args.contract} — ${set.mutations.length} mutation(s), suite ${set.testMatchPath}`);
    for (const m of set.mutations) console.log(`  ${m.id}  ${m.description}`);
    process.exit(0);
  }

  // (a) PRE-RUN CLEAN CHECK — abort BEFORE mutating if any registered target is not
  // byte-identical to HEAD. This is the load-bearing guard: a harness run must never
  // begin on a dirty target, or a leftover mutation from an interrupted prior run
  // would be adopted as the "original" and silently verify the wrong source.
  const dirty = preRunDirtyTargets();
  if (dirty.length) {
    console.error('FATAL: pre-run clean check failed — a mutation target is not byte-identical to HEAD.');
    console.error('A harness run must never start on a dirty target: a leftover mutation from an');
    console.error('interrupted run would be read as the pristine "original" and verify the WRONG source.');
    console.error('Restore (git checkout --) or commit these before re-running:');
    for (const d of dirty) console.error(`  ${d}`);
    process.exit(2);
  }

  const absSource = path.join(REPO_ROOT, set.sourcePath);
  const original = fs.readFileSync(absSource); // Buffer — the byte-exact restore source
  const originalSha = sha256(original);
  // The committed baseline, captured for the post-run assertion (c). Guard (a) already
  // proved originalSha === headSha; capturing it lets the finish-line check stand on
  // its own and refuse to report success on a tree that does not match HEAD.
  const headBytes = gitHeadBytes(set.sourcePath);
  const headSha = headBytes ? sha256(headBytes) : null;

  // (b) RESTORE-ON-EXIT TRAP. A mutation is applied in place; if we die between
  // applying it and restoring — an operator SIGINT/SIGTERM, or an uncaught throw /
  // rejection — put the pristine bytes back BEFORE exit so no run can ever leave a
  // mutated tracked source behind. The normal completion path also restores, but a
  // trap only the happy path exercises is not a trap: this fires off the abnormal
  // paths and logs exactly what it restored.
  let restored = true;
  const restore = () => {
    fs.writeFileSync(absSource, original);
    restored = true;
    if (sha256(fs.readFileSync(absSource)) !== originalSha) {
      console.error(`FATAL: could not restore ${set.sourcePath} byte-identical.`);
      process.exit(1);
    }
  };
  let trapFiring = false;
  const trap = (label) => (err) => {
    if (trapFiring) return; // one restore, even if two signals race
    trapFiring = true;
    if (!restored) {
      console.error(`\n[trap:${label}] interrupted with ${set.sourcePath} MUTATED on disk — restoring pristine bytes.`);
      restore();
      console.error(`[trap:${label}] restored ${set.sourcePath} byte-identical (sha256 ${originalSha.slice(0, 12)}).`);
    } else {
      console.error(`\n[trap:${label}] interrupted with no mutation applied — nothing to restore.`);
    }
    if (err instanceof Error) console.error(`[trap:${label}] cause: ${err.stack || err.message}`);
    // A caught fault is still a FAILED run: exit non-zero so no caller mistakes it for a pass.
    process.exit(label === 'SIGINT' || label === 'SIGTERM' ? 130 : 1);
  };
  process.on('SIGINT', trap('SIGINT'));
  process.on('SIGTERM', trap('SIGTERM'));
  process.on('uncaughtException', trap('uncaughtException'));
  process.on('unhandledRejection', trap('unhandledRejection'));

  // --selftest: prove the trap actually fires and restores (guard b). Apply the first
  // mutation, then interrupt — a self-SIGTERM or an uncaught throw — and hand control to
  // the trap above. The shell that invoked this then asserts the tree is HEAD-clean and
  // the exit code is non-zero. This is the control: a guard never shown to fire is
  // not evidence.
  if (args.selftest) {
    const m0 = set.mutations[0];
    const pristine = original.toString('utf8');
    const mutated = pristine.replace(m0.find, m0.replace);
    if (mutated === pristine) {
      console.error(`SELFTEST: could not apply ${m0.id} (find string not present) — aborting.`);
      process.exit(1);
    }
    fs.writeFileSync(absSource, mutated, 'utf8');
    restored = false;
    console.log(`# SELFTEST (${args.selftest}) — applied ${m0.id}; ${set.sourcePath} is now MUTATED on disk.`);
    if (args.selftest === 'signal') {
      console.log('# SELFTEST: raising SIGTERM on self — the trap MUST restore before exit.');
      process.kill(process.pid, 'SIGTERM');
      // Keep the event loop alive so the async signal handler runs; fail loudly if it does not.
      setTimeout(() => { console.error('SELFTEST: SIGTERM never fired the trap'); process.exit(3); }, 5000);
      return;
    }
    console.log('# SELFTEST: throwing — the uncaughtException trap MUST restore before exit.');
    throw new Error('SELFTEST synthetic fault (expected) — the trap should restore the source and exit non-zero');
  }

  console.log(`# wp-mutation-harness — ${args.contract}`);
  console.log(`# source ${set.sourcePath}  (sha256 ${originalSha.slice(0, 12)})`);
  console.log(['sdk-vitest', 'native-vitest'].includes(set.runner) ? `# suite  npx vitest run --reporter=json ${set.testMatchPath}` : set.runner === 'jest'
    ? `# suite  npx jest --json ${set.testMatchPath}`
    : `# suite  forge test --root contracts --match-path '${set.testMatchPath}' --json`);
  console.log('');

  // Baseline: the pristine suite MUST pass, or a "killed" verdict is meaningless.
  const runSuite = set.runner === 'native-vitest' ? path => runScopedJestSuite(path, 'native')
    : set.runner === 'sdk-vitest' ? path => runScopedJestSuite(path, true) : set.runner === 'jest' ? runScopedJestSuite : runScopedSuite;
  const base = runSuite(set.testMatchPath);
  if (!base.ran) {
    console.error('FATAL: pristine suite did not compile/run:\n' + base.stderr.split('\n').slice(0, 20).join('\n'));
    process.exit(1);
  }
  if (base.total === 0) {
    console.error(`FATAL: scoped suite matched 0 tests — check testMatchPath '${set.testMatchPath}'.`);
    process.exit(1);
  }
  if (base.failed !== 0) {
    console.error(`FATAL: pristine suite has ${base.failed} failing test(s); cannot distinguish mutation kills.`);
    process.exit(1);
  }
  console.log(`baseline: ${base.passed}/${base.total} passing (clean) — mutation kills are measured against this\n`);

  const results = [];
  for (const m of mutations) {
    const src = original.toString('utf8');
    const occurrences = src.split(m.find).length - 1;
    if (occurrences !== 1) {
      // A stale spec (find not unique) is an ERROR, never a silent pass.
      results.push({ ...m, status: 'ERROR', detail: `find string occurs ${occurrences}x (must be exactly 1)`, failed: 0, total: 0, ms: 0 });
      console.log(`  ${m.id}  ERROR    find string occurs ${occurrences}x (expected 1) — ${m.description}`);
      continue;
    }

    const mutated = src.replace(m.find, m.replace);
    fs.writeFileSync(absSource, mutated, 'utf8');
    restored = false;

    const t0 = process.hrtime.bigint();
    const run = runSuite(set.testMatchPath);
    const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);

    restore(); // byte-identical, sha256-verified inside

    let status;
    let detail;
    if (!run.ran) {
      status = 'ERROR';
      detail = 'mutant did not compile (mutation must break behavior, not syntax): ' + run.stderr.split('\n')[0];
    } else if (run.failed > 0) {
      status = 'KILLED';
      detail = `${run.failed} test(s) failed`;
    } else {
      status = 'SURVIVED';
      detail = `suite still ${run.passed}/${run.total} green — no test caught it`;
    }
    results.push({ ...m, status, detail, failed: run.failed, total: run.total, ms });
    console.log(`  ${m.id}  ${status.padEnd(8)}  ${detail}`);
  }

  // Final belt-and-suspenders restore + verification.
  restore();
  const finalSha = sha256(fs.readFileSync(absSource));

  const killed = results.filter((r) => r.status === 'KILLED').length;
  const survived = results.filter((r) => r.status === 'SURVIVED');
  const errored = results.filter((r) => r.status === 'ERROR');

  // (c) POST-RUN ASSERTION. A run that mutated a tracked source may not report success
  // unless the source is byte-identical to BOTH its pre-run bytes AND the committed HEAD
  // blob — so a dirty tree can never be dressed up as a green run. Folded into the exit
  // status alongside SURVIVED/ERROR.
  const restoredToPreRun = finalSha === originalSha;
  const matchesHead = headSha !== null && finalSha === headSha;

  console.log('');
  console.log(`# summary: ${killed}/${results.length} KILLED, ${survived.length} SURVIVED, ${errored.length} ERROR`);
  console.log(`# source restored byte-identical to pre-run state: ${restoredToPreRun ? 'YES' : 'NO'}  (sha256 ${finalSha.slice(0, 12)})`);
  console.log(`# working tree matches HEAD after run:              ${matchesHead ? 'YES' : 'NO'}`);

  const ok = restoredToPreRun && matchesHead && survived.length === 0 && errored.length === 0;
  if (!ok) {
    if (survived.length) console.log(`# FAIL: surviving mutant(s): ${survived.map((r) => r.id).join(', ')}`);
    if (errored.length) console.log(`# FAIL: errored mutation(s): ${errored.map((r) => r.id).join(', ')}`);
    if (!restoredToPreRun) console.log('# FAIL: source NOT restored byte-identical to pre-run state');
    if (!matchesHead) console.log('# FAIL: source does not match HEAD after run (dirty tree — cannot report success)');
  }
  process.exit(ok ? 0 : 1);
}

main();
