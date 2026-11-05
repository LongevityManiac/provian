#!/usr/bin/env node
/**
 * A release is cut only from the clean code repository. Internal records never ship.
 *
 *   node scripts/public-cut.mjs dry-run [--exclude <file>]       list what the cut leaves out; writes nothing
 *   node scripts/public-cut.mjs make <dir> [--exclude <file>]    cut HEAD into a fresh one-commit repo at <dir>
 *   node scripts/public-cut.mjs check <dir> [--exclude <file>]   re-check an existing release repository
 *   node scripts/public-cut.mjs selftest                         RED/clean controls (no exclude file needed)
 *
 * THE PRIVATE LAUNCH SET (2026-10-23 close-out). Besides the repo-boundary check, every cut honors
 * the private launch exclude list, `docs/launch/PUBLIC_CUT_EXCLUDE.txt`, which lives in the INTERNAL
 * repository (`LongevityManiac/provian-wallet-anti-gravity`) and never in this one. The script finds
 * it, in order:
 *   1. `--exclude <file>`;
 *   2. the `PROVIAN_PUBLIC_CUT_EXCLUDE` environment variable;
 *   3. the internal checkout beside this one: `<this repo>/../provian-wallet-anti-gravity/docs/launch/PUBLIC_CUT_EXCLUDE.txt`.
 * It FAILS CLOSED: a missing or unreadable file, a file without the `PROVIAN-PRIVATE-LAUNCH` header,
 * a file with no entries, or any line it does not understand stops `dry-run`, `make` and `check`
 * before anything is written. Format (one entry per line; blank lines and `#` comments ignored):
 *   path <repo-relative path>   the file, or the directory and everything under it, is left out
 *   section <repo-relative file> every block from a `<!-- PROVIAN-PRIVATE-LAUNCH:BEGIN` line through the
 *                               next `<!-- PROVIAN-PRIVATE-LAUNCH:END -->` line is stripped (an unbalanced
 *                               or nested marker fails the cut)
 * Entries naming paths this repository does not track (the list also names internal-repo paths) are
 * reported by `dry-run` and remove nothing. After `make`, the release tree must equal HEAD minus the
 * excluded paths, byte-for-byte, except the stripped section files; any excluded path present, or any
 * section marker left, fails the cut.
 */
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {check} from './check-repo-boundary.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const EXCLUDE_HEADER='PROVIAN-PRIVATE-LAUNCH';
export const SECTION_BEGIN='<!-- PROVIAN-PRIVATE-LAUNCH:BEGIN';
export const SECTION_END='<!-- PROVIAN-PRIVATE-LAUNCH:END -->';

/** Where the exclude list is, per the header: flag, then env, then the sibling internal checkout. */
export function locateExcludeFile(argv,env=process.env,repo=root){
 const at=argv.indexOf('--exclude');
 if(at>=0){if(!argv[at+1])throw Error('--exclude needs a file');return {file:resolve(argv[at+1]),source:'--exclude'};}
 if(env.PROVIAN_PUBLIC_CUT_EXCLUDE)return {file:resolve(env.PROVIAN_PUBLIC_CUT_EXCLUDE),source:'PROVIAN_PUBLIC_CUT_EXCLUDE'};
 return {file:resolve(repo,'..','provian-wallet-anti-gravity','docs','launch','PUBLIC_CUT_EXCLUDE.txt'),source:'sibling internal checkout'};
}

function validRelativePath(p){
 return typeof p==='string'&&p.length>0&&!p.startsWith('/')&&!p.includes('\\')&&!p.endsWith('/')
  &&p.split('/').every((seg)=>seg!==''&&seg!=='.'&&seg!=='..')&&!/[\s\0]/.test(p);
}

/** Parse the exclude list; throw on anything it does not understand (fail closed). */
export function parseExcludeList(text,label='exclude file'){
 if(typeof text!=='string'||!text.includes(EXCLUDE_HEADER))throw Error(`${label}: missing the ${EXCLUDE_HEADER} header — not the private launch exclude list`);
 const paths=[],sections=[];
 text.split('\n').forEach((raw,i)=>{
  const line=raw.replace(/\r$/,'').trim();
  if(!line||line.startsWith('#'))return;
  const m=/^(path|section) (\S+)$/.exec(line);
  if(!m)throw Error(`${label}:${i+1}: malformed line: ${JSON.stringify(raw)}`);
  if(!validRelativePath(m[2]))throw Error(`${label}:${i+1}: not a repo-relative path: ${JSON.stringify(m[2])}`);
  (m[1]==='path'?paths:sections).push(m[2]);
 });
 if(!paths.length&&!sections.length)throw Error(`${label}: no entries`);
 return {paths,sections};
}

