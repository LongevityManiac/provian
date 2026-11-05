/**
 * /daemon page copy — the ONE content source, rendered two ways.
 *
 * Renderers:
 *   1. `src/app/daemon/page.tsx` — the Next route (auth-gated pre-flip; takes
 *      over publicly at the launch flip).
 *   2. `scripts/build-public-legal.mjs` — transpiles THIS file with the
 *      TypeScript compiler API and renders `public/legal/daemon.html`, the
 *      SELF-CONTAINED public copy nginx serves with `auth_basic off`. The
 *      app's Earn tab links to https://provian.ai/daemon, which must resolve
 *      publicly before the flip without weakening the auth wall.
 *
 * Exactly the privacy.md precedent: one source, two renderings, so the public
 * copy cannot drift from the gated one.
 *
 * KEEP THIS MODULE DEPENDENCY-FREE: exported data and types only — no imports,
 * no JSX, no runtime logic. The public builder imports this file directly; an
 * import added here would break `node scripts/build-public-legal.mjs`. Icon
 * choices are presentation, not content — they live in page.tsx, keyed by
 * `icon` below.
 *
 * COPY RULE (CLAUDE.md Security Invariant #1 — two keys, never conflate them):
 * never describe the secp256k1 wallet key as hardware-held. It lives in the
 * Provian app, encrypted on the phone, and leaves the device only as
 * backup-password-encrypted ciphertext; only the P-256 device/PE attestation key is
 * hardware-bound, and it identifies the device, not the wallet. The custody
 * bullet below is worded accordingly — do not reintroduce a secure-hardware
 * custody claim for wallet keys.
 */

export interface DaemonSection {
  readonly eyebrow: string
  readonly heading: string
}

export const DAEMON_META = {
  title: 'Desktop App | Provian',
  description:
    'The Provian desktop app is a small background program that witnesses the work your computer already does and turns it into receipts you own. Only signed metadata ever leaves your machine.',
} as const

export const DAEMON_HERO = {
  eyebrow: 'The desktop app',
  heading: 'Your computer already does the work.',
  lede: 'The Provian desktop app is a small program that runs in the background and witnesses the work your computer already does. Each session leaves a receipt you own, and each receipt mints PVT once, at the value its evidence supports. Nothing you write or make ever leaves your computer: only signed metadata does.',
  aside:
    'It witnesses that you worked, never what you wrote. Content stays home; proof travels.',
} as const

export type DaemonWitnessIcon = 'GitBranch' | 'Sparkles' | 'Cpu'

export interface DaemonWitness {
  readonly icon: DaemonWitnessIcon
  readonly title: string
  readonly body: string
  readonly aside?: string
}

export const DAEMON_WITNESSES_SECTION: DaemonSection = {
  eyebrow: 'What it witnesses',
  heading: 'Four kinds of work, one witness.',
}

export const DAEMON_WITNESSES: readonly DaemonWitness[] = [
  {
    icon: 'GitBranch',
    title: 'Coding sessions',
    body: 'Every local commit is witnessed as you make it: files changed, lines added, nothing more. Pair it with the GitHub, GitLab, or Bitbucket connector and a commit seen by both mints once, at the better-supported value.',
    aside: 'Money finally grows on worktrees.',
  },
  {
    icon: 'Sparkles',
    title: 'AI sessions',
    body: 'AI chats and model calls on your computer leave receipts: how much and how long, never what you said or what came back.',
  },
  {
    icon: 'Cpu',
    title: 'Compute sessions',
    body: 'Background compute is witnessed too: how long and how much, never what ran. Each session mints once; a session with no output is recorded without a mint, and replays mint nothing.',
  },
  {
    icon: 'Sparkles',
    title: 'Model turns',
    body: 'Each agent model response that calls a tool, even one that errors, leaves one receipt; responses with no tool call do not mint. Each program has one witness: the session files it already writes, or the local proxy if it writes none, or OpenTelemetry if neither applies. An agent on its own machine with none of those, such as one living on its own computer in the cloud, has each command it runs witnessed from the operating system, one receipt per command. Changing model, provider or sign-in keeps the witness. A person’s own computer witnesses commits and desktop chat, not tool calls.',
  },
]

