#!/usr/bin/env node
/** Check the SDK base config, including tests. --rev checks the actual pushed
 * tree, even when the shared checkout contains other uncommitted work. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
const i=process.argv.indexOf('--rev');
let checkout=root,temporary;
try {
  if(i>=0){
    const rev=process.argv[i+1];
    if(!rev)throw new Error('--rev requires a commit');
    const commit=execFileSync('git',['rev-parse','--verify',`${rev}^{commit}`],{cwd:root,encoding:'utf8'}).trim();
    temporary=fs.mkdtempSync(path.join(os.tmpdir(),'provian-sdk-typecheck-'));
    const archive=path.join(temporary,'source.tar');checkout=path.join(temporary,'tree');fs.mkdirSync(checkout);
    execFileSync('git',['archive','--format=tar',`--output=${archive}`,commit],{cwd:root});
    execFileSync('tar',['-xf',archive,'-C',checkout]);
    for(const rel of ['node_modules','provian-agent-sdk/node_modules']){
      const modules=path.join(root,rel);
      if(fs.existsSync(modules))fs.symlinkSync(fs.realpathSync(modules),path.join(checkout,rel),'dir');
    }
    console.log(`SDK typecheck: pushed tree ${commit.slice(0,12)}`);
  }
  const sdk=path.join(checkout,'provian-agent-sdk');
  const compiler=path.join(sdk,'node_modules/typescript/bin/tsc');
  if(!fs.existsSync(compiler))throw new Error('SDK dependencies missing; install them before pushing');
  const result=spawnSync(process.execPath,[compiler,'--noEmit','-p','tsconfig.json'],{cwd:sdk,stdio:'inherit'});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
} catch(error){console.error(error.message);process.exitCode=1;}
finally {if(temporary)fs.rmSync(temporary,{recursive:true,force:true});}
