import {test} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const checker=fileURLToPath(new URL('./check-sdk-typecheck.mjs',import.meta.url));
test('pushed test-source errors fail even when the current working copy is fixed',()=>{
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'sdk-gate-control-'));
 try{
  const git=args=>execFileSync('git',args,{cwd:fixture,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-q']);git(['config','user.email','fixture@example.invalid']);git(['config','user.name','Gate fixture']);
  const sdk=path.join(fixture,'provian-agent-sdk');fs.mkdirSync(path.join(sdk,'src'),{recursive:true});
  fs.symlinkSync(fs.realpathSync(fileURLToPath(new URL('../provian-agent-sdk/node_modules',import.meta.url))),path.join(sdk,'node_modules'),'dir');
  fs.writeFileSync(path.join(fixture,'.gitignore'),'node_modules\n');
  fs.writeFileSync(path.join(sdk,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,skipLibCheck:true,types:[],target:'ES2020'},include:['src/**/*']}));
  fs.writeFileSync(path.join(sdk,'tsconfig.build.json'),JSON.stringify({extends:'./tsconfig.json',exclude:['**/*.test.ts']}));
  const source=path.join(sdk,'src/control.test.ts');fs.writeFileSync(source,'const testOnly: number = "wrong";\n');
  git(['add','.']);git(['commit','-qm','Test-source violation']);const bad=git(['rev-parse','HEAD']);
  fs.writeFileSync(source,'const testOnly: number = 7;\n');
  const run=rev=>spawnSync(process.execPath,[checker,...(rev?['--rev',rev]:[])],{cwd:fixture,encoding:'utf8'});
  assert.equal(run().status,0,'fixed working copy is green');
  const rejected=run(bad);assert.notEqual(rejected.status,0);assert.match(rejected.stdout,/TS2322/);
  git(['add','.']);git(['commit','-qm','Fix fixture']);assert.equal(run(git(['rev-parse','HEAD'])).status,0);
 }finally{fs.rmSync(fixture,{recursive:true,force:true});}
});
