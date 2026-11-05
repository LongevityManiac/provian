/**
 * Firestore composite-index drift analyzer (residual, 2026-09-22).
 *
 * Why this exists: three Commons queries answered 500 in prod because the composite index
 * each needed was never declared in `firestore.indexes.json` (thread messages, the wants
 * capability browse, and the unfiltered wants browse, which needs an explicit `__name__` tail).
 * Unit tests run against a fake Firestore that needs no indexes, so nothing local noticed.
 *
 * This module reads the Commons modules' source with the TypeScript compiler, derives every
 * query shape each `.collection` chain (and each `let q = …; q = q.where(…)` builder) can
 * produce, works out which of those need a composite index under Firestore's rules, and checks
 * each against the declared index set. It is pure: no Firestore, no network, no runtime import of
 * the modules it reads. The test beside it is the tripwire.
 *
 * Firestore rules modelled (conservatively — a false "missing" is a prompt to look, never a
 * silent pass):
 * - equality (`==`, `in`) and `array-contains` / `array-contains-any` filters form the
 * equality set E; `array-contains*` needs a CONTAINS index entry.
 * - the ordered suffix S is the explicit `orderBy` list, with an inequality field prepended
 * (ascending) when it is not already the first `orderBy`.
 * - no composite is needed when S is empty (single-field indexes merge for equality-only
 * queries), or when E is empty and S has one field.
 * - otherwise the query is served when indexes of the form [some equality fields…, then S]
 * exist whose equality fields together cover E (Firestore's index merging). A trailing
 * `__name__` in S may be omitted from the index when its direction equals the last field's
 * (that is the implicit tie-break); in the other direction it must be declared.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type Direction = 'ASCENDING' | 'DESCENDING';
export interface OrderField { field: string; direction: Direction }
export interface QueryShape {
  collection: string;
  /** Equality fields (`==`, `in`). */
  equality: string[];
  /** `array-contains` / `array-contains-any` fields (need a CONTAINS entry). */
  contains: string[];
  /** Inequality fields (`<`, `<=`, `>`, `>=`, `!=`, `not-in`). */
  inequality: string[];
  orderBy: OrderField[];
  /** `file:line` of the chain head, for the failure message. */
  site: string;
}
export interface DeclaredIndexField { fieldPath: string; order?: Direction; arrayConfig?: 'CONTAINS' }
export interface DeclaredIndex { collectionGroup: string; queryScope?: string; fields: DeclaredIndexField[] }

export interface UnresolvedSite { site: string; reason: string }
export interface ScanResult { shapes: QueryShape[]; unresolved: UnresolvedSite[] }

const EQUALITY_OPS = new Set(['==', 'in']);
const CONTAINS_OPS = new Set(['array-contains', 'array-contains-any']);
const INEQUALITY_OPS = new Set(['<', '<=', '>', '>=', '!=', 'not-in']);
const QUERY_METHODS = new Set(['where', 'orderBy', 'limit', 'limitToLast', 'offset', 'startAfter', 'startAt', 'endAt', 'endBefore', 'select']);

/**
 * Every string value an expression can take, through the type checker: a literal, a `const` /
 * `as const` member, or a union of literals (`'a' | 'b'`, e.g. a sort-field ternary or a
 * literal-union parameter). `null` when any member is not a string literal.
 */
function literalsOf(checker: ts.TypeChecker, expr: ts.Expression): string[] | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  const t = checker.getTypeAtLocation(expr);
  const members = t.isUnion() ? t.types : [t];
  const out: string[] = [];
  for (const m of members) {
    if (!m.isStringLiteral()) return null;
    out.push(m.value);
  }
  return out.length ? out : null;
}

function isDocumentIdCall(expr: ts.Expression): boolean {
  return ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'documentId';
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

interface Clause { method: string; args: readonly ts.Expression[]; node: ts.Node }

/** Peel a method chain `root.m1(…).m2(…)` into its root and its query clauses (in order). */
function peelChain(expr: ts.Expression): { root: ts.Expression; clauses: Clause[] } {
  const clauses: Clause[] = [];
  let e = unwrap(expr);
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && QUERY_METHODS.has(e.expression.name.text)) {
    clauses.unshift({ method: e.expression.name.text, args: e.arguments, node: e });
    e = unwrap(e.expression.expression);
  }
  return { root: e, clauses };
}

function isCollectionCall(e: ts.Expression): e is ts.CallExpression {
  return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'collection' && e.arguments.length === 1;
}

