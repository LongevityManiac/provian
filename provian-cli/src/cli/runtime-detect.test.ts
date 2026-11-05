/**
 * Unit tests for runtime detection. Detection is pure (fs + env injected), so
 * these assert the branch logic directly without touching the real machine.
 */

import { describe, it, expect } from 'vitest';
import { detectRuntime, type DetectContext } from './runtime-detect';

function ctx(over: { files?: string[]; env?: Record<string, string | undefined> }): DetectContext {
  const files = new Set(over.files ?? []);
  return {
    cwd: '/tmp/project',
    env: over.env ?? {},
    fileExists: (p) => files.has(p),
  };
}

describe('detectRuntime', () => {
  it('detects Claude Code from the CLAUDECODE env var (cli channel)', () => {
    const w = detectRuntime(ctx({ env: { CLAUDECODE: '1' } }));
    expect(w.id).toBe('claude-code');
    expect(w.channel).toBe('cli');
    expect(w.confidence).toBe('high');
  });

  it('detects a Node/TypeScript project from package.json (sdk channel)', () => {
    const w = detectRuntime(ctx({ files: ['package.json'] }));
    expect(w.id).toBe('node-sdk');
    expect(w.channel).toBe('sdk');
    expect(w.confidence).toBe('high');
  });

  it('detects a Python project from requirements.txt (cli channel)', () => {
    const w = detectRuntime(ctx({ files: ['requirements.txt'] }));
    expect(w.id).toBe('python');
    expect(w.channel).toBe('cli');
    expect(w.confidence).toBe('high');
  });

  it('detects a Python project from pyproject.toml', () => {
    const w = detectRuntime(ctx({ files: ['pyproject.toml'] }));
    expect(w.id).toBe('python');
  });

  it('falls back to the portable CLI path with low confidence when nothing matches', () => {
    const w = detectRuntime(ctx({}));
    expect(w.id).toBe('cli');
    expect(w.channel).toBe('cli');
    expect(w.confidence).toBe('low');
  });

  it('prefers a strong env signal over a file signal', () => {
    const w = detectRuntime(ctx({ env: { CLAUDECODE: '1' }, files: ['package.json'] }));
    expect(w.id).toBe('claude-code');
  });

  it('treats CLAUDECODE=0 / false as unset', () => {
    expect(detectRuntime(ctx({ env: { CLAUDECODE: '0' }, files: ['package.json'] })).id).toBe('node-sdk');
    expect(detectRuntime(ctx({ env: { CLAUDECODE: 'false' }, files: ['package.json'] })).id).toBe('node-sdk');
  });
});
