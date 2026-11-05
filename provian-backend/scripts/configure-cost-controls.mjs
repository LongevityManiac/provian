/** Apply only ciphertext-body index exemptions and routine request-log sampling.
 * node scripts/configure-cost-controls.mjs [--execute] (default: read-only plan)
 * Authentication uses the active gcloud account; no credentials appear in output.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const execute = process.argv.includes('--execute');
const project = 'provian-ai', database = 'relay';
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
const name = 'provian-api-success-requests';
const filter = 'resource.type="cloud_run_revision" resource.labels.service_name="provian-api" LOG_ID("run.googleapis.com/requests") httpRequest.status>=200 httpRequest.status<400 NOT httpRequest.requestUrl:"/v1/internal/" sample(insertId,0.99)';
const description = 'Keep 1% of routine successful API request logs; keep all internal requests, failures and application logs.';
async function api(url, method = 'GET', body) {
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
const fields = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url))).fieldOverrides.filter(f => f.fieldPath === 'body' && f.indexes.length === 0);
const operations = [];
for (const field of fields) {
  const path = `projects/${project}/databases/${database}/collectionGroups/${field.collectionGroup}/fields/body`;
  const url = `https://firestore.googleapis.com/v1/${path}`;
  const before = await api(url);
  const exempt = before.indexConfig && before.indexConfig.usesAncestorConfig !== true && (before.indexConfig?.indexes ?? []).length === 0;
  if (execute && !exempt) operations.push(await api(url + '?updateMask=indexConfig', 'PATCH', { name: path, indexConfig: { indexes: [] } }));
  console.log(JSON.stringify({ collection: field.collectionGroup, field: 'body', action: exempt ? 'already_exempt' : execute ? 'exemption_requested' : 'would_exempt' }));
}
const root = `https://logging.googleapis.com/v2/projects/${project}/exclusions`;
const exclusions = (await api(root)).exclusions ?? [];
const existing = exclusions.find(x => x.name === name);
if (execute) {
  if (existing) await api(`${root}/${name}?updateMask=filter,description,disabled`, 'PATCH', { name, filter, description, disabled: false });
  else await api(root, 'POST', { name, filter, description, disabled: false });
  const applied = await api(`${root}/${name}`);
  if (applied.filter !== filter || applied.disabled === true) throw new Error('request-log exclusion did not apply exactly');
}
console.log(JSON.stringify({ logging: name, action: execute ? 'verified_enabled' : 'would_apply', filter }));
// Index removal is asynchronous. Print operation identities and verify each on later invocations;
// never delete documents, TTL fields, lookup indexes, backups or sinks.
console.log(JSON.stringify({ execute, ciphertext_fields: fields.length, operations: operations.map(x => x.name) }));