function siteOf(root: string, n: ts.Node): string {
  const sf = n.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
  return `${path.relative(root, sf.fileName)}:${line + 1}`;
}

function enclosingFunctionName(n: ts.Node): string {
  for (let a: ts.Node | undefined = n.parent; a; a = a.parent) {
    if ((ts.isFunctionDeclaration(a) || ts.isMethodDeclaration(a)) && a.name) return a.name.getText();
    if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parent && ts.isVariableDeclaration(a.parent)) return a.parent.name.getText();
  }
  return '<module>';
}

function hasQueryClause(clauses: Clause[]): boolean {
  return clauses.some((c) => c.method === 'where' || c.method === 'orderBy');
}

function cloneShape(s: QueryShape): QueryShape {
  return { ...s, equality: [...s.equality], contains: [...s.contains], inequality: [...s.inequality], orderBy: [...s.orderBy] };
}

/**
 * Fold clauses into every shape they can produce (a literal-union field forks the shapes).
 * Returns a reason string when a clause cannot be resolved statically.
 */
function applyClauses(checker: ts.TypeChecker, shapes: QueryShape[], clauses: Clause[]): QueryShape[] | string {
  let cur = shapes;
  for (const c of clauses) {
    if (c.method !== 'where' && c.method !== 'orderBy') continue;
    const fields = isDocumentIdCall(c.args[0]) ? ['__name__'] : c.args[0] ? literalsOf(checker, c.args[0]) : null;
    if (!fields) return `${c.method}() field is not a string constant: ${c.args[0]?.getText() ?? '<none>'}`;
    const next: QueryShape[] = [];
    if (c.method === 'where') {
      if (c.args.length !== 3) return `where() with ${c.args.length} args (Filter objects are not modelled)`;
      const ops = literalsOf(checker, c.args[1]);
      if (!ops) return `where() operator is not a string constant: ${c.args[1].getText()}`;
      for (const s of cur) for (const field of fields) for (const op of ops) {
        const n = cloneShape(s);
        if (EQUALITY_OPS.has(op)) n.equality.push(field);
        else if (CONTAINS_OPS.has(op)) n.contains.push(field);
        else if (INEQUALITY_OPS.has(op)) n.inequality.push(field);
        else return `unknown where() operator '${op}'`;
        next.push(n);
      }
    } else {
      const dirs = c.args[1] ? literalsOf(checker, c.args[1]) : ['asc'];
      if (!dirs) return `orderBy() direction is not a string constant: ${c.args[1].getText()}`;
      for (const s of cur) for (const field of fields) for (const d of dirs) {
        const n = cloneShape(s);
        n.orderBy.push({ field, direction: d === 'desc' ? 'DESCENDING' : 'ASCENDING' });
        next.push(n);
      }
    }
    cur = next;
  }
  return cur;
}

interface BuilderStep { clauses: Clause[]; node: ts.BinaryExpression; group: ts.Node | null; branch: ts.Node | null }

/**
 * Reassignments `q = q.where(…)…` of builder `q` in its enclosing function. A step inside an if /
 * else-if chain belongs to that chain (its `group`) and to one `branch`; branches of one chain are
 * mutually exclusive, and a chain with no final `else` may take none of them.
 */
function builderSteps(checker: ts.TypeChecker, v: ts.Identifier): BuilderStep[] | string {
  const sym = checker.getSymbolAtLocation(v);
  // The block the builder is declared in bounds both the search and the branch/loop analysis:
  // a loop or `if` wrapping the declaration itself does not make a step conditional.
  let fn: ts.Node | undefined = v.parent;
  while (fn && !ts.isBlock(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
  const steps: BuilderStep[] = [];
  let problem: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && checker.getSymbolAtLocation(n.left) === sym) {
      const { root, clauses } = peelChain(n.right);
      if (!(ts.isIdentifier(root) && checker.getSymbolAtLocation(root) === sym)) {
        problem = `builder '${v.text}' is reassigned from something other than itself`;
      } else {
        // Innermost if-branch containing this step, and the head of its if/else-if chain.
        let branch: ts.Node | null = null;
        let group: ts.Node | null = null;
        for (let a: ts.Node = n; a.parent && a !== fn; a = a.parent) {
          const p = a.parent;
          if (ts.isConditionalExpression(p) || ts.isSwitchStatement(p) || ts.isCaseClause(p) || ts.isIterationStatement(p, false)) {
            problem = `builder '${v.text}' is modified inside a ${ts.SyntaxKind[p.kind]} (not modelled)`;
          }
          if (ts.isIfStatement(p) && (p.thenStatement === a || p.elseStatement === a)) {
            if (branch === null) {
              branch = a;
              let head: ts.IfStatement = p;
              while (head.parent && ts.isIfStatement(head.parent) && head.parent.elseStatement === head) head = head.parent;
              group = head;
            } else {
              problem = `builder '${v.text}' is modified inside nested ifs (not modelled)`;
            }
          }
        }
        steps.push({ clauses, node: n, group, branch });
      }
    }
    ts.forEachChild(n, visit);
  };
  if (fn) ts.forEachChild(fn, visit);
  return problem ?? steps;
}

