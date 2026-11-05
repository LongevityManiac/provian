import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { PROPOSED_EVIDENCE_CLASS_BASES_BPS } from '../src/core/pvt/policy/evidence-class';
import {
  PROPOSED_ACTION_POLICY_MANIFEST,
  PROPOSED_ACTION_POLICY_ENTRIES,
  VALIDATED_LAUNCH_EMITTER_ADDITIONS,
  RETIRED_MATRIX_ACTION_TYPES,
} from '../src/core/pvt/policy/proposed-action-policy';

const repoRoot = path.resolve(__dirname, '../..');
const outputPath = path.join(
  repoRoot,
  'docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json',
);

function quotedIdentifiers(source: string): string[] {
  return [...source.matchAll(/['"]([A-Za-z][A-Za-z0-9_.:@-]*)['"]/g)]
    .map((match) => match[1]);
}

/** Parse the complete ActionType alias through the TypeScript AST. */
export function parseActionTypeUnion(source: string): Set<string> {
  const file = ts.createSourceFile('types.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const alias = file.statements.find((statement): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ActionType');
  if (!alias) throw new Error('ActionType type alias missing');
  const values = new Set<string>();
  const visit = (node: ts.TypeNode): void => {
    if (ts.isUnionTypeNode(node)) {
      for (const member of node.types) visit(member);
      return;
    }
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
      values.add(node.literal.text);
      return;
    }
    throw new Error(`ActionType contains unsupported non-string member: ${node.getText(file)}`);
  };
  visit(alias.type);
  if (values.size === 0) throw new Error('ActionType has no string identifiers');
  return values;
}

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`matrix source marker missing: ${start}`);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`matrix source end marker missing: ${end}`);
  return source.slice(from, to + end.length);
}

function readMaintainedCatalogs(): {
  mobile: Set<string>;
  conformance: Set<string>;
  cutLine: Set<string>;
} {
  const mobileSource = fs.readFileSync(
    path.join(repoRoot, 'src/core/provenance/types.ts'),
    'utf8',
  );
  const conformanceSource = fs.readFileSync(
    path.join(repoRoot, 'provian-backend/src/routes/conformance.ts'),
    'utf8',
  );
  const cutLine = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'provian-backend/src/core/pvt/policy/pe-type-catalog.cut-line.json'),
    'utf8',
  )) as { entries: { action_type: string }[] };
  return {
    mobile: parseActionTypeUnion(mobileSource),
    conformance: new Set(quotedIdentifiers(sliceBetween(
      conformanceSource,
      'export const CATALOG_ACTION_TYPES',
      '];',
    ))),
    cutLine: new Set(cutLine.entries.map((entry) => entry.action_type)),
  };
}

function walkEmitterSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Test-fixture directories are not PE emitters: a quoted action type in a
      // helper or mock is test scaffolding, and letting it into the matrix makes
      // the audit surface stale on every fixture edit.
      if (!['node_modules', 'dist', 'coverage'].includes(entry.name)
        && !/^__(?:test-helpers|tests|mocks|fixtures)__$/.test(entry.name)) {
        files.push(...walkEmitterSources(full));
      }
    } else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)
      && !/\.(?:test|spec|test-support)\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Read a source file for the emitter scan, tolerating the ONE benign race this
 * scanner hits: a file listed by `readdirSync` but unlinked before we
 * `readFileSync` it. That happens when a concurrent test mutates a tree we walk
 * `cutover-wp12r2.test.ts` plants and unlinks `__scan_probe_*.ts` under
 * `provian-backend/src`, one of our roots. A file that vanished mid-scan is not a
 * stable emitter, so we skip it (return null). Any other error is real and is
 * re-thrown. THIS is the "policy-matrix-generator" flake: a readdir→readFile
 * TOCTOU that went RED only in a concurrent full jest pass and green on rerun.
 * Exported for a deterministic negative control (ENOENT → null; e.g. EISDIR → throw).
 */
