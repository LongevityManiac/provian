/**
 * Firestore composite-index drift tripwire (residual, 2026-09-22).
 *
 * Every query the Commons modules can build must be served by an index DECLARED in
 * `firestore.indexes.json`. The fake Firestore the unit tests run on needs no indexes, so a
 * missing one only ever showed up as a 500 in prod: three queries did exactly that, and
 * building this tripwire found four more (human-jobs browse by category / location / compensation,
 * and "my human jobs" as poster or accepted applicant — each confirmed FAILED_PRECONDITION against
 * prod before its index was declared).
 *
 * The analyzer (`firestore-index-drift.ts`) reads the source with the TypeScript compiler. A query
 * clause it cannot trace to a collection fails this suite until it is hand-modelled below, and a
 * hand model that no longer matches any site fails too, so the model list cannot rot silently.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  scanQueryShapes, findMissingIndexes, loadDeclaredIndexes, describeShape, needsComposite,
  type DeclaredIndex, type HandModel, type QueryShape,
} from './firestore-index-drift';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const COMMONS_DIR = __dirname;
const INDEX_FILE = path.join(BACKEND_ROOT, 'firestore.indexes.json');

function commonsSources(): string[] {
  return fs.readdirSync(COMMONS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && f !== 'firestore-index-drift.ts')
    .map((f) => path.join(COMMONS_DIR, f));
}

/**
 * Query clauses the analyzer cannot trace. `applyHumanJobsSort` sorts a query built by
 * `getMyHumanJobs`'s `buildQuery` (owner field == wallet, optional status ==).
 */
const OWNER_FIELDS = ['poster_wallet_id', 'accepted_applicant_wallet_id'];
const HAND_MODELS: HandModel[] = [
  {
    file: 'src/core/commons/human-jobs.ts',
    fn: 'applyHumanJobsSort',
    shapes: OWNER_FIELDS.flatMap((owner) => [[], ['status']].flatMap((extra) =>
      (['ASCENDING', 'DESCENDING'] as const).map((direction) => ({
        collection: 'commons_human_jobs',
        equality: [owner, ...extra],
        contains: [],
        inequality: [],
        orderBy: [{ field: 'posted_at', direction }],
      })))),
  },
];