export function readExcludeList(located){
 let text;
 try{text=readFileSync(located.file,'utf8');}
 catch(err){throw Error(`public cut refused: cannot read the private launch exclude list at ${located.file} (${located.source}): ${err.message}`);}
 return parseExcludeList(text,located.file);
}

/** Is `file` the path, or under the directory, an entry names? */
export function excludedBy(file,paths){return paths.find((p)=>file===p||file.startsWith(p+'/'))??null;}

/** Strip every private-launch block (BEGIN line through END line); throw on unbalanced markers. */
export function stripSections(text,label='section file'){
 const out=[];let open=-1;let blocks=0;
 const lines=text.split('\n');
 lines.forEach((line,i)=>{
  const begin=line.trimStart().startsWith(SECTION_BEGIN),end=line.trim()===SECTION_END;
  if(begin){if(open>=0)throw Error(`${label}:${i+1}: nested ${SECTION_BEGIN}`);open=i;return;}
  if(end){if(open<0)throw Error(`${label}:${i+1}: ${SECTION_END} without BEGIN`);open=-1;blocks++;return;}
  if(open<0)out.push(line);
 });
 if(open>=0)throw Error(`${label}:${open+1}: ${SECTION_BEGIN} never closed`);
 return {text:out.join('\n'),blocks,removedLines:lines.length-out.length};
}

/** What the exclude list does to a tracked tree: removed paths, stripped section files, unmatched entries. */
export function planCut(files,list){
 const removed=new Map();
 for(const f of files){const by=excludedBy(f,list.paths);if(by)removed.set(f,by);}
 const unmatchedPaths=list.paths.filter((p)=>!files.some((f)=>excludedBy(f,[p])));
 const sectionFiles=list.sections.filter((s)=>files.includes(s)&&!removed.has(s));
 const unmatchedSections=list.sections.filter((s)=>!files.includes(s));
 return {removed,sectionFiles,unmatchedPaths,unmatchedSections};
}

/**
 * Verify a cut against its source: `release` and `source` map path → {mode,sha}; `readRelease` and
 * `readSource` return a path's bytes as text. Returns violations (empty = the cut is exact).
 */
export function cutViolations({source,release,list,readSource,readRelease}){
 const hits=[];
 if(source.size===0)hits.push('empty source tree');
 const plan=planCut([...source.keys()],list);
 for(const f of release.keys()){
  const by=excludedBy(f,list.paths);
  if(by)hits.push(`excluded path present in the cut: ${f} (path ${by})`);
  else if(!source.has(f))hits.push(`path not in source HEAD: ${f}`);
 }
 for(const [f,entry] of source){
  if(plan.removed.has(f))continue;
  const got=release.get(f);
  if(!got){hits.push(`path missing from the cut: ${f}`);continue;}
  if(got.mode!==entry.mode)hits.push(`mode differs: ${f}`);
  if(plan.sectionFiles.includes(f)){
   const text=readRelease(f);
   if(text.includes(SECTION_BEGIN)||text.includes(SECTION_END))hits.push(`private-launch section left in the cut: ${f}`);
   else if(text!==stripSections(readSource(f),f).text)hits.push(`section file differs from its stripped source: ${f}`);
  }else if(got.sha!==entry.sha)hits.push(`content differs from source HEAD: ${f}`);
 }
 return hits;
}

function tree(cwd,rev='HEAD'){
 const map=new Map();
 for(const line of execFileSync('git',['ls-tree','-r','-z',rev],{cwd,encoding:'utf8',maxBuffer:256*1024*1024}).split('\0').filter(Boolean)){
  const [meta,path]=line.split('\t');const [mode,,sha]=meta.split(' ');map.set(path,{mode,sha});
 }
 return map;
}
const show=(cwd,rev)=>(f)=>execFileSync('git',['show',`${rev}:${f}`],{cwd,encoding:'utf8',maxBuffer:64*1024*1024});

function loadList(argv){
 const located=locateExcludeFile(argv);
 const list=readExcludeList(located);
 console.log(`public-cut: private launch exclude list ${located.file} (${located.source}): ${list.paths.length} path + ${list.sections.length} section entries`);
 return list;
}

