import { describe, it, expect } from 'vitest';
import { resolveAgentDetailSource } from './agentDetailResolve';

const ATLAS = 'atlas';
const OTHER = 'other';

describe('resolveAgentDetailSource (linked records only)', () => {
  it('resolves a linked agent by index', () => {
    expect(resolveAgentDetailSource(ATLAS, [OTHER, ATLAS])).toEqual({ source: 'linked', linkedIndex: 1 });
  });

  it('returns not_found when the agent is not linked to this human', () => {
    expect(resolveAgentDetailSource(ATLAS, [OTHER])).toEqual({ source: 'not_found' });
  });

  it('returns not_found over an empty list', () => {
    expect(resolveAgentDetailSource(ATLAS, [])).toEqual({ source: 'not_found' });
  });
});
