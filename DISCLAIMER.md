# Disclaimer — AS IS, No Warranty, No Liability

**Read this before installing, building, or using the Provian wallet or any software in this repository.**

Provian is experimental software that interacts with public blockchains and
self-custody cryptographic keys. Using it carries real and irreversible financial
risk, including the **total and permanent loss of funds**. By using it you accept
the terms below.

## Provided "AS IS"

All software in this repository — the Provian wallet (`src/`), the Commons
reference implementation (`provian-commons/`), the backend, the website, and the
open-source protocol SDKs and CLI — is provided **"AS IS" and "AS AVAILABLE",
without warranty of any kind**, express or implied, including but not limited to
the implied warranties of merchantability, fitness for a particular purpose,
title, and non-infringement. Provian Technologies, LLC does not warrant that the
software is error-free, secure, uninterrupted, or that it will meet your
requirements.

## Self-custody: you control your funds, and you bear the risk

The Provian wallet is **non-custodial**. You — and only you — control your keys,
your recovery backup, and your backup password. This is a deliberate design choice, and it
means:

- Provian Technologies **cannot** access, freeze, recover, reverse, or restore
  your wallet, your keys, your recovery backup, or any transaction.
- If you lose your keys, your recovery backup, or your backup password, **your funds are
  permanently lost.** No one can recover them.
- Blockchain transactions are **irreversible**. A transaction you authorize —
  including one you authorize through an approval or a signature, and one an
  agent makes with funds or spending access you gave it — **cannot be undone**,
  even if it was a mistake, a scam, or the result of a bug. Provian records what
  a connected agent does; it does not approve, limit, or stop an agent's
  actions.
- You are responsible for verifying every address, amount, contract, approval,
  and signature before you authorize it.

## No liability — including loss of funds

To the maximum extent permitted by applicable law, **Provian Technologies, LLC,
its affiliates, and contributors shall not be liable for any loss or damage of
any kind** arising from or in connection with the software or its use, including
without limitation:

- **loss of funds, loss of crypto assets, loss of keys, or loss of recovery
  backups;**
- loss of data, loss of profits, business interruption, or loss of goodwill;
- losses caused by bugs, vulnerabilities, downtime, smart-contract failures,
  third-party services, network or RPC failures, phishing, malware, theft, or
  compromise of your device;
- losses caused by transactions you authorize, or that an agent you connected,
  funded, or gave spending access to carries out.

This applies whether the claim is based in contract, tort (including
negligence), strict liability, or any other legal theory, and whether or not
Provian was advised of the possibility of such damages.

## No obligation to keep operating

Provian Technologies, LLC may suspend or permanently discontinue the Provian relay,
Provenance Envelope processing, PVT minting, and settlement at any time, and has
**no obligation to continue minting PVT or operating any service**. Nothing in
this repository, the software, or any Provian document is a promise that minting
or any service will continue. If Provian discontinues minting and settlement, it
announces a shutdown date and runs a final settlement of the PVT earned before
that date; anything still unsettled after that final settlement is void.
Already-minted PVT and wallet funds stay on-chain under the holder's own keys and
are not affected. The Terms of Service (Section 24.3) govern.

## Not financial, investment, legal, or tax advice

Nothing in this repository or the software is financial, investment, legal,
accounting, or tax advice. PVT and other tokens are **not** an investment, a
security, a guaranteed return, a store of lasting value, or passive income. Provian does not quote, peg,
or promise any price for PVT and operates no exchange or market for it; any
price you see elsewhere is a third party's assertion. You are solely responsible for
evaluating the risks and for your own compliance with the laws and regulations
that apply to you, including in your jurisdiction.

## Your responsibility

You are responsible for securing your device, your backups, and your backup password; for
keeping software up to date; for understanding what each action does before you
authorize it; and for complying with applicable law. **Use this software at your
own risk.**

---

The proprietary components are licensed under the repository root [`LICENSE`](./LICENSE),
the wallet [`src/LICENSE`](./src/LICENSE), and [`provian-commons/LICENSE`](./provian-commons/LICENSE).
The open-source protocol SDKs and CLI are licensed under their own MIT
LICENSE files (the agent skill in `skills/provian/` under MIT-0). This
disclaimer applies to all of them.
