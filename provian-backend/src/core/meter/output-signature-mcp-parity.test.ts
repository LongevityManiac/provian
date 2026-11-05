/**
 * The MCP tool core (mirrored into the relay, no crypto dependency) restates three output-signature
 * literals; they must equal the ONE definition in `output-signature.ts`. RED control: a drifted
 * literal is reported (the comparison runs over a non-empty set).
 */
import {
  OUTPUT_SIGNATURE_HEADER,
  OUTPUT_SIGNATURE_JSON_KEY,
  OUTPUT_SIGNATURE_MESSAGE_PREFIX,
} from './output-signature';
import {
  OUTPUT_SIGNATURE_HEADER_MCP,
  OUTPUT_SIGNATURE_JSON_KEY_MCP,
  OUTPUT_SIGNATURE_MESSAGE_PREFIX_MCP,
} from '../../mcp/core/tools';

function drifted(pairs: ReadonlyArray<readonly [string, string, string]>): string[] {
  return pairs.filter(([, a, b]) => a !== b).map(([name]) => name);
}

describe('MCP output-signature literals equal the one definition', () => {
  const pairs = [
    ['message_prefix', OUTPUT_SIGNATURE_MESSAGE_PREFIX_MCP, OUTPUT_SIGNATURE_MESSAGE_PREFIX],
    ['header', OUTPUT_SIGNATURE_HEADER_MCP, OUTPUT_SIGNATURE_HEADER],
    ['json_key', OUTPUT_SIGNATURE_JSON_KEY_MCP, OUTPUT_SIGNATURE_JSON_KEY],
  ] as const;

  it('every literal matches', () => {
    expect(pairs.length).toBe(3);
    expect(drifted(pairs)).toEqual([]);
  });

  it('RED — a drifted literal is reported', () => {
    expect(drifted([['message_prefix', 'provian-output:v2:', OUTPUT_SIGNATURE_MESSAGE_PREFIX]])).toEqual(['message_prefix']);
  });
});
