import express from 'express';
import request from 'supertest';
import { gzipSync } from 'zlib';
import { costCompression } from './cost-compression';

it('cuts response bytes with identical decoded JSON/JS and respects identity/no-transform/small bodies', async () => {
  const app = express();
  app.use(costCompression());
  const payload = { snapshots: Array.from({ length: 500 }, (_, i) => ({ id: i, status: 'complete', amount: '123456789000000000000' })) };
  app.get('/api/proxy/alchemy/rpc/overview', (_req, res) => res.json(payload));
  const js = 'const proof = "public-bootstrap-content";\n'.repeat(2000);
  app.get('/v1/bootstrap/agent.js', (_req, res) => res.type('js').send(js));
  app.get('/api/proxy/alchemy/rpc/base', (_req, res) => res.set('Cache-Control', 'no-transform').json(payload));
  app.get('/api/proxy/alchemy/rpc/small', (_req, res) => res.json({ ok: true }));
  app.get('/v1/wallet/export', (_req, res) => res.json(payload));
  const zipped = await request(app).get('/api/proxy/alchemy/rpc/overview').set('Accept-Encoding', 'gzip');
  expect(zipped.body).toEqual(payload);
  expect(zipped.headers['content-encoding']).toBe('gzip');
  expect(zipped.headers.vary).toContain('Accept-Encoding');
  const plain = await request(app).get('/api/proxy/alchemy/rpc/overview').set('Accept-Encoding', 'identity');
  expect(plain.body).toEqual(payload);
  expect(plain.headers['content-encoding']).toBeUndefined();
  expect(gzipSync(JSON.stringify(payload), { level: 4 }).length).toBeLessThan(Buffer.byteLength(JSON.stringify(payload)) / 5);
  const bootstrap = await request(app).get('/v1/bootstrap/agent.js').set('Accept-Encoding', 'gzip');
  expect(bootstrap.text).toBe(js);
  expect(bootstrap.headers['content-encoding']).toBe('gzip');
  for (const path of ['/api/proxy/alchemy/rpc/base', '/api/proxy/alchemy/rpc/small', '/v1/wallet/export']) {
    expect((await request(app).get(path).set('Accept-Encoding', 'gzip')).headers['content-encoding']).toBeUndefined();
  }
});

it('compresses mounted routers using the original route, including query strings',async()=>{
 const app=express();app.use(costCompression());const js='const immutable = "signed public bytes";\n'.repeat(5000);
 const bootstrap=express.Router();bootstrap.get('/agent.js',(_req,res)=>res.type('js').send(js));app.use('/v1/bootstrap',bootstrap);
 const dashboard=express.Router();dashboard.get('/overview',(_req,res)=>res.json({records:js}));app.use('/api/proxy/alchemy/rpc',dashboard);
 const rpc=express.Router();rpc.post('/base',(_req,res)=>res.json({result:js}));app.use('/api/proxy/alchemy/rpc',rpc);
 const bundle=await request(app).get('/v1/bootstrap/agent.js?version=68').set('Accept-Encoding','gzip');expect(bundle.headers['content-encoding']).toBe('gzip');expect(bundle.text).toBe(js);
 expect((await request(app).get('/api/proxy/alchemy/rpc/overview').set('Accept-Encoding','gzip')).headers['content-encoding']).toBe('gzip');
 expect((await request(app).post('/api/proxy/alchemy/rpc/base').set('Accept-Encoding','gzip')).headers['content-encoding']).toBe('gzip');
});
