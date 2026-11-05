import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseGitRepoPaths } from './run-daemon';

describe('parseGitRepoPaths', () => {
  it('returns [] for unset / empty', () => {
    expect(parseGitRepoPaths(undefined)).toEqual([]);
    expect(parseGitRepoPaths('')).toEqual([]);
    expect(parseGitRepoPaths('   ')).toEqual([]);
  });

  it('splits on commas and newlines and resolves to absolute paths', () => {
    const out = parseGitRepoPaths('/a/b, /c/d\n/e/f');
    expect(out).toEqual([path.resolve('/a/b'), path.resolve('/c/d'), path.resolve('/e/f')]);
  });

  it('splits on the OS path delimiter', () => {
    const out = parseGitRepoPaths(['/a/b', '/c/d'].join(path.delimiter));
    expect(out).toEqual([path.resolve('/a/b'), path.resolve('/c/d')]);
  });

  it('trims whitespace and drops empty segments', () => {
    expect(parseGitRepoPaths(' /a ,, \n , /b ')).toEqual([path.resolve('/a'), path.resolve('/b')]);
  });

  it('resolves relative paths against cwd', () => {
    expect(parseGitRepoPaths('rel/dir')).toEqual([path.resolve('rel/dir')]);
  });
});