describe('Firestore composite-index drift — Commons queries vs firestore.indexes.json', () => {
  const declared = loadDeclaredIndexes(INDEX_FILE);
  const scan = scanQueryShapes(commonsSources(), BACKEND_ROOT, HAND_MODELS);

  it('every Commons query clause is traced to a collection (or hand-modelled)', () => {
    expect(scan.unresolved).toEqual([]);
  });

  it('evaluates a real population (a pass over zero queries is not a pass)', () => {
    const composite = scan.shapes.filter(needsComposite);
    // Printed so a reader sees how much was actually checked.
    console.log(`[index-drift] ${scan.shapes.length} query shapes, ${composite.length} need a composite index`);
    expect(scan.shapes.length).toBeGreaterThan(40);
    expect(composite.length).toBeGreaterThan(10);
    // The three queries that 500'd in prod are in the evaluated set.
    const described = composite.map(describeShape).join('\n');
    expect(described).toContain('commons_thread_messages [thread_id ==, created_at DESC, __name__ DESC]');
    expect(described).toContain('commons_wants [capabilities CONTAINS, created_at DESC, __name__ ASC]');
    expect(described).toContain('commons_wants [created_at DESC, __name__ ASC]');
    // forum feed / tree / inbox queries are in the evaluated set.
    expect(described).toContain('commons_forum_posts [parent_post_id ==, hot_score DESC, __name__ ASC]');
    expect(described).toContain('commons_forum_posts [parent_post_id ==, channel ==, score DESC, __name__ ASC]');
    expect(described).toContain('commons_forum_posts [root_post_id ==, created_at ASC]');
    expect(described).toContain('commons_forum_posts [parent_author_wallet_id ==, created_at DESC, __name__ ASC]');
  });

  it('every composite-needing query is served by a declared index', () => {
    const missing = findMissingIndexes(scan.shapes, declared).map(describeShape);
    expect(missing).toEqual([]);
  });

  describe('RED controls — the tripwire fires on the defects it exists for', () => {
    const shapes = scan.shapes;
    const without = (pred: (ix: DeclaredIndex) => boolean) => declared.filter((ix) => !pred(ix));
    const fieldsOf = (ix: DeclaredIndex) => ix.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`).join(',');

    it('RED: dropping the thread-messages index reports the thread read', () => {
      const missing = findMissingIndexes(shapes, without((ix) => ix.collectionGroup === 'commons_thread_messages')).map(describeShape);
      expect(missing.some((m) => m.startsWith('commons_thread_messages [thread_id ==, created_at DESC, __name__ DESC]'))).toBe(true);
    });

    it('RED: an index missing its explicit __name__ ASC tail does not serve created_at DESC + documentId ASC', () => {
      const stripped = declared.map((ix) => ix.collectionGroup === 'commons_wants'
        ? { ...ix, fields: ix.fields.filter((f) => f.fieldPath !== '__name__') }
        : ix);
      const missing = findMissingIndexes(shapes, stripped).map(describeShape);
      expect(missing.some((m) => m.startsWith('commons_wants [created_at DESC, __name__ ASC]'))).toBe(true);
    });

    it('RED: an equality filter with no index to merge in is reported (the human-jobs category browse)', () => {
      const missing = findMissingIndexes(shapes, without((ix) => ix.collectionGroup === 'commons_human_jobs' && fieldsOf(ix) === 'category:ASCENDING,posted_at:DESCENDING')).map(describeShape);
      expect(missing.some((m) => m.startsWith('commons_human_jobs [status ==, category ==, posted_at DESC]'))).toBe(true);
    });

    it('RED: dropping a forum index reports the query it served (feed, tree, inbox)', () => {
      const dropFields = (fields: string) => findMissingIndexes(shapes, without((ix) => ix.collectionGroup === 'commons_forum_posts' && fieldsOf(ix) === fields)).map(describeShape);
      expect(dropFields('parent_post_id:ASCENDING,hot_score:DESCENDING,__name__:ASCENDING')
        .some((m) => m.startsWith('commons_forum_posts [parent_post_id ==, hot_score DESC, __name__ ASC]'))).toBe(true);
      expect(dropFields('root_post_id:ASCENDING,created_at:ASCENDING')
        .some((m) => m.startsWith('commons_forum_posts [root_post_id ==, created_at ASC]'))).toBe(true);
      expect(dropFields('parent_author_wallet_id:ASCENDING,created_at:DESCENDING,__name__:ASCENDING')
        .some((m) => m.startsWith('commons_forum_posts [parent_author_wallet_id ==, created_at DESC, __name__ ASC]'))).toBe(true);
    });

    it('RED: a wrong sort direction is not served', () => {
      const shape: QueryShape = { collection: 'c', equality: ['a'], contains: [], inequality: [], orderBy: [{ field: 't', direction: 'ASCENDING' }], site: 'x' };
      const idx: DeclaredIndex[] = [{ collectionGroup: 'c', queryScope: 'COLLECTION', fields: [{ fieldPath: 'a', order: 'ASCENDING' }, { fieldPath: 't', order: 'DESCENDING' }] }];
      expect(findMissingIndexes([shape], idx)).toHaveLength(1);
      idx[0].fields[1].order = 'ASCENDING';
      expect(findMissingIndexes([shape], idx)).toHaveLength(0);
    });

    it('RED: an untraceable clause and a stale hand model are both reported', () => {
      const bare = scanQueryShapes(commonsSources(), BACKEND_ROOT, []);
      expect(bare.unresolved.some((u) => u.reason.includes('applyHumanJobsSort'))).toBe(true);
      const stale: HandModel = { file: 'src/core/commons/forum.ts', fn: 'noSuchFunction', shapes: [] };
      const withStale = scanQueryShapes(commonsSources(), BACKEND_ROOT, [...HAND_MODELS, stale]);
      expect(withStale.unresolved.some((u) => u.site.includes('noSuchFunction') && u.reason.includes('stale'))).toBe(true);
    });

    it('equality-only and single-order queries need no composite (no false alarms)', () => {
      const base = { collection: 'c', contains: [], inequality: [], site: 'x' };
      expect(needsComposite({ ...base, equality: ['a', 'b'], orderBy: [] })).toBe(false);
      expect(needsComposite({ ...base, equality: [], orderBy: [{ field: 't', direction: 'DESCENDING' }] })).toBe(false);
      expect(needsComposite({ ...base, equality: ['a'], orderBy: [{ field: 't', direction: 'DESCENDING' }] })).toBe(true);
    });
  });
});
