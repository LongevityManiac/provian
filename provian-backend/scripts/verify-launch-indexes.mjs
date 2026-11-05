#!/usr/bin/env node
/**
 * verify-launch-indexes.mjs — the code→declared index gate, by EXECUTION.
 *
 * WHY THIS EXISTS. `deploy-firestore-indexes.js` reconciles DECLARED →
 * LIVE and reports "in sync" when every declared index is built. That green is
 * true and useless: it never checks whether the index a QUERY actually needs is
 * declared at all, or declared in the right DIRECTION. The escrow/promise/bond
 * 500s all passed declared→live while 500ing in production,
 * because the create-path range queries need (walletId ASC, created_at ASC) and
 * only the list-query DESC sibling was declared.
 *
 * This gate does the ONE thing declared→live can't: it EXECUTES each launch-path
 * query SHAPE against live Firestore and fails hard on FAILED_PRECONDITION ("The
 * query requires an index"). Undeclared, wrong-direction, or unbuilt — all three
 * surface here, because Firestore's real query planner is the judge. A probe
 * value that matches nothing is fine: FAILED_PRECONDITION is raised at planning
 * time regardless of matches.
 *
 * It also executes the shapes that are SUPPOSED to be green (the latest-PE-hash read,
 * participation, the public record path) so a regression that drops one of those
 * indexes fails the gate too.
 *
 * AUTH: reuses the gcloud auth already established in the deploy pipeline (same
 * as deploy-firestore-indexes.js) — `gcloud auth print-access-token`. No
 * firebase-admin, no service-account key. Run it wherever gcloud is authed on
 * the target project.
 *
 * EXIT: 0 = every launch-path shape is served. 1 = at least one shape 500s
 * (prints the collection + the exact index it needs). 2 = harness error.
 *
 * USAGE:
 * FIRESTORE_DATABASE_ID=relay node provian-backend/scripts/verify-launch-indexes.mjs # project=provian-ai, database=relay
 * FIRESTORE_PROJECT=other node.../verify-launch-indexes.mjs
 * FIRESTORE_DATABASE_ID=other node.../verify-launch-indexes.mjs # another named database
 *
 * DATABASE: defaults to `relay`, the relay's live database since the 2026-10-04
 * cutover (the `(default)` database is deleted). The gate first confirms the
 * database EXISTS and exits 2 if it does not: Firestore answers every query
 * against a missing database with 404 NOT_FOUND, never "requires an index", so
 * before this check a run against the deleted `(default)` printed
 * "PASS — all 52" over zero queries actually planned. For the same reason any
 * non-index error response is a harness error (exit 2), never an OK.
 *
 * KEEP IN SYNC: when a route adds a multi-clause Firestore query, add its shape
 * below. This list is the launch-path contract; it is deliberately hand-curated
 * (the same choice launch-smoke made) so a reviewer reads exactly what is gated.
 */
import { execFileSync } from 'node:child_process';

