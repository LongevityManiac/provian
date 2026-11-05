/** machine-local, setup-fixed witnesses. No harness or provider catalog. */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import type { OriginArgRule } from './origin-rules';
import type { PeerProcessEntry } from './peer-process';
import { listSessions, readRecordsAfter, normalizeEpoch, type RecordTableSpec } from './plugins/transcript/record-store';

export type ProgramLane = 'transcript' | 'model_proxy' | 'otel';
export interface FieldTest { path: string; equals?: string | number | boolean; exists?: boolean; prefix?: string }
export interface RecordRule {
  kind: 'tool_call' | 'tool_result' | 'user_prompt' | 'turn_end' | 'model_response' | 'ignore';
  at?: string;
  recordWhere?: FieldTest[];
  where?: FieldTest[];
  unless?: FieldTest[];
  id?: string;
  name?: string;
  input?: string;
  text?: string;
  error?: string;
}
export interface SessionDescription {
  root: string;
  maxDepth: number;
  fileNames?: string[];
  suffix?: string;
  sqlite?: RecordTableSpec;
  timestamp?: string;
  /** Stable harness response identity; shared only within this program's session store. */
  responseId?: string;
  /** Complete response records by default; false for stores that append response fragments. */
  atomicResponses?: boolean;
  /** Every response component must match a tool or an explicit ignored-component rule. */
  responseParts?: string;
  rules: RecordRule[];
  origins?: OriginArgRule[];
}
export interface ProgramWitness {
  program: string;
  processNames: string[];
  /** The path of a runtime's script/package, matched as an exact directory segment. */
  scriptPaths?: string[];
  lane: ProgramLane;
  session?: SessionDescription;
  setupAtMs: number;
  baseline: Record<string, number>;
  readyAtMs?: number;
}
export interface ObservedRecord { source: string; ordinal: number; record: unknown; atMs: number | null }
export const programWitnessPath = (home = os.homedir()): string => path.join(home, '.provian', 'program-witnesses.json');
export function canonicalRecord(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalRecord).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonicalRecord((v as Record<string,unknown>)[k])).join(',') + '}';
}
export const hash = (v: string): string => createHash('sha256').update(v).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Dot paths, with * to walk an array. No expressions, code, or prototype access. */
export function valuesAt(v: unknown, key = ''): unknown[] {
  if (!key) return [v];
  let values = [v];
  for (const part of key.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) return [];
    values = values.flatMap(x => part === '*' ? (Array.isArray(x) ? x : []) : object(x) && Object.prototype.hasOwnProperty.call(x, part) ? [x[part]] : []);
  }
  return values;
}
export function matches(v: unknown, tests: readonly FieldTest[] = []): boolean {
  return tests.every(t => (t.exists === false && valuesAt(v,t.path).length === 0) || valuesAt(v, t.path).some(x =>
    (t.exists === undefined || (x !== null && x !== undefined) === t.exists)
    && (t.equals === undefined || x === t.equals)
    && (t.prefix === undefined || typeof x === 'string' && x.startsWith(t.prefix))));
}
export function describedEvents(record: unknown, spec: SessionDescription): Array<{ rule: RecordRule; value: unknown }> {
  return spec.rules.flatMap(rule => matches(record, rule.recordWhere)
    ? valuesAt(record, rule.at).filter(v => matches(v, rule.where) && !(rule.unless?.length && matches(v, rule.unless))).map(value => ({ rule, value })) : []);
}
/** A moved component may leave the old container present but empty. Check the
 * locally described tool shape outside its mapped path before advancing a row.
 * Recognized payloads are opaque here: tool arguments and ignored/user data are
 * never interpreted as additional calls. This detects a broken description; it
 * does not capture or mint the unmapped component. */
