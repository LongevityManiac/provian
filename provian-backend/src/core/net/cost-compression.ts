import compression from 'compression';
import type { Request, Response } from 'express';

/** Compress the measured large, non-secret responses. Archive ciphertext is incompressible;
 * wallet/auth/presentation responses retain their existing wire representation. */
export function costCompression() {
  return compression({
    threshold: 1024,
    level: 4,
    filter: (req: Request, res: Response) => {
      const path = req.originalUrl.split('?')[0]; // Mounted routers strip req.path before headers are sent.
      const eligible = path === '/v1/bootstrap/agent.js'
        || path.startsWith('/api/proxy/alchemy/rpc/');
      return eligible && compression.filter(req, res);
    },
  });
}
