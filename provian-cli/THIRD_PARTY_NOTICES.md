# Third-Party Notices

This document lists third-party works referenced or relied on by the
Provian reference implementation in this repository, even where no
upstream code was incorporated.

## Apache-2.0

### Coinbase x402 protocol specification
- Referenced in: `provian-agent-sdk/src/x402-signer.ts` (the agent-side x402
  signer; shared with the relay's x402 path).
- Use: type definitions describe the public x402 wire format. No code
  is derived; only the protocol shape (field names, error codes,
  flow) is referenced.
- Notice: Coinbase x402 protocol © Coinbase, Inc., licensed under the
  Apache License 2.0.

## ISC

### MetaMask / eth-phishing-detect
- Referenced in: `src/data/scam-contracts.ts` as one of six
  source-of-truth feeds for known-malicious addresses.
- Use: factual address data (public, on-chain). Address data itself
  is not copyrightable; we list eth-phishing-detect as a courtesy
  attribution because it is the upstream curator we cite.
- Notice: MetaMask / eth-phishing-detect © MetaMask contributors,
  licensed under the ISC License.

---

For the licenses of npm and PyPI dependencies, see the `package.json`
and `pyproject.toml` files in each subproject and run
`npm ls --json --long` / `pip show <pkg>` for the canonical text.
