#!/usr/bin/env node
/**
 * deploy-firestore-indexes.js - Idempotent Firestore composite-index sync.
 *
 * Keeps live Firestore in sync with firestore.indexes.json so the repo is the
 * source of truth and indexes never silently drift (the drift that caused the
 * /v1/pvt/accrual 503 -> "Couldn't load your record" outage: a query's
 * composite index was declared but never deployed).
 *
 * Why gcloud and not `firebase deploy --only firestore:indexes`: the deploy
 * pipeline is already authenticated to gcloud (see deploy-env.sh); firebase CLI
 * needs its own interactive login. This script reuses the gcloud auth that's
 * already there.
 *
 * Behavior:
 *   - ADDITIVE ONLY. Creates declared composite indexes that aren't live yet.
 *     Never deletes anything (a live index absent from the file is left alone).
 *   - Single-field declared indexes are skipped: Firestore auto-manages
 *     single-field indexes, so they need no explicit composite create.
 *   - Steady state (file == live) is a fast no-op.
 *   - Index builds run server-side; `gcloud ... create` returns once the build
 *     is submitted/done. New indexes may take a few minutes to reach READY.
 *
 * Database: every gcloud call targets ONE Firestore database —
 * `--database <id>` (or `--database=<id>`) on the command line, else
 * FIRESTORE_DATABASE_ID, else "(default)". The command-line form lets the
 * indexes / field overrides / TTLs be built on a new named database before
 * the relay is cut over to it:
 *   node deploy-firestore-indexes.js --database relay
 *
 * Exit code is always 0 on a clean run (including no-op). It exits non-zero
 * only on an unexpected failure so the caller can decide whether to warn or
 * abort. deploy-env.sh treats a failure as a loud warning, not a hard stop, so
 * an index hiccup never blocks a code deploy.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT = process.env.FIRESTORE_PROJECT || 'provian-ai';

/** `--database <id>` / `--database=<id>` on the command line, if given. */
function databaseFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--database') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
        console.error('[index-sync] --database needs a value - refusing to run');
        process.exit(1);
      }
      return argv[i + 1];
    }
    if (argv[i].startsWith('--database=')) return argv[i].slice('--database='.length);
  }
  return undefined;
}

// Same id rule as provian-backend/src/firestore-db.ts: "(default)" or 4-63 chars
// of [a-z0-9-], starting with a letter, ending with a letter or digit.
const DATABASE_ID_RE = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
const DATABASE = (databaseFromArgv(process.argv.slice(2)) ?? process.env.FIRESTORE_DATABASE_ID ?? '').trim() || '(default)';
if (DATABASE !== '(default)' && !DATABASE_ID_RE.test(DATABASE)) {
  console.error(`[index-sync] invalid Firestore database id ${JSON.stringify(DATABASE)} - refusing to run`);
  process.exit(1);
}
const INDEX_FILE = path.join(__dirname, 'firestore.indexes.json');

function sig(collectionGroup, fields) {
  return (
    collectionGroup +
    '|' +
    fields
      .filter((f) => f.fieldPath !== '__name__')
      .map((f) => f.fieldPath + ':' + (f.order || f.arrayConfig || ''))
      .join(',')
  );
}