export function hasUnmappedToolComponent(record: unknown, spec: SessionDescription, events = describedEvents(record, spec)): boolean {
  const opaque = new Set(events.filter(e => ['tool_call','tool_result','user_prompt','ignore'].includes(e.rule.kind)).map(e => e.value));
  const rules = spec.rules.filter(r => r.kind === 'tool_call');
  const pending: unknown[] = [record];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || opaque.has(value)) continue;
    if (value !== record && object(value) && rules.some(rule => {
      const name = valuesAt(value, rule.name)[0];
      const identity = rule.id ? valuesAt(value, rule.id)[0] : undefined;
      const input = rule.input ? valuesAt(value, rule.input)[0] : undefined;
      return typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(name)
        && ((!rule.id && !rule.input) || typeof identity === 'string' || typeof identity === 'number' || input !== undefined)
        && matches(value, rule.where) && !(rule.unless?.length && matches(value, rule.unless));
    })) return true;
    for (const child of Array.isArray(value) ? value : Object.values(value)) pending.push(child);
  }
  return false;
}
/**
 * Why the observer cannot place a session record under this description (null = it can). The ONE
 * check the transcript lane applies to every record before it advances, and that `configureProgram`
 * applies to every record of the real store before it accepts a description, so a description
 * configure accepts is one the lane can read (configure accepted a Codex CLI description the
 * lane then refused on every record, and the agent re-described in a loop with no way to learn why).
 */
export type RecordPlacementProblem = 'matches_no_rule' | 'response_parts_missing' | 'response_part_matches_no_rule' | 'unmapped_tool_component' | 'tool_name_unparsed' | 'timestamp_unparsed' | 'response_is_tool_call' | 'response_id_missing';
/** Atomic responses must contain their calls, rather than naming a call as the response. */
function containsComponent(container: unknown, component: unknown, inParts = false): boolean {
  if (!container || typeof container !== 'object' || container === component) return false;
  const inArray = inParts || Array.isArray(container);
  return Object.values(container).some(child => child === component ? inArray : containsComponent(child, component, inArray));
}
export function recordPlacementProblem(record: unknown, spec: SessionDescription, atMs: number | null, events = describedEvents(record, spec)): RecordPlacementProblem | null {
  if (!events.length) return 'matches_no_rule';
  const componentRoot = spec.responseParts?.replace(/\.\*$/, '');
  if (componentRoot && events.some(e => e.rule.kind === 'model_response') && !valuesAt(record, componentRoot).length) return 'response_parts_missing';
  const parts = spec.responseParts ? valuesAt(record, spec.responseParts) : [];
  if (parts.some(part => !events.some(e => e.value === part))) return 'response_part_matches_no_rule';
  // A known response wrapper must not hide a newly named, unmapped tool component.
  if (hasUnmappedToolComponent(record, spec, events)) return 'unmapped_tool_component';
  if (events.some(e => e.rule.kind === 'tool_call' && !toolNameParses(valuesAt(e.value, e.rule.name)[0]))) return 'tool_name_unparsed';
  const calls = events.filter(e => e.rule.kind === 'tool_call');
  const boundaries = events.filter(e => e.rule.kind === 'model_response' || e.rule.kind === 'turn_end');
  if (calls.some(call => (spec.atomicResponses !== false
    ? !boundaries.some(e => e.rule.kind === 'model_response' && containsComponent(e.value, call.value))
    : boundaries.some(e => e.rule.kind === 'turn_end' && !containsComponent(e.value, call.value))))) return 'response_is_tool_call';
  if (spec.atomicResponses === false && spec.responseId && (calls.length || events.some(e => e.rule.kind === 'turn_end'))) {
    const id = valuesAt(record, spec.responseId)[0];
    if (!(typeof id === 'string' || typeof id === 'number' && Number.isFinite(id))) return 'response_id_missing';
  }
  if (normalizeEpoch(valuesAt(record, spec.timestamp)[0]) === null && atMs === null) return 'timestamp_unparsed';
  return null;
}
export const toolNameParses = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(name);
const PLACEMENT_HINTS: Record<RecordPlacementProblem, string> = {
  matches_no_rule: 'Every record in the store needs a rule: describe each kind of record that is not a model response, tool call, tool result, user prompt or turn end as kind "ignore".',
  response_parts_missing: 'A record a model_response rule matches has nothing at responseParts.',
  response_part_matches_no_rule: 'Each component responseParts names must itself be matched by a rule whose "at" walks to it (kind "ignore" for components that are not tool calls); leave responseParts out when a record is not split into components.',
  unmapped_tool_component: 'A tool call sits somewhere its tool_call rule does not read; point the rule\'s "at" at it.',
  tool_name_unparsed: 'A tool_call rule\'s name path does not give a tool name (letters, digits, _ . : -).',
  timestamp_unparsed: 'The timestamp path gives no parsable timestamps on this record.',
  response_is_tool_call: 'A tool-call record is not a complete model response: per-call ids would mint parallel calls separately. For separate call records set atomicResponses to false, omit a per-call responseId, and describe the store\'s response-ending record as kind "turn_end". For atomic responses, model_response must name the complete wrapper containing an array of response components with the tool calls.',
  response_id_missing: 'For fragmented responses, responseId must name the same response on every call and its turn_end record. A per-call id cannot do that. Omit responseId to group contiguous calls up to each response-ending record.',
};
/**
 * A record's shape for an error message: its keys, and only the values of type-like fields (type,
 * kind, role, event, subtype), one level down. Never content, arguments or text.
 */