function dryRun(argv){
 const list=loadList(argv);
 check(root,'HEAD');
 const source=tree(root);
 const plan=planCut([...source.keys()],list);
 const byEntry=new Map(list.paths.map((p)=>[p,[]]));
 for(const [f,by] of plan.removed)byEntry.get(by).push(f);
 console.log(`public-cut dry run of HEAD (${source.size} tracked paths) — nothing is written`);
 for(const [p,files] of byEntry){
  if(!files.length)console.log(`  path ${p}: not tracked here — removes nothing`);
  else{console.log(`  path ${p}: removes ${files.length}`);for(const f of files)console.log(`    - ${f}`);}
 }
 for(const s of list.sections){
  if(!source.has(s))console.log(`  section ${s}: not tracked here — strips nothing`);
  else if(plan.removed.has(s))console.log(`  section ${s}: the whole file is already removed by a path entry`);
  else{const r=stripSections(show(root,'HEAD')(s),s);console.log(`  section ${s}: strips ${r.blocks} block(s), ${r.removedLines} line(s)`);}
 }
 console.log(`public-cut dry run: ${plan.removed.size} path(s) left out, ${plan.sectionFiles.length} file(s) stripped; the cut would ship ${source.size-plan.removed.size} paths`);
 return plan;
}

function make(directory,argv){
 const list=loadList(argv);
 check(root,'HEAD');
 const dir=resolve(directory);if(existsSync(dir))throw Error('destination exists');
 const source=tree(root);const plan=planCut([...source.keys()],list);
 // Section files must strip cleanly before anything is written.
 const stripped=new Map(plan.sectionFiles.map((f)=>[f,stripSections(show(root,'HEAD')(f),f).text]));
 mkdirSync(dir,{recursive:true});
 execFileSync('sh',['-c','git archive HEAD | tar -x -C "$PROVIAN_RELEASE_OUT"'],{cwd:root,env:{...process.env,PROVIAN_RELEASE_OUT:dir}});
 for(const f of plan.removed.keys())rmSync(join(dir,f),{recursive:true,force:true});
 for(const p of list.paths)rmSync(join(dir,p),{recursive:true,force:true}); // directories git archive left empty
 for(const [f,text] of stripped)writeFileSync(join(dir,f),text);
 execFileSync('git',['init','-q','-b','master'],{cwd:dir});execFileSync('git',['add','-A','-f'],{cwd:dir});
 for(const [path,{mode,sha}] of source){
  if(mode==='160000'&&!plan.removed.has(path))execFileSync('git',['update-index','--add','--cacheinfo',`160000,${sha},${path}`],{cwd:dir});
 }
 execFileSync('git',['commit','-q','-m','Initial Provian release'],{cwd:dir});
 const hits=cutViolations({source,release:tree(dir),list,readSource:show(root,'HEAD'),readRelease:show(dir,'HEAD')});
 if(hits.length)throw Error('release tree is not HEAD minus the private launch set:\n'+hits.join('\n'));
 if(execFileSync('git',['rev-list','--count','HEAD'],{cwd:dir,encoding:'utf8'}).trim()!=='1')throw Error('release contains history');
 check(dir,'HEAD');
 console.log(`public-cut: ${dir} — ${source.size-plan.removed.size} paths, ${plan.removed.size} left out, ${plan.sectionFiles.length} stripped`);
}

function checkRelease(directory,argv){
 const list=loadList(argv);
 const dir=resolve(directory);
 const revs=execFileSync('git',['rev-list','--all'],{cwd:dir,encoding:'utf8'}).trim().split('\n').filter(Boolean);
 if(!revs.length)throw Error('empty release history');
 for(const rev of revs){
  check(dir,rev);
  const files=[...tree(dir,rev).keys()];
  const leaked=files.filter((f)=>excludedBy(f,list.paths));
  if(leaked.length)throw Error(`release ${rev} carries private launch paths:\n${leaked.join('\n')}`);
  for(const s of list.sections.filter((s)=>files.includes(s))){
   const text=show(dir,rev)(s);if(text.includes(SECTION_BEGIN)||text.includes(SECTION_END))throw Error(`release ${rev} carries a private launch section in ${s}`);
  }
 }
}

