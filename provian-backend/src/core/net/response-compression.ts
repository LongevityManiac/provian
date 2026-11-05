import compression from 'compression';
import type {RequestHandler} from 'express';

/** Compress negotiated, read-only record/list responses. Credential/bootstrap issuance,
 * signatures, writes, RPC passthroughs and streaming responses retain their original framing. */
export function recordResponseCompression(): RequestHandler {
  return compression({threshold:1024,level:1,filter:(req,res)=>{
    if (req.method !== 'GET' || res.statusCode < 200 || res.statusCode >= 300) return false;
    const path=req.originalUrl.split('?')[0];
    const recordRead=path==='/v1/pvt/history'||path==='/v1/pvt/accrual'||
      /^\/v1\/meter\/(?:mobile\/)?proofs$/.test(path)||/^\/v1\/commons\//.test(path);
    return recordRead && !res.getHeader('Set-Cookie') && compression.filter(req,res);
  }});
}
