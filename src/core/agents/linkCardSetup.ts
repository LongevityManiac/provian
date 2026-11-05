/**
 * The paste-ready message the human sends their agent to set up card spending
 * through Stripe Link's wallet for agents.
 *
 * Agent-facing, so it stays English (the sheet around it is translated). It
 * uses only Link CLI facts on file (reference_stripe_link_cli_facts; the
 * wallet-simplification brief): `npm i -g @stripe/link-cli`, the device
 * authorization flow `link-cli auth login --interval 5`, `link-cli auth status
 * --format json`, spend requests approved by the human in Link
 * (`--request-approval`), `--format json` for parseable output, amounts in
 * cents up to 50000, `--include card` + `--output-file` so a card lands in a
 * private file instead of stdout, and `--test` for a no-charge run.
 *
 * It never tells the agent to report the spend to Provian: an agent's own
 * claim about its work is never a PE (standing principle / ).
 * A spend is recorded only where Provian's observer on the agent's computer
 * witnesses the Link CLI result.
 */

export const LINK_CARD_SETUP_MESSAGE = [
    'Set up Stripe Link so you can pay with my card when a task needs it.',
    '',
    '1. Install the Link CLI:',
    '   npm i -g @stripe/link-cli',
    '2. Authorize it with my Link account:',
    '   link-cli auth login --interval 5',
    '   Send me the URL and code it prints. I will approve it in Link.',
    '3. Check that it worked (expect "authenticated"):',
    '   link-cli auth status --format json',
    '',
    'When a purchase needs my card, create a spend request with `link-cli spend-request`',
    '(`link-cli spend-request --help` lists its options). Always pass --request-approval so I',
    'approve each spend in Link, and --format json so you can read the result. Amounts are in',
    'cents, up to 50000. If you need the card itself, use --include card with --output-file so it',
    'is written to a private file. Never print, log, or paste card details anywhere, including',
    'this chat. To try the flow without charging anything, add --test.',
].join('\n');