export interface DaemonStep {
  readonly n: string
  readonly title: string
  readonly body: string
  readonly cmd: string | null
}

export const DAEMON_SETUP_SECTION = {
  eyebrow: 'Setup',
  heading: 'Two steps, one pairing.',
  lede: 'Pairing starts on your phone. The app makes a one-time code; your computer proves it has it. No passwords, no accounts, no wallet keys on the computer.',
} as const

export const DAEMON_STEPS: readonly DaemonStep[] = [
  {
    n: '01',
    title: 'Generate your command in the app',
    body: 'In the Provian app: Connect → Your computer (or Earn tab → Your computer → Connect a computer). You get a one-time command with your setup token baked in (it expires shortly). Connecting more than one machine? Each computer needs its own command — generate a fresh one for each.',
    cmd: null,
  },
  {
    n: '02',
    title: 'Paste it into a terminal on that computer',
    body: 'Your token is already inside the command you copied, so there is nothing to fill in and nothing to install first. It sets up a Node.js runtime if you don\'t have one, registers the machine, installs the git commit hook, and starts the observer. Works on macOS and Linux; on Windows, use the PowerShell command shown in the app. Receipts start within minutes and appear in your Abundance tab.',
    cmd: 'curl -sSL -H \'x-provian-token: …\' "https://api.provian.ai/v1/bootstrap/device" | sh',
  },
  {
    n: '03',
    title: 'Standing up an agent-owned device instead?',
    body: 'The agent runs invite-device --email <addr>, and whoever runs the machine gets a ready-to-run register-device --agent-token <token> by email, with no key or secret to paste. The receipts this machine produces then belong to the agent wallet. The setup link authorizes device registration only.',
    cmd: 'register-device --agent-token <token-from-email>',
  },
]

/** A sentence with one inline code token; each renderer wraps `code` in its own markup. */
export interface InlineCodeSentence {
  readonly before: string
  readonly code: string
  readonly after: string
}

export const DAEMON_FORGE_NOTE: InlineCodeSentence = {
  before: 'Working with GitHub, GitLab, or Bitbucket too? Run',
  code: 'connect-github',
  after: 'from the registered machine, or connect straight from the app under Earn. GitLab (cloud or self-hosted) and Bitbucket connect from the app. A forge is a stronger witness than the machine alone, so connecting one raises what each commit earns.',
}

export const DAEMON_CUSTODY_SECTION: DaemonSection = {
  eyebrow: 'Custody',
  heading: 'What leaves your computer, and what never does.',
}

export const DAEMON_CUSTODY_POINTS: readonly string[] = [
  'The desktop app sends structural metadata and fingerprints, never code, prompts, file contents, or keystrokes.',
  'It does not scan or index your files. It witnesses git commits, AI sessions, and agent activity only.',
  'Receipts carry signed metadata only: counts, durations, and hashes.',
  'The desktop app holds device credentials, never your wallet keys — those stay in the Provian app, encrypted on your phone.',
  'It only witnesses. It never sits in the path of your work or your spending; if it stops, you keep working and simply stop earning receipts until it resumes.',
  'Remove the computer from the Provian app at any time. Removal is immediate and leaves its own receipt.',
]

export const DAEMON_BETA = {
  eyebrow: 'Install',
  heading: 'Nothing to install first.',
  body: {
    before: 'The Provian app writes the one-time',
    code: 'curl … | sh',
    after: 'command for this computer with your token already inside, and that command sets everything up. On Windows the app gives a PowerShell line instead. Questions? Email us and we will help you set it up.',
  } as InlineCodeSentence,
  mailtoHref: 'mailto:hello@provian.ai?subject=Daemon%20setup',
  mailtoLabel: 'hello@provian.ai',
} as const
