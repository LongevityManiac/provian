import express from 'express';
import request from 'supertest';
import {recordResponseCompression} from './response-compression';
import {gzipSync} from 'zlib';
it('large record JSON has identical decoded bytes with negotiated gzip, and smaller transfer bytes',async()=>{
 const app=express();app.use(recordResponseCompression());
 const body={history:Array.from({length:200},(_,i)=>({id:'act_'+i,action_type:'agent_action',status:'sealed',record_points_atomic:'1234567890123456789',timestamp:1788800000000+i}))};
 app.get('/v1/pvt/history',(_req,res)=>res.json(body));
 const compressed=await request(app).get('/v1/pvt/history').set('Accept-Encoding','gzip');
 const plain=await request(app).get('/v1/pvt/history').set('Accept-Encoding','identity');
 expect(compressed.headers['content-encoding']).toBe('gzip');expect(plain.headers['content-encoding']).toBeUndefined();expect(compressed.body).toEqual(plain.body);expect(compressed.body).toEqual(body);
 const original=Buffer.from(JSON.stringify(body)),wire=gzipSync(original,{level:1});expect(wire.length).toBeLessThan(original.length/5);
});
it('credential issuance, writes, errors, no-transform and unnegotiated responses stay untouched',async()=>{
 const app=express();app.use(recordResponseCompression());const body={secret:'x'.repeat(3000)};
 app.get('/v1/wallet/recovery',(_req,res)=>res.json(body));app.post('/v1/pvt/history',(_req,res)=>res.json(body));
 app.get('/v1/commons/error',(_req,res)=>res.status(503).json(body));app.get('/v1/commons/raw',(_req,res)=>res.set('Cache-Control','no-transform').json(body));
 for(const res of [await request(app).get('/v1/wallet/recovery').set('Accept-Encoding','gzip'),await request(app).post('/v1/pvt/history').set('Accept-Encoding','gzip'),await request(app).get('/v1/commons/error').set('Accept-Encoding','gzip'),await request(app).get('/v1/commons/raw').set('Accept-Encoding','gzip')])expect(res.headers['content-encoding']).toBeUndefined();
});

it('mounted Commons router compresses using the original path, including a query string',async()=>{
 const app=express(),router=express.Router();app.use(recordResponseCompression());
 const body={events:Array.from({length:100},(_,i)=>({id:i,text:'public Commons event '.repeat(20)}))};
 router.get('/feed',(_req,res)=>res.json(body));app.use('/v1/commons',router);
 const result=await request(app).get('/v1/commons/feed?limit=100').set('Accept-Encoding','gzip');
 expect(result.headers['content-encoding']).toBe('gzip');expect(result.body).toEqual(body);
});
