/**
 * PE METER : the relay keeps no PEs, so every single-PE recorder is
 * retired. A device sends its PEs as one signed daily batch to `/v1/meter/batch` (device key); the
 * phone to `/v1/meter/batch/mobile` (wallet auth). The old handlers are deleted; each retired path
 * answers 410 with a pointer to its successor.
 *
 * Mounted in server.ts ahead of the runtime boundary quarantine and every auth middleware, so a retired path
 * touches nothing — no auth, no DB, no signer — before it refuses.
 */

import type { Express, Request, Response } from 'express';

export const METER_RETIRED_RECORDERS: Readonly<Record<string, string>> = Object.freeze({
  '/v1/pe/submit': '/v1/meter/batch',
  '/v1/pe/submit/mobile': '/v1/meter/batch/mobile',
  '/v1/relay/action': '/v1/meter/batch/mobile',
  '/v1/relay/work-product': '/v1/meter/batch/mobile',
});

export function mountRetiredRecorders(app: Express): void {
  for (const [retired, successor] of Object.entries(METER_RETIRED_RECORDERS)) {
    app.post(retired, (_req: Request, res: Response) => {
      res.status(410).json({
        error: 'pe_recorder_retired',
        message: 'The relay keeps no PEs. PEs are kept by their owner and sent as one signed batch a day.',
        use: successor,
      });
    });
  }
}
