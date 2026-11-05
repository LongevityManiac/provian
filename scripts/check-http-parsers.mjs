// Discover production parser mounts from their actual TypeScript source; run
// each expression against its service's locked dependency tree in a child.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const files = ['provian-backend/src/server.ts', 'provian-backend/src/routes/bootstrap.ts', 'provian-facilitator/src/app.ts'];
let count = 0;
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const expressions = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'express.json') expressions.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!expressions.length) throw new Error(`No parsers evaluated: ${file}`);
  for (const [index, expression] of expressions.entries()) {
    const service = file.split('/')[0];
    const lock = JSON.parse(fs.readFileSync(path.join(root, service, 'package-lock.json')));
    const expected = service === 'provian-backend' ? '1.20.9' : '2.4.0';
    const versions = Object.entries(lock.packages).filter(([key]) => key.endsWith('node_modules/body-parser')).map(([, pkg]) => pkg.version);
    if (!versions.length || versions.some(v => v !== expected)) throw new Error(`${service}: unpatched parsers ${versions}`);
    const parser = ts.transpile(`const parser = ${expression}`, { module: ts.ModuleKind.CommonJS });
    const script = `
      const express = require(${JSON.stringify(path.join(root, service, 'node_modules/express'))});
      const http = require('node:http'), zlib = require('node:zlib'), assert = require('node:assert/strict');
      const METER_BATCH_BODY_LIMIT = '5mb', ARCHIVE_PART_BODY_LIMIT = '53mb';
      ${parser}
      const app = express(); app.use(parser); app.post('/probe', (q,s) => s.json({ok:true}));
      app.get('/alive', (q,s) => s.end('alive'));
      app.use((e,q,s,n) => s.status(e.status || 500).end());
      const server = app.listen(0, '127.0.0.1', async () => {
        const request = (payload, encoding) => new Promise((resolve,reject) => {
          const req = http.request({host:'127.0.0.1',port:server.address().port,path:'/probe',method:'POST',headers:{'Content-Type':'application/json',...(encoding ? {'Content-Encoding':encoding} : {}),'Content-Length':payload.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}); req.on('error',reject);req.end(payload);
        });
        try {
          for (const [encoding, compress] of [['gzip',zlib.gzipSync],['deflate',zlib.deflateSync],['br',zlib.brotliCompressSync]]) {
            const payload = Buffer.concat([compress(Buffer.from('{"a":1}')),Buffer.from([0]),Buffer.alloc(100*1024,0x58)]);
            assert.equal(await request(payload, encoding), 415);
            await new Promise(r=>setTimeout(r,30));
            assert.equal(await request(Buffer.from('{"a":1}')), 200);
          }
          server.close(()=>process.exit(0));
        } catch(e) { console.error(e);process.exit(1); }
      }); setTimeout(()=>process.exit(2),5000).unref();`;
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${file} parser ${index}: exit ${code}\n${output}`)));
    });
    count++;
    console.log(`PASS ${file} parser ${index + 1}: gzip/deflate/br refused, subsequent JSON served`);
  }
}
if (count !== 5) throw new Error(`Parser inventory changed: reviewed 5, evaluated ${count}`);
console.log(`PASS ${count} production parser mounts; patched lockfiles`);
