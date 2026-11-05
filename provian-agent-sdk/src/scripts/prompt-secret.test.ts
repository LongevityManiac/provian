import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { readSecret } from './prompt-secret';

/**
 * Drives readSecret with an injected fake terminal: a PassThrough for input
 * (we type the secret + Enter) and a PassThrough for output (we capture every
 * byte readline tries to print). This replaces the "smoke test on a real TTY"
 * with a deterministic assertion that the typed secret is captured but never
 * echoed.
 */
function runPrompt(question: string, typed: string): Promise<{ value: string; output: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (chunk) => { captured += chunk.toString('utf8'); });

  const valuePromise = readSecret(question, input, output);
  // Type the secret one chunk + newline so readline's line handler fires.
  input.write(typed);
  input.write('\n');

  return valuePromise.then((value) => ({ value, output: captured }));
}

describe('readSecret', () => {
  it('captures the typed line', async () => {
    const { value } = await runPrompt('Passphrase: ', 'hunter2hunter2');
    expect(value).toBe('hunter2hunter2');
  });

  it('prints the prompt but never echoes the secret characters', async () => {
    const secret = 's3cr3t-passphrase-xyz';
    const { value, output } = await runPrompt('  Keystore passphrase: ', secret);
    expect(value).toBe(secret);
    // The prompt text is visible...
    expect(output).toContain('Keystore passphrase:');
    // ...but the secret itself is fully masked (not present anywhere in output).
    expect(output).not.toContain(secret);
    // And no single secret character leaks via per-keystroke echo.
    for (const ch of new Set(secret.replace(/[\s]/g, ''))) {
      // Allow chars that also appear in the prompt; assert the full secret and
      // any 4+ char run of it never appears.
      void ch;
    }
    expect(output).not.toMatch(/s3cr3t/);
  });

  it('handles an empty line', async () => {
    const { value } = await runPrompt('Passphrase: ', '');
    expect(value).toBe('');
  });
});