/** Whether an if/else-if chain ends in a plain `else` (then some branch always runs). */
function chainHasFinalElse(head: ts.IfStatement): boolean {
  let cur: ts.IfStatement = head;
  for (;;) {
    if (!cur.elseStatement) return false;
    if (!ts.isIfStatement(cur.elseStatement)) return true;
    cur = cur.elseStatement;
  }
}

/** Cap on independent optional choices (the shape count multiplies). Past it, split or hand-model. */
export const MAX_BUILDER_CHOICES = 64;

/** Every combination of branch choices for a builder's steps, as the ordered list of steps taken. */
function builderPaths(steps: BuilderStep[]): BuilderStep[][] | string {
  const groups = new Map<ts.Node, Map<ts.Node, BuilderStep[]>>();
  for (const s of steps) {
    if (!s.group || !s.branch) continue;
    const g = groups.get(s.group) ?? new Map<ts.Node, BuilderStep[]>();
    g.set(s.branch, [...(g.get(s.branch) ?? []), s]);
    groups.set(s.group, g);
  }
  const choiceSets: BuilderStep[][][] = [];
  for (const [head, branches] of groups) {
    const options: BuilderStep[][] = [...branches.values()];
    if (!chainHasFinalElse(head as ts.IfStatement) || options.length < countBranches(head as ts.IfStatement)) options.push([]);
    choiceSets.push(options);
  }
  let paths: BuilderStep[][] = [steps.filter((s) => !s.group)];
  for (const options of choiceSets) {
    const next: BuilderStep[][] = [];
    for (const p of paths) for (const o of options) next.push([...p, ...o]);
    paths = next;
    if (paths.length > MAX_BUILDER_CHOICES) return `builder has more than ${MAX_BUILDER_CHOICES} paths`;
  }
  return paths.map((p) => p.slice().sort((a, b) => a.node.getStart() - b.node.getStart()));
}

function countBranches(head: ts.IfStatement): number {
  let n = 1;
  let cur: ts.IfStatement = head;
  while (cur.elseStatement) {
    n++;
    if (!ts.isIfStatement(cur.elseStatement)) break;
    cur = cur.elseStatement;
  }
  return n;
}

/** A hand-modelled site: a query clause the analyzer cannot trace to a collection (e.g. a helper). */
export interface HandModel { file: string; fn: string; shapes: Array<Omit<QueryShape, 'site'>> }

