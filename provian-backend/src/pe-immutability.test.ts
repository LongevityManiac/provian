/**
 * PE Immutability Backend Tests
 *
 * Verifies that:
 * 1. DELETE /v1/provenance-envelopes/:peId returns 403
 * 2. PATCH /v1/provenance-envelopes/:peId/hidden answers 410 pe_kept_by_owner (PE meter)
 * 3. PATCH writes nothing (the relay keeps no PEs to flag)
 */

describe('PE Immutability Backend', () => {
    // These are structural tests that verify the route handlers exist
    // and have the correct behavior. Full integration tests require
    // a running Firestore emulator.

    describe('DELETE /v1/provenance-envelopes/:peId', () => {
        it('is hardcoded to return 403', () => {
            // The route handler is:
            // app.delete('/v1/provenance-envelopes/:peId', authenticate, (_req, res) => {
            //   res.status(403).json({ error: 'Provenance Envelopes are immutable and cannot be deleted.' });
            // });
            //
            // Verify by checking the server source includes the 403 block.
            const fs = require('fs');
            const serverSource = fs.readFileSync(
                require('path').join(__dirname, 'server.ts'),
                'utf-8'
            );

            // Verify the delete route exists and returns 403
            expect(serverSource).toContain("app.delete('/v1/provenance-envelopes/:peId'");
            expect(serverSource).toContain('Provenance Envelopes are immutable and cannot be deleted.');
            expect(serverSource).toContain('res.status(403)');
        });
    });

    describe('PATCH /v1/provenance-envelopes/:peId/hidden', () => {
        // PE METER : the relay keeps no PEs, so there is no stored
        // envelope to flag. Hiding is a display choice on the owner's device; the route answers
        // 410 pe_kept_by_owner and writes nothing.
        const fs = require('fs');
        const serverSource: string = fs.readFileSync(require('path').join(__dirname, 'server.ts'), 'utf-8');
        /** The PATCH handler's own source, up to the next route registration. */
        function patchHandlerSource(source: string): string {
            const start = source.indexOf("app.patch('/v1/provenance-envelopes/:peId/hidden'");
            if (start < 0) return '';
            const next = source.indexOf('\napp.', start + 1);
            return source.slice(start, next < 0 ? undefined : next);
        }

        it('endpoint exists in server source and answers pe_kept_by_owner', () => {
            const handler = patchHandlerSource(serverSource);
            expect(handler.length).toBeGreaterThan(0);
            expect(handler).toContain('authenticate');
            expect(handler).toContain('sendPeKeptByOwner(res');
        });

        it('writes nothing — no Firestore update, no envelope read', () => {
            const handler = patchHandlerSource(serverSource);
            expect(handler.length).toBeGreaterThan(0);
            for (const forbidden of ['.update(', '.set(', "provenance_envelopes')", 'PROVENANCE_ENVELOPES', 'db.collection']) {
                expect(handler).not.toContain(forbidden);
            }
        });

        // RED CONTROL: the extractor + forbidden list catch the pre-meter handler shape, so the
        // test above is not vacuous.
        it('RED: the pre-meter handler shape (an envelope update) is caught', () => {
            const preMeter = "app.patch('/v1/provenance-envelopes/:peId/hidden', authenticate, async (req, res) => {\n"
                + "  const peData = (await db.collection('provenance_envelopes').doc(peId).get()).data();\n"
                + "  await db.collection('provenance_envelopes').doc(peId).update({ hidden });\n});\napp.get('/x', h);";
            const handler = patchHandlerSource(preMeter);
            expect(handler).not.toContain("app.get('/x'");
            expect(['.update(', 'db.collection'].some((f) => handler.includes(f))).toBe(true);
        });
    });

    describe('Firestore Security Rules', () => {
        it('firestore.rules denies all client writes (PE deletion blocked via universal deny)', () => {
            const fs = require('fs');
            const rulesPath = require('path').join(__dirname, '..', 'firestore.rules');
            const rules = fs.readFileSync(rulesPath, 'utf-8');

            // [SEC-audit-4.2] All collections are server-write-only (Admin SDK only).
            // This is stricter than the previous per-collection rules - client deletes
            // of PEs (and any other document) are blocked by the universal deny.
            expect(rules).toContain('allow read, write: if false;');
        });
    });
});
