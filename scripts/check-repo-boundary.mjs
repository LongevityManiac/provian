#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {missingDocLinks} from './repo-doc-links.mjs';
const oldCodeUrl='https://github.com/LongevityManiac/' + 'provian-wallet-anti-gravity';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const internalNames=new Set(['CLAUDE.md','AGENTS.md','CODEX_STARTUP.md','DECISIONS.md','OPEN_ITEMS.md','STATUS.md','WP_SCOPE.md','ATLAS-BIBLE.md','GLOBAL_STRATEGY.md','NARRATIVE_CANON.md','OPEN_SOURCE_SPLIT.md','SECURITY_NOTES.md','FEATURES_AND_DIFFERENTIATORS.md','VISION.md','docs/DARKNESS_LEDGER.md']);
const privateRoots=['docs/archive/','docs/wp-runs/','docs/audits/','docs/security/','docs/launch/','docs/launch-messaging/','.claude/','outputs/','docs/ops/','docs/handoffs/','docs/publish/','docs/appstore/'];
// These byte-pinned suites contain synthetic credential markers for privacy RED controls.
const secretFixtureHashes={"provian-agent-sdk/src/input-origins.test.ts": "de4228ef386370e749ab88f9e8f477a8c1ea128a39f4e4580c5099b2fe7dc426", "provian-agent-sdk/src/observer/origin-capture.credentials.test.ts": "70144f7701819f837a426f0c003ecbbf8517a208f140f05194ca589bc954b248", "provian-backend/src/core/provenance/input-origins.test.ts": "17df2e13eb4d29532197fd821958d46855753ff360aed5e6ab9387ab9f3458f4"};
export function violations(files,read=(f)=>readFileSync(resolve(root,f),'utf8'),gitlinks=new Set()) {
 const hits=[];
 if(files.length===0)hits.push('empty tracked population');
 for(const f of files){
  if(internalNames.has(f)||/(?:^|\/)(?:CLAUDE|AGENTS|CODEX_STARTUP|DECISIONS|OPEN_ITEMS|STATUS|WP_SCOPE|DARKNESS_LEDGER|NARRATIVE_SPINE|DOCUMENTATION_INDEX|SECRET_INVENTORY|SECRETS_WORKFLOW|SECRET_MANAGER_POSTURE|ATLAS-BIBLE|GLOBAL_STRATEGY|NARRATIVE_CANON|OPEN_SOURCE_SPLIT|SECURITY_NOTES|FEATURES_AND_DIFFERENTIATORS)\.(?:md|txt|json)$/i.test(f)||/Founding[_ -]Compact/i.test(f)||/^docs\/audit\/.*\.md$/.test(f)||privateRoots.some((p)=>f.startsWith(p)))hits.push(`internal path: ${f}`);
  if(/(?:^|\/)\.env(?:\.|$)/.test(f)&&!f.endsWith('.example'))hits.push(`environment file: ${f}`);
  if(/\.(?:p12|pfx|p8|keystore|jks)$/.test(f))hits.push(`credential file: ${f}`);
  if(gitlinks.has(f))continue; // Only mode160000 entries are external gitlinks.
  const text=read(f);
  if(text.includes(oldCodeUrl))hits.push(`old code repository URL: ${f}`);
  const secretShaped=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_|github_pat_|npm_)[A-Za-z0-9_]{30,}/.test(text);
  if(secretShaped&&createHash('sha256').update(text).digest('hex')!==secretFixtureHashes[f])hits.push(`secret-shaped material: ${f}`);
 }
 return hits;
}
function selftest(){
 for(const [files,read] of [[[],()=> ''],[['DECISIONS.md'],()=> ''],[['docs/wp-runs/a.md'],()=> ''],[['.env.production'],()=> ''],[['README.md'],()=> oldCodeUrl],[['config/key.pem'],()=> '-----BEGIN ' + 'PRIVATE KEY-----'],[['docs/DECISIONS.md'],()=> ''],[['reference/Provian_Founding_Compact.md'],()=> ''],[['docs/DARKNESS_LEDGER.txt'],()=> ''],[['docs/ops/SECRET_INVENTORY.md'],()=> ''],[['credentials.py'],()=> '-----BEGIN ' + 'PRIVATE KEY-----'],[['native.swift'],()=> '-----BEGIN ' + 'PRIVATE KEY-----'],[['credentials.test.ts'],()=> '-----BEGIN ' + 'PRIVATE KEY-----'],[['deploy/creds'],()=> '-----BEGIN ' + 'PRIVATE KEY-----'],[['key.pfx'],()=> ''],[['contracts/lib/forge-std'],()=> '-----BEGIN ' + 'PRIVATE KEY-----']]){
  if(!violations(files,read).length)throw Error('boundary negative control passed');
 }
 if(violations(['README.md'],()=> 'Provian').length)throw Error('boundary clean control failed');
 if(!missingDocLinks(['README.md'],()=> '[missing](docs/missing.md)').length)throw Error('document link negative control passed');
 if(missingDocLinks(['README.md','docs/guide.md'],(f)=>f==='README.md'?'[guide](docs/guide.md)':'guide').length)throw Error('document link clean control failed');
 if(!missingDocLinks(['README.md'],()=> '[missing](missing.md "a title")').length)throw Error('titled document negative control passed');
 if(missingDocLinks(['README.md','docs/guide.md'],(f)=>f==='README.md'?'[guide](<docs/guide.md>)':'guide').length)throw Error('angle document clean control failed');
 console.log('repo-boundary self-test: 16 secret/internal RED controls, missing document controls and clean controls passed');
}
export function check(repo=root,rev=null){
 const entries=execFileSync('git',rev?['ls-tree','-r',rev]:['ls-files','--stage'],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(Boolean);
 const files=entries.map((line)=>line.split('\t')[1]);
 const gitlinks=new Set(entries.filter((line)=>line.startsWith('160000 ')).map((line)=>line.split('\t')[1]));
 const read=(f)=>rev?execFileSync('git',['show',`${rev}:${f}`],{cwd:repo,encoding:'utf8',maxBuffer:64*1024*1024}):readFileSync(resolve(repo,f),'utf8');
 const hits=[...violations(files,read,gitlinks),...missingDocLinks(files,read)];if(hits.length)throw Error(hits.join('\n'));
 console.log(`repo-boundary: ${files.length} tracked paths, no internal records or secrets detected`);return files.length;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){if(process.argv.includes('--self-test'))selftest();const at=process.argv.indexOf('--rev');check(root,at<0?null:process.argv[at+1]);}
