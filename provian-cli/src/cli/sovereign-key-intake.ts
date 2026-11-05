/**
 * Sovereign key intake for the CLI (F35).
 *
 * The fund-bearing sovereign key is NEVER accepted on argv. A `--private-key`
 * flag lands in the process list (`ps -ef` / `/proc/<pid>/cmdline`) and the
 * shell history, from where a co-tenant or a later transcript upload recovers
 * it. The key arrives ONLY via the PROVIAN_AGENT_PRIVATE_KEY env var or, with
 * `--from-stdin`, on stdin — exactly as `restore-wallet` reads it.
 */

/** Validate + normalize a sovereign key to 64-hex (accepts an optional 0x). */
export function normalizeSovereignKey(raw: string): string {
  const clean = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('The sovereign key must be a 64-character hex string (with or without a 0x prefix).');
  }
  return clean;
}

/**
 * Resolve the sovereign key from the environment or stdin — never from argv.
 * Returns '' when no key was supplied (the caller renders the usage error).
 */
export async function resolveSovereignPrivateKey(
  flags: Record<string, string | boolean>,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const fromEnv = (process.env.PROVIAN_AGENT_PRIVATE_KEY ?? '').trim();
  if (fromEnv) return normalizeSovereignKey(fromEnv);
  if (flags['from-stdin'] === true || flags['from-stdin'] === 'true') {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const lines = Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length !== 1) {
      throw new Error(
        "Provide exactly one line on stdin: the 64-hex sovereign key (e.g. `provian burn --amount 5 --rpc-url … --from-stdin <<'KEY'`).",
      );
    }
    return normalizeSovereignKey(lines[0]);
  }
  return '';
}