/** Every gcloud firestore call names the database explicitly. */
function gcloud(args) {
  return execFileSync('gcloud', [...args, `--database=${DATABASE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  if (!fs.existsSync(INDEX_FILE)) {
    console.error(`[index-sync] ${INDEX_FILE} not found - skipping`);
    return 0;
  }
  const declaredFile = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  console.log(`[index-sync] project ${PROJECT}, database ${DATABASE}`);
  const declared = (declaredFile.indexes || []).filter(
    (i) => i.queryScope === 'COLLECTION' || !i.queryScope,
  );

  let live;
  try {
    live = JSON.parse(
      gcloud([
        'firestore',
        'indexes',
        'composite',
        'list',
        `--project=${PROJECT}`,
        '--format=json',
      ]),
    );
  } catch (err) {
    console.error('[index-sync] could not list live indexes:', err.message);
    return 1;
  }

  const liveSet = new Set(
    live.map((i) => {
      const cg = i.name.split('/collectionGroups/')[1].split('/')[0];
      return sig(cg, i.fields || []);
    }),
  );

  const missing = declared.filter((i) => !liveSet.has(sig(i.collectionGroup, i.fields)));
  const composite = missing.filter((i) => i.fields.length >= 2);
  const singleSkipped = missing.filter((i) => i.fields.length < 2);

  if (singleSkipped.length) {
    console.log(
      `[index-sync] skipping ${singleSkipped.length} single-field index(es) (Firestore auto-manages these): ` +
        singleSkipped.map((i) => i.collectionGroup + '.' + i.fields[0].fieldPath).join(', '),
    );
  }

  if (composite.length === 0) {
    console.log('[index-sync] in sync - all declared composite indexes are live.');
    return syncFieldOverrides(declaredFile.fieldOverrides || []) > 0 ? 1 : 0;
  }

  console.log(`[index-sync] creating ${composite.length} missing composite index(es)...`);
  let failures = 0;
  for (const idx of composite) {
    const fieldArgs = idx.fields.map((f) =>
      f.arrayConfig
        ? `--field-config=field-path=${f.fieldPath},array-config=contains`
        : `--field-config=field-path=${f.fieldPath},order=${(f.order || 'ASCENDING').toLowerCase()}`,
    );
    const label = sig(idx.collectionGroup, idx.fields);
    try {
      console.log(`[index-sync]   + ${label}`);
      gcloud([
        'firestore',
        'indexes',
        'composite',
        'create',
        `--project=${PROJECT}`,
        `--collection-group=${idx.collectionGroup}`,
        '--query-scope=COLLECTION',
        ...fieldArgs,
        // : do not wait for each build (a fresh database built ONE index per ~5 min
        // serially). Firestore queues the builds server-side; they reach READY on their own.
        '--async',
      ]);
    } catch (err) {
      // "already exists" is benign (race with a concurrent create); anything
      // else is a real failure worth surfacing.
      const msg = String(err.stderr || err.message || '');
      if (/already exists/i.test(msg)) {
        console.log(`[index-sync]     (already exists - ok)`);
      } else {
        failures++;
        console.error(`[index-sync]     FAILED: ${msg.split('\n')[0]}`);
      }
    }
  }

  failures += syncFieldOverrides(declaredFile.fieldOverrides || []);

  if (failures) {
    console.error(`[index-sync] ${failures} index(es) / field override(s) failed.`);
    return 1;
  }
  console.log('[index-sync] done. New indexes build server-side (a few minutes to READY).');
  return 0;
}

/**
 * PE METER (2026-10-03): single-field overrides and TTL policies are declared in the same file.
 * An override with `indexes: []` exempts the field (and its subfields) from single-field
 * indexing — only queried fields are indexed; one with explicit indexes re-enables those on a
 * subfield; `ttl: true` turns on Firestore's TTL deletion for that Timestamp field. Each is read
 * first and written only when live differs, so steady state is a no-op.
 */
function syncFieldOverrides(overrides) {
  let failures = 0;
  for (const o of overrides) {
    const label = `${o.collectionGroup}.${o.fieldPath}`;
    let live = null;
    try {
      live = JSON.parse(gcloud(['firestore', 'indexes', 'fields', 'describe', o.fieldPath,
        `--collection-group=${o.collectionGroup}`, `--project=${PROJECT}`, '--format=json']));
    } catch {
      live = null;
    }
    const liveIndexes = ((live && live.indexConfig && live.indexConfig.indexes) || [])
      .map((i) => `${i.queryScope}:${(i.fields && i.fields[0] && (i.fields[0].order || i.fields[0].arrayConfig)) || ''}`)
      .sort().join(',');
    const usesAncestor = Boolean(live && live.indexConfig && live.indexConfig.usesAncestorConfig);
    const wantIndexes = (o.indexes || [])
      .map((i) => `${i.queryScope || 'COLLECTION'}:${i.order || i.arrayConfig || ''}`)
      .sort().join(',');
    if (Array.isArray(o.indexes) && (usesAncestor || liveIndexes !== wantIndexes)) {
      const args = ['firestore', 'indexes', 'fields', 'update', o.fieldPath,
        `--collection-group=${o.collectionGroup}`, `--project=${PROJECT}`, '--quiet', '--async'];
      if (o.indexes.length === 0) args.push('--disable-indexes');
      else for (const i of o.indexes) args.push(`--index=${i.order ? `order=${i.order.toLowerCase()}` : 'array-config=contains'}`);
      try {
        console.log(`[index-sync]   ~ ${label} indexes=[${wantIndexes}]`);
        gcloud(args);
      } catch (err) {
        failures++;
        console.error(`[index-sync]     FAILED: ${String(err.stderr || err.message || '').split('\n')[0]}`);
      }
    }
    if (o.ttl === true && !(live && live.ttlConfig && /ACTIVE|CREATING/.test(live.ttlConfig.state || ''))) {
      try {
        console.log(`[index-sync]   ~ ${label} ttl`);
        gcloud(['firestore', 'fields', 'ttls', 'update', o.fieldPath, `--collection-group=${o.collectionGroup}`,
          '--enable-ttl', `--project=${PROJECT}`, '--quiet', '--async']);
      } catch (err) {
        failures++;
        console.error(`[index-sync]     FAILED: ${String(err.stderr || err.message || '').split('\n')[0]}`);
      }
    }
  }
  return failures;
}

process.exit(main());