export function recordShape(record: unknown): string {
  if (!object(record)) return record === null ? 'not JSON' : `a ${Array.isArray(record) ? 'list' : typeof record}`;
  const label = (v: Record<string, unknown>, prefix: string): string[] => ['type', 'kind', 'role', 'event', 'subtype']
    .filter(k => typeof v[k] === 'string').map(k => `${prefix}${k}=${JSON.stringify(String(v[k]).slice(0, 40))}`);
  const out = label(record, '');
  for (const [k, v] of Object.entries(record)) if (object(v)) out.push(...label(v, `${k}.`));
  const keys = Object.keys(record).slice(0, 10).join(', ');
  return `${out.length ? out.join(' ') + '; ' : ''}keys: ${keys}`;
}
function mtimeOf(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
/** The transcript lane's held cursor per source of `program` (its local state file), if it has read any. */
function laneCursors(stateFile: string, program: string): Map<string, { cursor: number; checkpoint?: string }> {
  const out = new Map<string, { cursor: number; checkpoint?: string }>();
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { sources?: Record<string, { cursor?: unknown; checkpoint?: unknown }> };
    for (const [key, v] of Object.entries(state.sources ?? {})) {
      if (key.startsWith(program + ':') && typeof v?.cursor === 'number') out.set(key.slice(program.length + 1), { cursor: v.cursor, ...(typeof v.checkpoint === 'string' ? { checkpoint: v.checkpoint } : {}) });
    }
  } catch { /* the lane has not read this store yet */ }
  return out;
}
export function placementError(problem: RecordPlacementProblem, record: unknown, where: string, file: string): string {
  return `description cannot place ${where} of ${path.basename(file)} (${problem}: ${recordShape(record)}). ${PLACEMENT_HINTS[problem]}`;
}
export function sessionFiles(spec: SessionDescription): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < spec.maxDepth) walk(p, depth + 1);
      else if (e.isFile() && (spec.fileNames?.includes(e.name) || spec.suffix && e.name.endsWith(spec.suffix))) out.push(p);
    }
  };
  walk(spec.root, 0);
  return out;
}
export function recordSources(spec: SessionDescription): Array<{ file: string; source: string; sessionId?: string; tip: number }> {
  return sessionFiles(spec).flatMap(file => spec.sqlite
    ? listSessions(file, spec.sqlite).map(s => ({ file, source: hash(file + '\0' + s.sessionId), sessionId: s.sessionId, tip: s.maxSeq }))
    : [{ file, source: hash(file), tip: fs.statSync(file).size }]);
}
export function readSource(spec: SessionDescription, src: ReturnType<typeof recordSources>[number], after: number): { records: ObservedRecord[]; tip: number } {
  if (spec.sqlite) {
    const rows = readRecordsAfter(src.file, spec.sqlite, src.sessionId!, after, 1000);
    return { records: rows.flatMap(r => { try { return [{ source: src.source, ordinal: r.seq, record: JSON.parse(r.json) as unknown, atMs: r.createdAtMs }]; } catch { return [{ source: src.source, ordinal: r.seq, record: null, atMs: r.createdAtMs }]; } }), tip: rows.at(-1)?.seq ?? after };
  }
  // Read complete records, including a single record larger than the read buffer.
  // The buffer bounds each disk read, never the work or record size.
  const fd = fs.openSync(src.file, 'r');
  let offset = after, position = after, tail = Buffer.alloc(0);
  const records: ObservedRecord[] = [];
  try {
    while (position < src.tip) {
      const chunk = Buffer.alloc(Math.min(src.tip-position, 1024*1024));
      const length = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (!length) break;
      position += length; tail = Buffer.concat([tail,chunk.subarray(0,length)]);
      let newline: number;
      while ((newline = tail.indexOf(10)) >= 0) {
        const line = tail.subarray(0,newline); offset += newline+1;
        let record: unknown = null;
        try { record = JSON.parse(line.toString('utf8')) as unknown; } catch { /* format health counts malformed records */ }
        records.push({source:src.source,ordinal:offset,record,atMs:null});
        tail = tail.subarray(newline+1);
      }
    }
  } finally { fs.closeSync(fd); }
  return { records, tip: offset };
}

