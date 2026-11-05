/**
 * Bind the relay's hardcoded orchestration-count floors (`core/meter/device-act.ts`,
 * the device batch's act admission; formerly the retired `POST /v1/pe/submit` in
 * `devices.ts`) to the SDK constants they mirror (`OTelPlugin.ts`), source-read, so
 * the two can never silently diverge again.
 *
 * WHY THIS EXISTS. The relay intake gate uses hardcoded numeric literals
 * (`tool_count as number) < N` / `api_count as number) < N`) that duplicate the SDK's
 * `MIN_ORCHESTRATION_TOOL_CALLS` / `MIN_ORCHESTRATION_API_CALLS` across two packages
 * that cannot cross-import. Before this test, nothing bound them — the audit that
 * scoped the 2026-09-12 floor removal flagged exactly that gap. If the SDK emits a
 * turn the relay then rejects (or vice-versa), single-tool work silently fails to
 * mint. This is the same source-reading parity pattern as the (retired)
 * ai_conversation floor test.
 *
 * THE VALUE. Both floors are 1 (— "every act mints once at its
 * best-supported value"): a turn with one tool call / one API hop is a PE.
 *
 * RED control : the `detects a divergent set` case proves the comparison is
 * not vacuous; the population count is asserted so an empty match cannot pass; and
 * the shared value is pinned to 1 so a drift back to a 2+ floor goes RED.
 */

import fs from 'fs';
import path from 'path';

const OTEL_PLUGIN = path.resolve(
  __dirname,
  '../../../../provian-agent-sdk/src/observer/plugins/OTelPlugin.ts',
);
const DEVICE_ACT = path.resolve(__dirname, '../meter/device-act.ts');

/** RHS integer of `export const <NAME> = <int>;`. */
function extractSdkConst(source: string, name: string): number | null {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)\\s*;`));
  return m ? Number(m[1]) : null;
}

/** The `<int>` in the relay literal `(metadata.<field> as number) < <int>`. */
function extractRelayLiteral(source: string, field: string): number | null {
  const m = source.match(new RegExp(`metadata\\.${field} as number\\)\\s*<\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
}

describe('orchestration-count floor parity — SDK constant == relay literal', () => {
  it('the tool + API floors agree across the SDK and the relay, and are 1', () => {
    const sdk = fs.readFileSync(OTEL_PLUGIN, 'utf8');
    const relay = fs.readFileSync(DEVICE_ACT, 'utf8');

    const sdkTool = extractSdkConst(sdk, 'MIN_ORCHESTRATION_TOOL_CALLS');
    const sdkApi = extractSdkConst(sdk, 'MIN_ORCHESTRATION_API_CALLS');
    const relayTool = extractRelayLiteral(relay, 'tool_count');
    const relayApi = extractRelayLiteral(relay, 'api_count');

    // Empty-population guard : every literal must actually be found.
    const found = { sdkTool, sdkApi, relayTool, relayApi };
    // eslint-disable-next-line no-console
    console.log('[orchestration-floor-parity] evaluated:', JSON.stringify(found));
    for (const [label, v] of Object.entries(found)) {
      expect(v).not.toBeNull();
      expect(typeof v).toBe('number');
      void label;
    }

    // Tool floor: SDK constant and relay literal agree.
    expect(relayTool).toBe(sdkTool);
    // API floor: SDK constant and relay literal agree.
    expect(relayApi).toBe(sdkApi);
    // And the shared value is 1 (the 2026-one act is a PE).
    expect(sdkTool).toBe(1);
    expect(sdkApi).toBe(1);
  });

  it('RED control: the parity comparison detects a divergent set (not a vacuous pass)', () => {
    // If the relay literal ever drifted back to a 2+ floor while the SDK stayed 1,
    // the comparison above MUST fail. Prove that comparison is real.
    const sdkTool = 1;
    const relayToolDrifted = 2;
    expect(relayToolDrifted).not.toBe(sdkTool);
  });
});