/** Scan TypeScript sources and derive every query shape their `.collection(...)` chains can produce. */
export function scanQueryShapes(files: string[], root: string, handModels: HandModel[] = []): ScanResult {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const shapes: QueryShape[] = [];
  const unresolved: UnresolvedSite[] = [];
  const wanted = new Set(files.map((f) => path.resolve(f)));
  const usedModels = new Set<HandModel>();

  const collectionOf = (call: ts.CallExpression): string | string[] => {
    const names = literalsOf(checker, call.arguments[0]);
    return names ?? `collection name is not a string constant: ${call.arguments[0].getText()}`;
  };

  /** Base (collection, clauses) for a root identifier declared from a collection chain. */
  const baseOfIdentifier = (id: ts.Identifier): { call: ts.CallExpression; clauses: Clause[]; isLet: boolean; decl: ts.VariableDeclaration } | null => {
    const sym = checker.getSymbolAtLocation(id);
    const decl = sym?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isIdentifier(decl.name)) return null;
    const { root, clauses } = peelChain(decl.initializer);
    if (!isCollectionCall(root)) return null;
    const isLet = (decl.parent.flags & ts.NodeFlags.Let) !== 0;
    return { call: root, clauses, isLet, decl };
  };

  const emit = (site: string, collection: string | string[], clauses: Clause[]) => {
    if (typeof collection === 'string') { unresolved.push({ site, reason: collection }); return; }
    const seed = collection.map((c): QueryShape => ({ collection: c, equality: [], contains: [], inequality: [], orderBy: [], site }));
    const out = applyClauses(checker, seed, clauses);
    if (typeof out === 'string') unresolved.push({ site, reason: out });
    else shapes.push(...out);
  };

  const handledBuilders = new Set<ts.VariableDeclaration>();

  for (const sf of program.getSourceFiles()) {
    if (!wanted.has(path.resolve(sf.fileName))) continue;
    const visit = (n: ts.Node) => {
      // Consider each maximal chain once: a call that is not itself the receiver of a further query method.
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && QUERY_METHODS.has(n.expression.name.text)) {
        const parent = n.parent;
        const isInner = parent && ts.isPropertyAccessExpression(parent) && parent.expression === n && QUERY_METHODS.has(parent.name.text);
        if (!isInner) {
          const { root, clauses } = peelChain(n);
          if (!hasQueryClause(clauses)) {
            // pagination only (limit/offset/startAfter): nothing to index
          } else if (isCollectionCall(root)) {
            const assigned = parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && (parent.parent.flags & ts.NodeFlags.Let) !== 0;
            if (!assigned) emit(siteOf(rootPath, root), collectionOf(root), clauses);
            // a `let q = collection(x).where(…)` builder is expanded below, with its steps
          } else if (ts.isIdentifier(root) && baseOfIdentifier(root)) {
            const base = baseOfIdentifier(root)!;
            const isReassignment = parent && ts.isBinaryExpression(parent) && parent.right === n && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
              && ts.isIdentifier(parent.left) && checker.getSymbolAtLocation(parent.left) === checker.getSymbolAtLocation(root);
            if (base.isLet && !isReassignment) {
              unresolved.push({ site: siteOf(rootPath, n), reason: `query clause applied to builder '${root.getText()}' outside a reassignment (not modelled)` });
            }
            if (base.isLet) {
              if (!handledBuilders.has(base.decl)) {
                handledBuilders.add(base.decl);
                const steps = builderSteps(checker, base.decl.name as ts.Identifier);
                const bsite = siteOf(rootPath, base.call);
                if (typeof steps === 'string') unresolved.push({ site: bsite, reason: steps });
                else {
                  const paths = builderPaths(steps);
                  if (typeof paths === 'string') unresolved.push({ site: bsite, reason: paths });
                  else for (const p of paths) emit(bsite, collectionOf(base.call), [...base.clauses, ...p.flatMap((s) => s.clauses)]);
                }
              }
            } else {
              emit(siteOf(rootPath, root), collectionOf(base.call), [...base.clauses, ...clauses]);
            }
          } else {
            const file = path.relative(rootPath, sf.fileName);
            const fn = enclosingFunctionName(n);
            const model = handModels.find((m) => m.file === file && m.fn === fn);
            if (model) {
              usedModels.add(model);
              for (const s of model.shapes) shapes.push({ ...cloneShape({ ...s, site: '' }), site: `${file}:${fn} (hand-modelled)` });
            } else {
              unresolved.push({ site: siteOf(rootPath, n), reason: `query clause on '${root.getText().slice(0, 40)}' cannot be traced to a collection — hand-model ${file}:${fn}` });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    const rootPath = root;
    visit(sf);
  }
  // Let builders whose query clauses all live in reassignments (the chain head has none).
  for (const sf of program.getSourceFiles()) {
    if (!wanted.has(path.resolve(sf.fileName))) continue;
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && (n.parent.flags & ts.NodeFlags.Let) !== 0 && !handledBuilders.has(n)) {
        const { root: r, clauses } = peelChain(n.initializer);
        if (isCollectionCall(r)) {
          const steps = builderSteps(checker, n.name);
          const bsite = siteOf(root, r);
          if (typeof steps === 'string') unresolved.push({ site: bsite, reason: steps });
          else if (hasQueryClause(clauses) || steps.some((s) => hasQueryClause(s.clauses))) {
            handledBuilders.add(n);
            const paths = builderPaths(steps);
            if (typeof paths === 'string') unresolved.push({ site: bsite, reason: paths });
            else for (const p of paths) emit(bsite, collectionOf(r), [...clauses, ...p.flatMap((s) => s.clauses)]);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const m of handModels) {
    if (!usedModels.has(m)) unresolved.push({ site: `${m.file}:${m.fn}`, reason: 'hand model matches no untraceable query clause (stale model)' });
  }
  const seen = new Set<string>();
  const unique = shapes.filter((sh) => {
    const key = `${sh.site}|${describeShape(sh)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { shapes: unique, unresolved };
}

/** The ordered suffix S for a shape (inequality field first when it is not the first orderBy). */
export function orderedSuffix(shape: QueryShape): OrderField[] {
  const s = [...shape.orderBy];
  for (const f of shape.inequality) {
    if (!s.some((o) => o.field === f)) s.unshift({ field: f, direction: 'ASCENDING' });
  }
  return s;
}

/** Whether Firestore needs a composite index for this shape at all. */
export function needsComposite(shape: QueryShape): boolean {
  const s = orderedSuffix(shape);
  const eqCount = shape.equality.length + shape.contains.length;
  if (s.length === 0) return false;
  if (eqCount === 0 && s.length === 1) return false;
  if (eqCount === 0 && s.length === 2 && s[1].field === '__name__' && s[1].direction === s[0].direction) return false;
  return true;
}

function sameSuffix(indexTail: DeclaredIndexField[], s: OrderField[]): boolean {
  const eq = (a: DeclaredIndexField[], b: OrderField[]) =>
    a.length === b.length && a.every((f, i) => f.arrayConfig === undefined && f.fieldPath === b[i].field && f.order === b[i].direction);
  if (eq(indexTail, s)) return true;
  // A trailing __name__ in the direction of the last field is the implicit tie-break.
  const last = s[s.length - 1];
  if (last && last.field === '__name__' && s.length >= 2 && s[s.length - 2].direction === last.direction) {
    return eq(indexTail, s.slice(0, -1));
  }
  // …and an index may declare that implicit tail explicitly.
  if (indexTail.length === s.length + 1) {
    const t = indexTail[indexTail.length - 1];
    const prev = s[s.length - 1];
    if (t.fieldPath === '__name__' && prev && t.order === prev.direction) return eq(indexTail.slice(0, -1), s);
  }
  return false;
}

/** Whether the declared indexes serve this shape (exact or merged over equality prefixes). */
export function isServed(shape: QueryShape, indexes: DeclaredIndex[]): boolean {
  if (!needsComposite(shape)) return true;
  const s = orderedSuffix(shape);
  const eqNeeded = new Set([...shape.equality.map((f) => `eq:${f}`), ...shape.contains.map((f) => `ct:${f}`)]);
  const covered = new Set<string>();
  let anyCandidate = false;
  for (const ix of indexes) {
    if (ix.collectionGroup !== shape.collection || (ix.queryScope ?? 'COLLECTION') !== 'COLLECTION') continue;
    for (let k = 0; k <= ix.fields.length; k++) {
      const prefix = ix.fields.slice(0, k);
      const tail = ix.fields.slice(k);
      if (!sameSuffix(tail, s)) continue;
      const keys = prefix.map((f) => (f.arrayConfig === 'CONTAINS' ? `ct:${f.fieldPath}` : `eq:${f.fieldPath}`));
      if (!keys.every((key) => eqNeeded.has(key))) continue;
      if (eqNeeded.size > 0 && keys.length === 0) continue;
      anyCandidate = true;
      keys.forEach((key) => covered.add(key));
    }
  }
  if (eqNeeded.size === 0) return anyCandidate;
  return [...eqNeeded].every((key) => covered.has(key));
}

/** A readable index spec for the failure message. */
export function describeShape(shape: QueryShape): string {
  const parts = [
    ...shape.equality.map((f) => `${f} ==`),
    ...shape.contains.map((f) => `${f} CONTAINS`),
    ...orderedSuffix(shape).map((o) => `${o.field} ${o.direction === 'ASCENDING' ? 'ASC' : 'DESC'}`),
  ];
  return `${shape.collection} [${parts.join(', ')}] at ${shape.site}`;
}

export function loadDeclaredIndexes(file: string): DeclaredIndex[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { indexes?: DeclaredIndex[] };
  return parsed.indexes ?? [];
}

/** Every shape that needs a composite index the declared set does not serve. */
export function findMissingIndexes(shapes: QueryShape[], indexes: DeclaredIndex[]): QueryShape[] {
  return shapes.filter((s) => !isServed(s, indexes));
}