/** The daemon's checkpoint detects rewrites before interpreting new bytes. */
export function sourceCheckpoint(spec: SessionDescription, src: ReturnType<typeof recordSources>[number], through:number): string {
  if (spec.sqlite) {
    const row=readRecordsAfter(src.file,spec.sqlite,src.sessionId!,through-1,1)[0];
    return hash(String(through)+':'+(row?.seq===through ? row.json : 'missing'));
  }
  const digest=createHash('sha256'),fd=fs.openSync(src.file,'r');
  const st=fs.fstatSync(fd);digest.update(st.dev+':'+st.ino+':');
  try {
    let position=0;
    while(position<through){const b=Buffer.alloc(Math.min(through-position,1024*1024));const n=fs.readSync(fd,b,0,b.length,position);if(!n)break;digest.update(b.subarray(0,n));position+=n;}
  } finally {fs.closeSync(fd);}
  return digest.digest('hex');
}
export function parseProgramDescription(raw: unknown): Omit<ProgramWitness, 'setupAtMs' | 'baseline'> {
  if (!object(raw) || typeof raw.program !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.program)) throw new Error('program must be a simple name');
  if (!Array.isArray(raw.processNames) || !raw.processNames.length || !raw.processNames.every(v => typeof v === 'string' && /^[A-Za-z0-9_.-]+$/.test(v))) throw new Error('describe the program processNames');
  if (!['transcript', 'model_proxy', 'otel'].includes(String(raw.lane))) throw new Error('unknown witness lane');
  const p = raw as unknown as Omit<ProgramWitness, 'setupAtMs' | 'baseline'>;
  if (p.scriptPaths && (!Array.isArray(p.scriptPaths) || !p.scriptPaths.every(v => typeof v === 'string' && path.isAbsolute(v)))) throw new Error('scriptPaths must be absolute local package/script paths');
  if (p.lane === 'transcript') {
    const s = p.session;
    if (!s || !path.isAbsolute(s.root) || !Number.isInteger(s.maxDepth) || s.maxDepth < 0 || s.maxDepth > 20 || !Array.isArray(s.rules)) throw new Error('describe the session root, depth and record rules');
    if (s.fileNames && (!Array.isArray(s.fileNames) || s.fileNames.some(n => typeof n !== 'string' || path.basename(n) !== n))) throw new Error('filenames must be plain local names');
    if (s.suffix !== undefined && (typeof s.suffix !== 'string' || !s.suffix || s.suffix.includes('/'))) throw new Error('invalid filename suffix');
    if (!s.timestamp && !s.sqlite?.createdAtColumn) throw new Error('describe the record timestamp or SQLite creation time');
    if (s.timestamp !== undefined && typeof s.timestamp !== 'string') throw new Error('timestamp must be a field path');
    if (!s.fileNames?.length && !s.suffix) throw new Error('describe the session filenames');
    if (s.sqlite && !Object.entries(s.sqlite).every(([,v]) => v === undefined || typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v))) throw new Error('invalid SQLite columns');
    if (!s.rules.some(r => r.kind === 'tool_call' && r.name)) throw new Error('describe model responses with tool calls');
    // Fragments are grouped by responseId when the store gives one, otherwise in order up to the
    // completion rule (a Codex CLI rollout's tool-call records carry no response id,); a
    // missing completion can only merge two responses into one PE, never split one into two.
    if (s.atomicResponses === false && !s.rules.some(r => r.kind === 'turn_end')) throw new Error('fragmented responses require a completion rule (kind turn_end)');
    for (const field of ['responseId','responseParts'] as const) if (s[field] !== undefined && typeof s[field] !== 'string') throw new Error('response paths must be strings');
    if (s.origins && (!Array.isArray(s.origins) || s.origins.some(r => !object(r) || !Array.isArray(r.tools) || !r.tools.every(t => typeof t === 'string') || typeof r.key !== 'string' || !['file','url','package','repo','host'].includes(r.class)))) throw new Error('invalid privacy class for tool arguments');
    for (const r of s.rules) {
      if (!object(r)) throw new Error('invalid record rule');
      if (!['tool_call','tool_result','user_prompt','turn_end','model_response','ignore'].includes(r.kind)) throw new Error('invalid record kind');
      for (const k of ['at','id','name','input','text','error'] as const) if (r[k] !== undefined && typeof r[k] !== 'string') throw new Error('record paths must be strings');
      for (const tests of [r.recordWhere,r.where,r.unless]) if (tests && (!Array.isArray(tests) || tests.some(t => !object(t) || typeof t.path !== 'string' || (t.equals !== undefined && !['string','number','boolean'].includes(typeof t.equals)) || (t.prefix !== undefined && typeof t.prefix !== 'string') || (t.exists !== undefined && typeof t.exists !== 'boolean')))) throw new Error('invalid record predicates');
    }
  } else if (p.session) throw new Error('a program with a session store must use transcript');
  return p;
}
export function readPrograms(file = programWitnessPath()): ProgramWitness[] {
  if (!fs.existsSync(file)) return [];
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('invalid program witness registry');
  return raw.map(v => { const p = parseProgramDescription(v); if (!object(v) || !Number.isSafeInteger(v.setupAtMs) || !object(v.baseline) || !Object.values(v.baseline).every(n => Number.isSafeInteger(n) && Number(n) >= 0)) throw new Error('invalid program witness setup'); return { ...p, setupAtMs: v.setupAtMs as number, baseline: v.baseline as Record<string, number>, ...(typeof v.readyAtMs === 'number' ? {readyAtMs:v.readyAtMs} : {}) }; });
}
export function writeLocal(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
/** Validation is read-only against actual records; it cannot accept a declared turn or PE. */
export function configureProgram(raw: unknown, file = programWitnessPath(), now = Date.now()): { program: ProgramWitness; records: number; calls: number; turns: number } {
  const p = parseProgramDescription(raw); const programs = readPrograms(file);
  // One source/process can belong to only one program, including symlink aliases.
  const realRoot = (root: string): string => fs.realpathSync(root);
  for (const other of programs.filter(x => x.program !== p.program)) {
    if (p.session && other.session) {
      const a=realRoot(p.session.root), b=realRoot(other.session.root);
      if (a===b || a.startsWith(b+path.sep) || b.startsWith(a+path.sep)) throw new Error('session store already belongs to another witnessed program');
      const identities = new Set(sessionFiles(other.session).map(f => {const st=fs.statSync(f);return st.dev+':'+st.ino;}));
      if (sessionFiles(p.session).some(f => {const st=fs.statSync(f);return identities.has(st.dev+':'+st.ino);})) throw new Error('session file already belongs to another witnessed program');
    }
    if (p.processNames.some(n=>other.processNames.includes(n)) && (!p.scriptPaths?.length || !other.scriptPaths?.length || p.scriptPaths.some(a=>other.scriptPaths!.some(b=>a===b || a.startsWith(b+path.sep) || b.startsWith(a+path.sep))))) throw new Error('process identity already belongs to another witnessed program');
  }
  const previous = programs.find(x => x.program === p.program);
  if (previous && previous.lane !== p.lane) throw new Error('program witness is fixed at setup; model or sign-in changes cannot change it');
  let records = 0, calls = 0, turns = 0; const baseline: Record<string, number> = {};
  if (p.session) {
    // Every record the lane will read must be placed. A source the lane already reads resumes at its
    // held cursor, or at the previous description's baseline when it has read nothing yet (a
    // re-description after a format change: the records from there on). When the lane will read
    // nothing that exists yet (a first description reads from each source's tip, or every source is
    // caught up), the session holding the latest record is the evidence of the current format.
    const spec = p.session;
    const held = laneCursors(path.join(path.dirname(file), 'described-response-state.json'), p.program);
    // One source in memory at a time: the first pass keeps only where each source resumes and its
    // latest record time; the second re-reads each source to check and count it.
    const rowsOf = (src: ReturnType<typeof recordSources>[number], from: number | undefined): ObservedRecord[] => {
      const sample = spec.sqlite ? Math.max(0, src.tip - 1000) : 0;
      const read = readSource(spec, src, from === undefined ? sample : Math.min(from, sample));
      while (spec.sqlite && read.tip < src.tip) { const next = readSource(spec, src, read.tip); if (next.tip <= read.tip) break; read.records.push(...next.records); read.tip = next.tip; }
      return read.records;
    };
    const laneReads = (from: number | undefined, ordinal: number): boolean => from !== undefined && ordinal > from;
    const reads = recordSources(spec).map(src => {
      baseline[src.source] = src.tip;
      // Where the lane resumes, as the lane decides it: a truncated or rewritten source replays from 0.
      const kept = held.get(src.source);
      let from = kept?.cursor ?? previous?.baseline[src.source];
      if (from !== undefined && (src.tip < from || (kept?.checkpoint && sourceCheckpoint(spec, src, from) !== kept.checkpoint))) from = 0;
      // The bounded sample comes from the real store, never a record supplied in the description; it
      // reaches back to wherever the lane resumes, and on through the tip as the lane reads it.
      let latest = -Infinity, rows = 0, laneRead = false;
      for (const row of rowsOf(src, from)) {
        rows++;
        if (laneReads(from, row.ordinal)) laneRead = true;
        latest = Math.max(latest, normalizeEpoch(valuesAt(row.record, spec.timestamp)[0]) ?? row.atMs ?? -Infinity);
      }
      return { src, from, rows, latest, laneRead };
    });
    const anyLaneRead = reads.some(r => r.laneRead);
    // A source with no records yet (a session just opened) is never the evidence.
    const newest = reads.filter(r => r.rows > 0).reduce<typeof reads[number] | null>((a, b) => (a === null || b.latest > a.latest || (b.latest === a.latest && mtimeOf(b.src.file) > mtimeOf(a.src.file)) ? b : a), null);
    for (const r of reads) {
      let hasCall = false;
      let n = 0;
      for (const row of rowsOf(r.src, r.from)) {
        records++; n++;
        const events = describedEvents(row.record, spec);
        // The lane's own check, over the records it will read: what configure accepts, the lane can read.
        const checked = anyLaneRead ? laneReads(r.from, row.ordinal) : r === newest;
        const problem = checked ? recordPlacementProblem(row.record, spec, row.atMs, events) : null;
        if (problem) throw new Error(placementError(problem, row.record, spec.sqlite ? `record at seq ${row.ordinal}` : `record ${n}`, r.src.file));
        for (const event of events) {
          if (event.rule.kind === 'user_prompt') hasCall = false;
          if (event.rule.kind === 'tool_call' && toolNameParses(valuesAt(event.value, event.rule.name)[0])) { calls++; hasCall = true; }
          if (event.rule.kind === 'turn_end' && hasCall) { turns++; hasCall = false; }
        }
        if (hasCall && spec.atomicResponses !== false) { turns++; hasCall = false; }
      }
    }
    if (records === 0 || calls === 0 || turns === 0) throw new Error(`description did not parse real tool turns (records=${records}, calls=${calls}, ends=${turns})`);
  }
  const program: ProgramWitness = { ...p, setupAtMs: previous?.setupAtMs ?? now, baseline: { ...baseline, ...(previous?.baseline ?? {}) }, ...(previous?.readyAtMs ? { readyAtMs: previous.readyAtMs } : {}) };
  // A refresh keeps the original admission watermark and lane. Nothing is uploaded.
  writeLocal(file, [...programs.filter(x => x.program !== p.program), program]);
  return { program, records, calls, turns };
}
export class ProgramWitnessRegistry {
  constructor(private readonly file = programWitnessPath()) {}
  programs(): ProgramWitness[] { return readPrograms(this.file); }
  lane(program: string | null): ProgramLane | null { return this.programs().find(p => p.program === program)?.lane ?? null; }
  allows(program: string | null, lane: ProgramLane): boolean { return program !== null && this.lane(program) === lane; }
  captured(program: string, lane: ProgramLane, atMs: number): void {
    const ps=this.programs(); const p=ps.find(x=>x.program===program);
    if (!p || p.lane!==lane || p.readyAtMs) return;
    p.readyAtMs=atMs; writeLocal(this.file,ps);
  }
  identify(p: PeerProcessEntry): string | null {
    const argv = p.argv ?? commandArguments(p.args);
    const executable=p.exe ?? argv[0] ?? '';
    const names=[path.basename(executable).replace(/\.exe$/i,''),path.basename(argv[0] ?? '').replace(/\.exe$/i,'')];
    // Only the executable or the runtime's script operand names a program.
    // Prompt text and later option arguments can never impersonate that script.
    let script: string | undefined;
    if (/^(node|nodejs|python[0-9.]*)$/.test(names[0] ?? '')) {
      const withValue=new Set(['--require','-r','--import','--loader','--experimental-loader','--conditions','-c']);
      for(let i=1;i<argv.length;i++){
        const arg=argv[i];
        if(['-e','--eval','-p','--print','-m'].includes(arg)) break;
        if(withValue.has(arg)){i++;continue;}
        if(arg==='--'){script=argv[i+1];break;}
        if(arg.startsWith('-'))continue;
        script=arg;break;
      }
    }
    const candidates=[executable,...(script ? [script] : [])];
    const matches=this.programs().filter(x=>x.processNames.some(n=>names.includes(n)) && (!x.scriptPaths?.length || x.scriptPaths.some(root=>candidates.some(candidate=>candidate===root || candidate.startsWith(root+path.sep)))));
    return matches.length === 1 ? matches[0].program : null;
  }
}

/** Fallback for platforms that expose a command line; Linux supplies argv directly. */
export function commandArguments(command: string): string[] {
  const result:string[]=[];let word='',quote='',escaped=false,started=false;
  for(const c of command){
    if(escaped){word+=c;escaped=false;started=true;continue;}
    if(c==='\\' && quote!=="'"){escaped=true;started=true;continue;}
    if(quote){if(c===quote)quote='';else word+=c;started=true;continue;}
    if(c==='"' || c==="'"){quote=c;started=true;continue;}
    if(/\s/.test(c)){if(started){result.push(word);word='';started=false;}}else{word+=c;started=true;}
  }
  if(quote || escaped)return []; // Ambiguous OS text cannot name a program.
  if(started)result.push(word);return result;
}