export function readEmitterSource(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function discoverStaticEmitters(
  roots: string[] = [
    path.join(repoRoot, 'src'),
    path.join(repoRoot, 'provian-backend/src'),
    path.join(repoRoot, 'provian-agent-sdk/src'),
    path.join(repoRoot, 'provian-cli/src'),
  ],
  // Injectable so the vanished-file race is reproducible deterministically in a
  // unit test (a reader that returns null for one file) without a real unlink race.
  readFile: (file: string) => string | null = readEmitterSource,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const patterns = [
    /\bactionType\s*:\s*['"]([A-Za-z][A-Za-z0-9_.:@-]*)['"]/g,
    /\baction_type\s*:\s*['"]([A-Za-z][A-Za-z0-9_.:@-]*)['"]/g,
  ];
  for (const file of roots.filter(fs.existsSync).flatMap(walkEmitterSources)) {
    const relative = path.relative(repoRoot, file);
    if (relative.includes('/core/pvt/policy/')
      || relative.endsWith('/routes/conformance.ts')
      || relative.endsWith('/core/provenance/types.ts')
      // These SDK files construct relay authorization requests. Their
      // `actionType` values are request classifiers, not PE action emitters.
      || relative === 'provian-agent-sdk/src/interceptor.ts'
      || relative === 'provian-agent-sdk/src/types.ts') continue;
    const source = readFile(file);
    if (source === null) continue; // vanished between readdir and read — not a stable emitter
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const locations = result.get(match[1]) ?? [];
        if (!locations.includes(relative)) locations.push(relative);
        result.set(match[1], locations.sort());
      }
    }
  }
  return result;
}

/** Preserve the signed matrix's three historical emitter references without shipping retired code.
 * The full matrix and inventory are independently pinned; every live emitter is still scanned.
 */
export function withPinnedRetiredEmitters(
  live: ReadonlyMap<string, readonly string[]>,
  inventoryBytes: Buffer = fs.readFileSync(path.join(repoRoot, 'config/integrity/retired-emitter-pins.json')),
  matrixBytes: Buffer = fs.readFileSync(outputPath),
  sourceExists: (file: string) => boolean = (file) => fs.existsSync(path.join(repoRoot, file)),
): Map<string, string[]> {
  const hash = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
  // the signed-matrix-bytes pin moved with the `static_emitter_files`-only catch-up that
  // records the process lane's emitter (ProcessLanePlugin.ts) on the agent_tool_orchestration row.
  // the matrix declares unknown_action_admission as the re-signed
  // template does (record_only_until_signed_row); no row moved.
  if (hash(matrixBytes) !== 'acdd8f592c75ac2b427c0dac87053f12be41fd4646fd84a22c5c13ac9ebd12a7') {
    throw new Error('Signed matrix bytes changed');
  }
  if (hash(inventoryBytes) !== 'a44e2699bef011362cb2ff526658013b7ac51f7133016b06c23a4d2c5b73f467') {
    throw new Error('Retired emitter inventory changed');
  }
  const inventory = JSON.parse(inventoryBytes.toString('utf8')) as {
    pairs: Array<{action_type: string; file: string}>;
  };
  const result = new Map([...live].map(([action, files]) => [action, [...files]]));
  for (const pair of inventory.pairs) {
    if (sourceExists(pair.file)) throw new Error(`Retired emitter source restored: ${pair.file}`);
    if ([...live.values()].some((files) => files.includes(pair.file))) {
      throw new Error(`Retired emitter found in live scan: ${pair.file}`);
    }
    const files = result.get(pair.action_type) ?? [];
    result.set(pair.action_type, [...new Set([...files, pair.file])].sort());
  }
  return result;
}

export function missingRequiredPolicyIdentifiers(
  required: ReadonlySet<string>,
  policyEntries: ReadonlySet<string>,
): string[] {
  return [...required].filter((action) => !policyEntries.has(action)).sort();
}

/**
 * item-2 STOP guard. A retired matrix action type deliberately has NO
 * policy row, so a retirement must never silently mask a LIVE emitter: if a
 * property-literal emitter reappears for one of these types, that contradicts
 * "retired" and this throws.
 *
 * extracted as a pure function taking the `emitters` map as a PARAMETER
 * precisely so the violating case is CONSTRUCTIBLE in-suite (a retired type
 * present in the map). The production call site passes the real
 * `discoverStaticEmitters()` result; `policy-matrix-generator.test.ts` passes a
 * hand-built violating map to observe the throw branch RED. Without the widened
 * input the throw is an unreachable branch — the exact defect shape names.
 */
export function assertRetiredTypesHaveNoLiveEmitter(
  retired: readonly string[],
  emitters: ReadonlyMap<string, readonly string[]>,
): void {
  for (const type of retired) {
    const locations = emitters.get(type);
    if (locations !== undefined) {
      throw new Error(
        `Retired action type has a live emitter (contradicts "retired"): ${type} in ${locations.join(', ')}`,
      );
    }
  }
}

export function collectRequiredPolicyIdentifiers(): Set<string> {
  const catalogs = readMaintainedCatalogs();
  const liveEmitters = discoverStaticEmitters();
  const emitters = withPinnedRetiredEmitters(liveEmitters);
  // a retired matrix action type deliberately has NO policy row. It may
  // still appear in the frozen atomic accounting cut-line snapshot (a historical capture, never
  // falsified), so subtract the retirement set from `required` to keep the
  // emitter→row guard green after the row is deleted. But a retirement must never
  // silently mask a LIVE emitter (the item-2 STOP) — asserted here, with a
  // reachable throw branch proven by an in-suite RED control.
  assertRetiredTypesHaveNoLiveEmitter(RETIRED_MATRIX_ACTION_TYPES, liveEmitters);
  const required = new Set<string>([
    ...catalogs.mobile,
    ...catalogs.conformance,
    ...catalogs.cutLine,
    ...VALIDATED_LAUNCH_EMITTER_ADDITIONS,
    ...emitters.keys(),
  ]);
  for (const retired of RETIRED_MATRIX_ACTION_TYPES) required.delete(retired);
  return required;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

export function renderPolicyMatrix(): { rendered: string; rows: number; required: number } {
  const catalogs = readMaintainedCatalogs();
  const liveEmitters = discoverStaticEmitters();
  const emitters = withPinnedRetiredEmitters(liveEmitters);
  const additions = new Set<string>(VALIDATED_LAUNCH_EMITTER_ADDITIONS);
  const entries = new Map(PROPOSED_ACTION_POLICY_ENTRIES.map((entry) => [entry.action_type, entry]));
  const required = collectRequiredPolicyIdentifiers();
  const missing = missingRequiredPolicyIdentifiers(required, new Set(entries.keys()));
  if (missing.length > 0) {
    throw new Error(`PVT action policy is missing maintained/emitted identifiers: ${missing.join(', ')}`);
  }

  const rows = [...entries.values()]
  .sort((a, b) => a.action_type.localeCompare(b.action_type))
  .map((entry) => ({
    ...entry,
    maintained_sources: {
      mobile_action_type_union: catalogs.mobile.has(entry.action_type),
      backend_conformance_catalog: catalogs.conformance.has(entry.action_type),
      firestore_cut_line: catalogs.cutLine.has(entry.action_type),
      validated_emitter_additions: additions.has(entry.action_type),
      static_emitter_files: emitters.get(entry.action_type) ?? [],
    },
  }));
  const body = {
  schema_version: 'pvt-action-policy-matrix/v1',
  policy_version: PROPOSED_ACTION_POLICY_MANIFEST.policy_version,
  // : the six witness-class bases every UNNAMED type prices from; the rows below
  // are named OVERRIDES. Pinned here so the signed matrix carries the admission rule.
  unknown_action_admission: PROPOSED_ACTION_POLICY_MANIFEST.unknown_action_policy,
  evidence_class_bases_bps: PROPOSED_EVIDENCE_CLASS_BASES_BPS,
  generated_from: [
    'src/core/provenance/types.ts#ActionType',
    'provian-backend/src/routes/conformance.ts#CATALOG_ACTION_TYPES',
    'provian-backend/src/core/pvt/policy/pe-type-catalog.cut-line.json',
    'provian-backend/src/core/pvt/policy/proposed-action-policy.ts#VALIDATED_LAUNCH_EMITTER_ADDITIONS',
    'static actionType/action_type literals under src/, provian-backend/src/, provian-agent-sdk/src/, and provian-cli/src/ (.ts/.tsx/.js/.mjs)',
  ],
  counts: {
    rows: rows.length,
    required_identifiers: required.size,
    mobile: catalogs.mobile.size,
    conformance: catalogs.conformance.size,
    cut_line: catalogs.cutLine.size,
    emitter_additions: additions.size,
    statically_discovered_emitters: emitters.size,
  },
  rows,
  };
  const contentWithoutHash = canonical(body);
  const artifact = {
    ...body,
    content_sha256: `sha256:${crypto.createHash('sha256').update(contentWithoutHash).digest('hex')}`,
  };
  return {
    rendered: `${JSON.stringify(artifact, null, 2)}\n`,
    rows: rows.length,
    required: required.size,
  };
}

export function main(argv = process.argv): void {
  const output = renderPolicyMatrix();
  if (argv.includes('--check')) {
    if (!fs.existsSync(outputPath) || !matchesSignedPolicy(
      fs.readFileSync(outputPath, 'utf8'), output.rendered,
    )) {
      throw new Error(`Generated PVT policy matrix is stale: ${path.relative(repoRoot, outputPath)}`);
    }
    process.stdout.write(
      `PVT policy matrix OK (${output.rows} rows, ${output.required} required identifiers)\n`,
    );
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output.rendered);
    process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)} (${output.rows} rows)\n`);
  }
}

/**
 * The signed artifact records the source inventory at signing time. New source
 * locations for an existing type do not change its signed admission or price.
 * renderPolicyMatrix still scans every current emitter and refuses missing or
 * retired types. Its independent byte pin above protects the signed artifact.
 * Compare every policy/catalog field; only historical file locations and the
 * hash derived from those locations may differ.
 */
export function matchesSignedPolicy(signed: string, current: string): boolean {
  const policy = (text: string): unknown => {
    const artifact = JSON.parse(text) as {
      content_sha256?: string;
      rows: Array<{ maintained_sources: { static_emitter_files?: string[] } }>;
    };
    delete artifact.content_sha256;
    for (const row of artifact.rows) delete row.maintained_sources.static_emitter_files;
    return artifact;
  };
  return canonical(policy(signed)) === canonical(policy(current));
}

if (require.main === module) main();