const PROJECT = process.env.FIRESTORE_PROJECT || 'provian-ai';
const DATABASE = (process.env.FIRESTORE_DATABASE_ID || '').trim() || 'relay';
if (DATABASE !== '(default)' && !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(DATABASE)) {
  console.error(`invalid FIRESTORE_DATABASE_ID ${JSON.stringify(DATABASE)}`);
  process.exit(2);
}
const DATABASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${encodeURIComponent(DATABASE)}`;
const BASE = `${DATABASE_URL}/documents`;

// op: 'eq' | 'gte' | 'gt' | 'lt' | 'lte' | 'contains' | 'in'
// v is a probe value; it only has to be the right TYPE — matches are irrelevant.
// orderBy: [[field, 'asc'|'desc'], ...]. count:true uses the aggregation endpoint.
// Each entry names the ROUTE it stands in for, so a failure points at a surface.
const SHAPES = [
  // ---- create-path rate-limit counts : eq + range, implicit ASC ----
  { route: 'POST /v1/escrow/create', c: 'escrows', wh: [['depositor_wallet_id', 'eq', 'x'], ['created_at', 'gte', 0]], count: true },
  { route: 'POST /v1/promises/create', c: 'promises', wh: [['borrower_wallet_id', 'eq', 'x'], ['created_at', 'gte', 0]], count: true },
  { route: 'POST /v1/bonds/post', c: 'bonds', wh: [['agent_wallet_id', 'eq', 'x'], ['created_at', 'gte', 0]], count: true },

  // ---- agent record / profile / reputation (the /a/atlas + earning surfaces) ----
  { route: 'GET /v1/agent/wallet/:id/pe-chain', c: 'provenance_envelopes', wh: [['wallet_id', 'eq', 'x']], orderBy: [['timestamp', 'desc']] },
  // (The `governance_score > 0` count shape was retired: deleted the field and its indexes, and no route issues it.)

  // ---- court ----
  { route: 'POST /v1/court/dispute/general/:id/vote', c: 'general_disputes', wh: [['respondent', 'eq', 'x'], ['resolution', 'eq', 'upheld'], ['resolved_at', 'gte', 0]], count: true },
  { route: 'GET /v1/court/disputes/my (filed_by)', c: 'general_disputes', wh: [['filed_by', 'eq', 'x']], orderBy: [['filed_at', 'desc']] },
  { route: 'GET /v1/court/disputes/my (respondent)', c: 'general_disputes', wh: [['respondent', 'eq', 'x']], orderBy: [['filed_at', 'desc']] },

  // ---- commons ----
  { route: 'POST /v1/commons/vouch', c: 'commons_vouches', wh: [['voucher_wallet_id', 'eq', 'x'], ['vouchee_wallet_id', 'eq', 'y'], ['created_at', 'gt', 0]], count: true },
  { route: 'GET /v1/commons/pe/consent/pending', c: 'commons_publication_consents', wh: [['consenting_wallet_ids', 'contains', 'x'], ['expires_at', 'gt', 0]] },

  // ---- participation summary (multi-filter legs) ----
  { route: 'GET /v1/participation/summary (agent actions)', c: 'pe_history', wh: [['userId', 'eq', 'x'], ['timestamp', 'gte', 0], ['actionType', 'in', ['a', 'b']]], count: true },
  { route: 'GET /v1/participation/summary (corroborated)', c: 'pe_history', wh: [['userId', 'eq', 'x'], ['timestamp', 'gte', 0], ['corroboration_status', 'in', ['on_chain_verified']]], count: true },

  // ---- relay / bonds detail / webhooks ----
  { route: 'GET /v1/relay/agent/:id/requests', c: 'authorization_requests', wh: [['user_id', 'eq', 'x'], ['agent_id', 'eq', 'y']], orderBy: [['created_at', 'desc']] },
  { route: 'GET /v1/relay/agent/:id/requests?status=', c: 'authorization_requests', wh: [['user_id', 'eq', 'x'], ['agent_id', 'eq', 'y'], ['status', 'eq', 'pending']], orderBy: [['created_at', 'desc']] },
  { route: 'GET /v1/bonds/:id (claims)', c: 'bond_claims', wh: [['bond_id', 'eq', 'x']], orderBy: [['created_at', 'desc']] },
  { route: 'GET /v1/bonds/:id (renewals)', c: 'bond_renewals', wh: [['bond_id', 'eq', 'x']], orderBy: [['renewed_at', 'desc']] },
  { route: 'GET /v1/webhooks/subscriptions', c: 'webhook_subscriptions', wh: [['wallet_id', 'eq', 'x']], orderBy: [['created_at', 'desc']] },

  // ---- job board: available (status + each sort, +/- capability) ----
  { route: 'GET /v1/jobs/available?sort=posted', c: 'jobs', wh: [['status', 'eq', 'open']], orderBy: [['created_at', 'desc']] },
  { route: 'GET /v1/jobs/available?sort=budget_desc', c: 'jobs', wh: [['status', 'eq', 'open']], orderBy: [['budget_usdc', 'desc']] },
  { route: 'GET /v1/jobs/available?sort=budget_asc', c: 'jobs', wh: [['status', 'eq', 'open']], orderBy: [['budget_usdc', 'asc']] },
  { route: 'GET /v1/jobs/available?sort=deadline', c: 'jobs', wh: [['status', 'eq', 'open']], orderBy: [['deadline', 'asc']] },
  { route: 'GET /v1/jobs/available?capability&sort=posted', c: 'jobs', wh: [['status', 'eq', 'open'], ['required_capabilities', 'contains', 'x']], orderBy: [['created_at', 'desc']] },
  { route: 'GET /v1/jobs/available?capability&sort=budget_desc', c: 'jobs', wh: [['status', 'eq', 'open'], ['required_capabilities', 'contains', 'x']], orderBy: [['budget_usdc', 'desc']] },
  { route: 'GET /v1/jobs/available?capability&sort=budget_asc', c: 'jobs', wh: [['status', 'eq', 'open'], ['required_capabilities', 'contains', 'x']], orderBy: [['budget_usdc', 'asc']] },
  { route: 'GET /v1/jobs/available?capability&sort=deadline', c: 'jobs', wh: [['status', 'eq', 'open'], ['required_capabilities', 'contains', 'x']], orderBy: [['deadline', 'asc']] },

  // ---- job board: my-jobs (poster|assigned × sort, +/- status) ----
  { route: 'GET /v1/jobs/my-jobs (poster, posted_desc)', c: 'jobs', wh: [['poster_wallet_id', 'eq', 'x']], orderBy: [['created_at', 'desc']] },
  { route: 'GET /v1/jobs/my-jobs (poster, posted_asc)', c: 'jobs', wh: [['poster_wallet_id', 'eq', 'x']], orderBy: [['created_at', 'asc']] },
  { route: 'GET /v1/jobs/my-jobs (poster, updated)', c: 'jobs', wh: [['poster_wallet_id', 'eq', 'x']], orderBy: [['updated_at', 'desc']] },
  { route: 'GET /v1/jobs/my-jobs (assigned, posted_desc)', c: 'jobs', wh: [['assigned_wallet_id', 'eq', 'x']], orderBy: [['created_at', 'desc']] },
  { route: 'GET /v1/jobs/my-jobs (assigned, posted_asc)', c: 'jobs', wh: [['assigned_wallet_id', 'eq', 'x']], orderBy: [['created_at', 'asc']] },
  { route: 'GET /v1/jobs/my-jobs (assigned, updated)', c: 'jobs', wh: [['assigned_wallet_id', 'eq', 'x']], orderBy: [['updated_at', 'desc']] },
  { route: 'GET /v1/jobs/my-jobs (poster+status, posted_desc)', c: 'jobs', wh: [['poster_wallet_id', 'eq', 'x'], ['status', 'eq', 'open']], orderBy: [['created_at', 'desc']] },
  { route: 'GET /v1/jobs/my-jobs (poster+status, posted_asc)', c: 'jobs', wh: [['poster_wallet_id', 'eq', 'x'], ['status', 'eq', 'open']], orderBy: [['created_at', 'asc']] },
  { route: 'GET /v1/jobs/my-jobs (poster+status, updated)', c: 'jobs', wh: [['poster_wallet_id', 'eq', 'x'], ['status', 'eq', 'open']], orderBy: [['updated_at', 'desc']] },
  { route: 'GET /v1/jobs/my-jobs (assigned+status, posted_desc)', c: 'jobs', wh: [['assigned_wallet_id', 'eq', 'x'], ['status', 'eq', 'open']], orderBy: [['created_at', 'desc']] },
  { route: 'GET /v1/jobs/my-jobs (assigned+status, posted_asc)', c: 'jobs', wh: [['assigned_wallet_id', 'eq', 'x'], ['status', 'eq', 'open']], orderBy: [['created_at', 'asc']] },
  { route: 'GET /v1/jobs/my-jobs (assigned+status, updated)', c: 'jobs', wh: [['assigned_wallet_id', 'eq', 'x'], ['status', 'eq', 'open']], orderBy: [['updated_at', 'desc']] },

  // ---- agent directory (2-clause filter combos; bare + single-filter need no composite) ----
  // `browseDirectory` issues only availability (==) + capability (array-contains) since
  // removed governance_score (min_pe_count is a post-filter, no query clause).
  { route: 'GET /v1/agents/directory?capability&availability', c: 'agent_directory', wh: [['availability', 'eq', 'available'], ['capabilities', 'contains', 'x']] },

  // ---- commons registry (alt sort; the default newest sort is the GREEN guard below) ----
  { route: 'GET /v1/commons/registry?sort=pe_count', c: 'commons_profiles', wh: [['status', 'eq', 'active']], orderBy: [['pe_count', 'desc']] },
  { route: 'GET /v1/commons/registry?sort=newest', c: 'commons_profiles', wh: [['status', 'eq', 'active']], orderBy: [['commons_join_date', 'desc']] },

  // ---- earning-type proposals browse (/A1: desc + explicit __name__ ASC tiebreak needs a
  // composite — the free single-field index serves only the __name__ DESC direction) ----
  { route: 'GET /v1/pe/earning-proposals', c: 'pvt_earning_type_proposals', orderBy: [['created_at', 'desc'], ['__name__', 'asc']] },

  // ---- / registry-hold sweep: mint_status alone, ORDERED BY DOCUMENT ID.
  // Rides the free single-field mint_status index — deliberately NOT ordered by
  // timestamp (a mint_status-led (mint_status, timestamp) composite is the
  // write-hotspot shape). If this ever 500s, the sweep query was changed to need a
  // forbidden composite — fix the query, not by declaring that index.
  { route: 'POST /v1/internal/scheduler/registry-hold-resolve (sweep)', c: 'pe_history', wh: [['mint_status', 'eq', 'pending_review']], orderBy: [['__name__', 'asc']] },


  // ---- D0-CRITICAL GREENS (regression guard — these MUST stay served) ----
  { route: 'GREEN latest-PE-hash read (delegation-pe getLatestPEHashForUser)', c: 'provenance_envelopes', wh: [['user_id', 'eq', 'x']], orderBy: [['created_at', 'desc']] },
  { route: 'GREEN participation month-count', c: 'pe_history', wh: [['userId', 'eq', 'x'], ['timestamp', 'gte', 0]], count: true },
  { route: 'GREEN commons registry default (newest; profiles.ts browseRegistry)', c: 'commons_profiles', wh: [['status', 'eq', 'active']], orderBy: [['commons_join_date', 'desc']] },
  { route: 'GREEN commons human-jobs browse', c: 'commons_human_jobs', wh: [['status', 'eq', 'open']], orderBy: [['posted_at', 'desc']] },
  { route: 'GREEN provenance list', c: 'provenance_envelopes', wh: [['user_id', 'eq', 'x']], orderBy: [['created_at', 'desc']] },
  { route: 'GREEN pe-history user timeline', c: 'pe_history', wh: [['userId', 'eq', 'x']], orderBy: [['timestamp', 'desc']] },
];

const OP = { eq: 'EQUAL', gt: 'GREATER_THAN', gte: 'GREATER_THAN_OR_EQUAL', lt: 'LESS_THAN', lte: 'LESS_THAN_OR_EQUAL' };

function val(v) {
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val) } };
  return { stringValue: String(v) };
}

function fieldFilter([field, op, v]) {
  if (op === 'contains') return { fieldFilter: { field: { fieldPath: field }, op: 'ARRAY_CONTAINS', value: val(v) } };
  if (op === 'in') return { fieldFilter: { field: { fieldPath: field }, op: 'IN', value: val(v) } };
  return { fieldFilter: { field: { fieldPath: field }, op: OP[op], value: val(v) } };
}

function structuredQuery(s) {
  const q = { from: [{ collectionId: s.c }] };
  if (s.wh?.length) {
    q.where = s.wh.length === 1 ? s.wh.map(fieldFilter)[0]
      : { compositeFilter: { op: 'AND', filters: s.wh.map(fieldFilter) } };
  }
  if (s.orderBy?.length) q.orderBy = s.orderBy.map(([f, d]) => ({ field: { fieldPath: f }, direction: d === 'desc' ? 'DESCENDING' : 'ASCENDING' }));
  q.limit = 1;
  return q;
}

function run(token, s) {
  const isCount = s.count === true;
  const url = `${BASE}:${isCount ? 'runAggregationQuery' : 'runQuery'}`;
  const body = isCount
    ? { structuredAggregationQuery: { structuredQuery: structuredQuery({ ...s, orderBy: undefined }), aggregations: [{ alias: 'c', count: {} }] } }
    : { structuredQuery: structuredQuery(s) };
  const out = execFileSync('curl', ['-s', url, '-H', `Authorization: Bearer ${token}`, '-H', `x-goog-user-project: ${PROJECT}`, '-H', 'content-type: application/json', '--data', JSON.stringify(body)], { encoding: 'utf8', maxBuffer: 1e8 });
  if (/requires an index/i.test(out)) {
    const link = (out.match(/https:\/\/console\.firebase\.google\.com\/[^"\\]+/) || [])[0] || '';
    return { ok: false, link };
  }
  // A non-index error (missing database, permission, bad field) is a harness
  // problem, not a gate failure — and never a pass: the shape was not planned.
  // Only a TOP-LEVEL `error` counts (runQuery answers an array, so its first
  // element); a returned document that happens to carry a field named `error`
  // sits under `document.fields` and is not one. Unparseable output is an error.
  let parsed;
  try { parsed = JSON.parse(out); } catch { return { ok: false, harness: true, message: `unparseable response: ${out.slice(0, 200)}` }; }
  const top = Array.isArray(parsed) ? parsed[0] : parsed;
  if (top && typeof top === 'object' && top.error) {
    return { ok: false, harness: true, message: String(top.error.message || JSON.stringify(top.error)).slice(0, 300) };
  }
  return { ok: true };
}

function main() {
  let token;
  try {
    token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  } catch (e) {
    console.error('[verify-launch-indexes] could not get a gcloud token — authenticate gcloud on', PROJECT);
    return 2;
  }
  const probe = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', DATABASE_URL, '-H', `Authorization: Bearer ${token}`, '-H', `x-goog-user-project: ${PROJECT}`], { encoding: 'utf8' }).trim();
  if (probe !== '200') {
    console.error(`[verify-launch-indexes] database ${JSON.stringify(DATABASE)} on ${PROJECT} answered HTTP ${probe} — it does not exist or is unreadable. No shape was checked.`);
    return 2;
  }
  console.log(`[verify-launch-indexes] executing ${SHAPES.length} launch-path query shapes against ${PROJECT} database ${DATABASE}...\n`);
  const failures = [];
  const harnessErrors = [];
  for (const s of SHAPES) {
    const r = run(token, s);
    const label = `${s.c}  [${(s.wh || []).map((w) => w[0]).join(',')}${s.orderBy ? ' →' + s.orderBy.map((o) => o[0] + ':' + o[1]).join(',') : ''}${s.count ? ' count' : ''}]`;
    if (r.ok) {
      console.log(`  OK    ${s.route}`);
    } else if (r.harness) {
      harnessErrors.push(s);
      console.log(`  ERR   ${s.route}\n        NOT PLANNED: ${r.message}`);
    } else {
      failures.push({ ...s, link: r.link, label });
      console.log(`  500   ${s.route}\n        NEEDS INDEX: ${label}\n        ${r.link}`);
    }
  }
  console.log('');
  if (harnessErrors.length) {
    console.error(`[verify-launch-indexes] HARNESS ERROR — ${harnessErrors.length}/${SHAPES.length} shape(s) returned a non-index error and were not checked.`);
    if (failures.length) console.error(`  (also ${failures.length} shape(s) require an unbuilt index — see above.)`);
    return 2;
  }
  if (failures.length) {
    console.error(`[verify-launch-indexes] FAIL — ${failures.length}/${SHAPES.length} launch-path shape(s) require an unbuilt index.`);
    console.error('  Declare each in provian-backend/firestore.indexes.json AND create it live (deploy-firestore-indexes.js');
    console.error('  builds declared indexes; use the console link above for the exact fields+direction). Then re-run.');
    return 1;
  }
  console.log(`[verify-launch-indexes] PASS — all ${SHAPES.length} launch-path shapes are served. Safe to flip.`);
  return 0;
}

process.exit(main());
