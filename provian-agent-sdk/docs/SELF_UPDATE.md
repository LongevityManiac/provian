# Daemon self-update

* the observer daemon updates its own bundle from a Provian-signed
channel, so a fleet is not frozen at whatever bundle each machine installed.*

Fixes to the daemon (a new capture lane, a bug fix, silence counters)
otherwise reach an existing install only when a human restarts it. Self-update lets a
daemon pick up a **Provian-signed** release of itself on its own — **on by default**
(the operator , close), because the fix must land on every machine with no user
action.

## Trust model (read this first)

A release is **executable code**, not the declarative data a harness catalog is — so the
bar here is deliberately higher than the catalog's.

- **One signing authority, pinned.** The release manifest is Ed25519-signed by ONE key whose
  public half is compiled into the SDK build (`RELEASE_PUBLIC_KEY`, `src/observer/release-signature.ts`),
  never fetched or env-overridable. Its private half lives only in Secret Manager
  `release-signing-key`. The harness catalog that once shared the key was removed in.
    rotated the key after the previous one (`29ade696…`, Secret Manager
  `harness-catalog-signing-key`) was exposed: one transition release, signed by the old key,
  carried the new pin; every later release is signed by the new key, and an updated daemon
  refuses anything the old key signs. Rotating again is the same hard cutover: ship the new pin in
  a release signed by the current key, wait until every checking-in daemon reports it applied,
  then switch the signer.
- **The signed bytes are the only bytes that run.** The manifest names the bundle's exact
  `sha256` and byte length. The daemon downloads the bundle from the **fixed** relay URL
  `/v1/bootstrap/agent.js` (never a URL taken from the manifest) and **refuses to apply**
  unless the hash and length match the signed manifest. A tampered or truncated download
  is fail-closed, not run.
- **Fail closed, everywhere.** No network, a bad signature, a malformed manifest, a version
  not strictly newer, a Node older than the release needs, a hash mismatch — every one ends
  in "keep running what we have". The apply is a temp-write → fsync → atomic rename, so the
  bundle on disk is either the whole old file or the whole new one, never a mix.
- **Default on, opt-out.** Self-update is **on** by default. It fetches from the same relay
  route the hosted install line installs from (`/v1/bootstrap/agent.js`), and only signature-
  and hash-verified bytes. An operator can turn it off with `PROVIAN_SELF_UPDATE=0`. Making it
  opt-in bought no threat mitigation the fail-closed gates above do not already give.

## It's on by default

Self-update requires a **KeepAlive supervisor** (launchd / systemd / pm2) that relaunches
the daemon when it exits — the daemon re-execs by exiting after an atomic swap, and the
supervisor starts it again on the just-swapped bytes. The hosted `curl … | sh` install sets
one up, so nothing is needed to enable self-update there.

```sh
# On by default. To turn it OFF:
export PROVIAN_SELF_UPDATE=0
# Optional target override (defaults to the running entry file):
export PROVIAN_SELF_UPDATE_TARGET=/path/agent.js
```

The target must be the single-file bundle the daemon runs (`~/.provian/agent.js` for the
hosted `curl … | sh` install). A multi-file `npx @provian/agent-sdk` install has no
single-file entry to swap, so self-update is inert there (nothing to replace) — that is not
the same as opting out, and it is safe: it simply does nothing.

## Publishing a release (operator)

Signing uses the Secret-Manager key `release-signing-key` and happens **out of band**;
the relay's serving route holds no key material.

```sh
# 1. Build + stage the bundle (provian-agent-sdk), then, in provian-backend:
npx ts-node scripts/sign-release-manifest.ts --version <N> [--node-min 20.0.0] [--measurements <path>] [--dry-run]
```

`--version` is monotonic and must exceed the last published version. The script reads the
exact staged bundle (`bootstrap-bundle/agent.js`), computes its hash, builds and signs the
manifest, and writes `{manifest, signature}` to Firestore `release_manifest/current`. The
relay serves it at `GET /v1/catalog/release`. A daemon at or above that version does nothing;
a lower daemon (self-update is on by default) downloads, verifies, applies, and re-execs.

## What it is not

- Not a way to run unsigned or third-party code — only bytes matching a Provian signature run.
- Not a kill switch — it can only move a daemon **forward** to a newer signed bundle.
- Not reachable by a remote host: the manifest and bundle are fetched by the daemon; nothing
  is pushed to it. On by default, but an operator can opt out with `PROVIAN_SELF_UPDATE=0`.
