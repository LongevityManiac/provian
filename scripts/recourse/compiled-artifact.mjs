import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
/** Foundry gives a multiply compiled source a qualified directory or profile
 * suffix. Select the intended compiler profile, never a stale default artifact.
 * Callers additionally verify source hashes before planning deployments. */
export function readCompiledArtifact(root, name) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw Error('recourse_artifact_name');
  const runs = 200;
  const paths = [
    `contracts/out/${name}.sol/${name}.json`,
    `contracts/out/src/${name}.sol/${name}.json`,
    `contracts/out/${name}.sol/${name}.recourse-size.json`,
  ];
  const matches = paths.map(path => resolve(root,path)).filter(existsSync).map(path => JSON.parse(readFileSync(path,'utf8')))
    .filter(a => a.metadata?.settings?.optimizer?.enabled === true && a.metadata.settings.optimizer.runs === runs);
  if (!matches.length) throw Error('recourse_artifact_profile_missing:'+name);
  const first=matches[0];
  if (matches.some(a => a.bytecode.object !== first.bytecode.object)) throw Error('recourse_artifact_profile_ambiguous:'+name);
  return first;
}