function selftest(){
 const must=(fn,what)=>{let threw=false;try{fn();}catch{threw=true;}if(!threw)throw Error(`public-cut negative control passed: ${what}`);};
 const header=`# ${EXCLUDE_HEADER}\n`;
 // Exclude-list parsing fails closed.
 must(()=>parseExcludeList(''),'empty file');
 must(()=>parseExcludeList('path a.md\n'),'no header');
 must(()=>parseExcludeList(header),'no entries');
 must(()=>parseExcludeList(header+'pth a.md\n'),'unknown keyword');
 must(()=>parseExcludeList(header+'path ../a.md\n'),'parent traversal');
 must(()=>parseExcludeList(header+'path /etc/passwd\n'),'absolute path');
 must(()=>parseExcludeList(header+'path a b.md\n'),'two paths on one line');
 must(()=>readExcludeList({file:join(root,'scripts','no-such-exclude-file.txt'),source:'selftest'}),'unreadable file');
 const list=parseExcludeList(header+'path secret/listings\npath notes.md\nsection README.md\n');
 if(list.paths.length!==2||list.sections.length!==1)throw Error('public-cut clean parse control failed');
 // Section stripping fails closed on unbalanced markers.
 must(()=>stripSections(`a\n${SECTION_BEGIN} x -->\nb\n`),'unclosed BEGIN');
 must(()=>stripSections(`a\n${SECTION_END}\n`),'END without BEGIN');
 must(()=>stripSections(`${SECTION_BEGIN} -->\n${SECTION_BEGIN} -->\n${SECTION_END}\n`),'nested BEGIN');
 const s=stripSections(`keep\n${SECTION_BEGIN} why -->\nprivate\n${SECTION_END}\nkeep2`);
 if(s.text!=='keep\nkeep2'||s.blocks!==1)throw Error('public-cut clean strip control failed');
 // A cut is verified against its source: an excluded path present (RED), a stripped section left
 // (RED), a changed byte (RED); the exact cut passes (clean).
 const src=new Map([['README.md',{mode:'100644',sha:'r'}],['app.ts',{mode:'100644',sha:'a'}],['secret/listings/x.md',{mode:'100644',sha:'x'}],['notes.md',{mode:'100644',sha:'n'}]]);
 const readSource=(f)=>f==='README.md'?`pub\n${SECTION_BEGIN} -->\nprivate\n${SECTION_END}\n`:'';
 const exact=new Map([['README.md',{mode:'100644',sha:'r2'}],['app.ts',{mode:'100644',sha:'a'}]]);
 const clean=cutViolations({source:src,release:exact,list,readSource,readRelease:()=> 'pub\n'});
 if(clean.length)throw Error('public-cut clean cut control failed: '+clean.join('; '));
 const leaked=new Map([...exact,['secret/listings/x.md',{mode:'100644',sha:'x'}]]);
 if(!cutViolations({source:src,release:leaked,list,readSource,readRelease:()=> 'pub\n'}).some((h)=>h.startsWith('excluded path present')))throw Error('public-cut negative control passed: excluded path in the cut');
 if(!cutViolations({source:src,release:exact,list,readSource,readRelease:readSource}).some((h)=>h.startsWith('private-launch section left')))throw Error('public-cut negative control passed: section left in the cut');
 const changed=new Map([...exact,['app.ts',{mode:'100644',sha:'tampered'}]]);
 if(!cutViolations({source:src,release:changed,list,readSource,readRelease:()=> 'pub\n'}).some((h)=>h.startsWith('content differs')))throw Error('public-cut negative control passed: changed content');
 if(!cutViolations({source:new Map(),release:new Map(),list,readSource,readRelease:readSource}).length)throw Error('public-cut negative control passed: empty source');
 console.log('public-cut self-test: 15 exclude-list/section/cut RED controls and 3 clean controls passed');
 // The repo-boundary self-test (its controls, then a boundary check of the working tree).
 execFileSync(process.execPath,[resolve(root,'scripts/check-repo-boundary.mjs'),'--self-test'],{stdio:'inherit'});
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [command,directory]=process.argv.slice(2);const argv=process.argv.slice(2);
 if(command==='selftest')selftest();
 else if(command==='dry-run')dryRun(argv);
 else if(command==='check'&&directory&&directory!=='--exclude')checkRelease(directory,argv);
 else if(command==='make'&&directory&&directory!=='--exclude')make(directory,argv);
 else throw Error('usage: public-cut.mjs dry-run | make <dir> | check <dir> [--exclude <file>] | selftest');
}
