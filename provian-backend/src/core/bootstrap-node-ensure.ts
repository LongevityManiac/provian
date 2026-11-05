/**
 * Shell/PowerShell installers always use the private checksum-verified Node22.
 * A system Node is never kept, even when it supports SQLite. Existing private
 * copies are reused only at the exact pin and with a working SQLite probe.
 */

/**
 * The pinned private Node.js used by every daemon start. Must be
 * >= v22.13.0 (flagless `node:sqlite`) — v22.11.0, the earlier pin, still gated
 * it behind `--experimental-sqlite`, so a fetched-and-installed v22.11.0 stayed
 * dark on the very lane this prelude exists to restore. v22.23.2 is the current
 * Node 22 'Jod' LTS and satisfies @provian/agent-sdk's `engines: node >=20`. The
 * checksum is verified at fetch time against the official SHASUMS256 for
 * whatever version this names.
 */
export const BOOTSTRAP_NODE_VERSION = 'v22.23.2';

/**
 * F36: the EXPECTED SHA256 of each official Node tarball/zip for
 * BOOTSTRAP_NODE_VERSION, PINNED here and embedded in the served script. The
 * prior prelude fetched SHASUMS256.txt from the SAME origin as the tarball, so a
 * MITM on nodejs.org (a TLS-intercepting proxy whose CA the host trusts) could
 * substitute BOTH; and the check FAILED OPEN (skipped silently when the SHASUMS
 * fetch failed or no sha tool existed). Pinning the hash in the relay-served
 * script moves the trust anchor to the relay's TLS origin, and the verification
 * now fails CLOSED. When BOOTSTRAP_NODE_VERSION changes, refresh every entry from
 * https://nodejs.org/dist/<version>/SHASUMS256.txt (verified 2026-09-10 for
 * v22.23.2). Keyed by `<os>-<arch>` (sh) / `win-<arch>` (PowerShell).
 */
export const BOOTSTRAP_NODE_SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64': '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6',
  'darwin-x64': '58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026',
  'linux-arm64': '013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30',
  'linux-x64': 'b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a',
  'win-arm64': 'fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3',
  'win-x64': '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97',
};

/** POSIX-sh `case` arms mapping `<os>-<arch>` to the pinned Node SHA256 (F36). */
function shNodeHashCase(): string {
  return (['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const)
    .map((k) => `    ${k}) NODE_EXPECTED='${BOOTSTRAP_NODE_SHA256[k]}' ;;`)
    .join('\n');
}

/**
 * POSIX-sh Node prelude. Requires a `say()` helper and `set -eu` context.
 * Leaves Node's bin dir first on PATH.
 */
export function nodeEnsureSh(): string {
  return `# --- Ensure a Node.js that can read the transcript store ---------------------
# Always uses the pinned private installer Node22, with working flagless
# node:sqlite. Fetches an official, checksum-verified standalone build into
# ~/.provian/node. No sudo, nothing installed system-wide; remove any time with:
# rm -rf ~/.provian/node
NODE_VERSION='${BOOTSTRAP_NODE_VERSION}'
NODE_DIR=""
# A box whose egress is a forward proxy needs a Node that routes
# fetch AND http(s) through HTTP(S)_PROXY (NODE_USE_ENV_PROXY: Node 22.21+ /
# 24.5+). The pinned Node22 supports this; retain the capability check.
PROVIAN_PROXY_SET=""
for PROVIAN_PV in "\${HTTPS_PROXY:-}" "\${https_proxy:-}" "\${HTTP_PROXY:-}" "\${http_proxy:-}"; do
  if [ -n "$PROVIAN_PV" ]; then PROVIAN_PROXY_SET=1; fi
done
# The EXACT capability the observer's record-store probes (sqliteAvailability):
# require('node:sqlite') resolves AND exposes a DatabaseSync function. A version
# gate is the wrong test — node:sqlite is absent before 22.5 and throws flagless
# before 22.13, so a Node 20 or 22.11 host would pass ">=20" yet stay dark here.
NODE_PROBE='const m=require("node:sqlite");if(typeof m.DatabaseSync!=="function")process.exit(1)'
if [ -n "$PROVIAN_PROXY_SET" ]; then
  NODE_PROBE="$NODE_PROBE;const v=process.versions.node.split('.').map(Number);if(!((v[0]===22&&v[1]>=21)||(v[0]===24&&v[1]>=5)||v[0]>=25))process.exit(1)"
fi


# Reuse a runtime this prelude already verified and unpacked on an
# earlier run (same pinned version, still passes the probe) instead of
# downloading ~54 MB again on every paste.
if [ -z "$NODE_DIR" ] && [ -x "$HOME/.provian/node/bin/node" ]; then
  if [ "$("$HOME/.provian/node/bin/node" --version 2>/dev/null)" = "$NODE_VERSION" ] \
    && "$HOME/.provian/node/bin/node" -e "$NODE_PROBE" >/dev/null 2>&1; then
    NODE_DIR="$HOME/.provian/node/bin"
  fi
fi

if [ -z "$NODE_DIR" ]; then
  OS=$(uname -s 2>/dev/null || echo unknown)
  ARCH=$(uname -m 2>/dev/null || echo unknown)
  case "$OS" in
    Darwin) NODE_OS=darwin ;;
    Linux)  NODE_OS=linux ;;
    *) say 'Automatic setup covers macOS and Linux. On Windows, use the PowerShell command shown in the Provian app instead.'; exit 1 ;;
  esac
  case "$ARCH" in
    arm64|aarch64) NODE_ARCH=arm64 ;;
    x86_64|amd64)  NODE_ARCH=x64 ;;
    *) say "Provian could not auto-install Node.js for your CPU ($ARCH). This device needs a supported CPU for the private Node.js runtime."; exit 1 ;;
  esac

  say "Setting up a private Node.js runtime for Provian (~40 MB, into ~/.provian/node)..."
  NODE_TARBALL="node-$NODE_VERSION-$NODE_OS-$NODE_ARCH.tar.gz"
  NODE_BASE="https://nodejs.org/dist/$NODE_VERSION"
  NODE_DEST="$HOME/.provian/node"
  # Own temp dir cleaned INLINE (not via an EXIT trap) so this prelude composes
  # safely inside a caller that has its own EXIT trap.
  NODE_TMP=$(mktemp -d 2>/dev/null || mktemp -d -t provian)

  if ! curl -fsSL "$NODE_BASE/$NODE_TARBALL" -o "$NODE_TMP/$NODE_TARBALL"; then
    say 'Could not download Node.js. Check your internet connection and paste the command again.'
    exit 1
  fi

  # Integrity check — FAIL CLOSED (F36). The expected SHA256 is PINNED in this
  # relay-served script (trust anchored to the relay's TLS, not a same-origin
  # checksum manifest a MITM could substitute alongside the tarball). No sha tool,
  # an unknown-platform pin, or a mismatch all STOP setup — never extract an
  # unverified tarball onto PATH.
  case "$NODE_OS-$NODE_ARCH" in
${shNodeHashCase()}
    *) NODE_EXPECTED='' ;;
  esac
  NODE_ACTUAL=""
  if command -v shasum >/dev/null 2>&1; then
    NODE_ACTUAL=$(shasum -a 256 "$NODE_TMP/$NODE_TARBALL" | awk '{print $1}')
  elif command -v sha256sum >/dev/null 2>&1; then
    NODE_ACTUAL=$(sha256sum "$NODE_TMP/$NODE_TARBALL" | awk '{print $1}')
  fi
  if [ -z "$NODE_EXPECTED" ] || [ -z "$NODE_ACTUAL" ] || [ "$NODE_EXPECTED" != "$NODE_ACTUAL" ]; then
    rm -rf "$NODE_TMP"
    say 'Could not verify the Node.js download (no checksum tool, unsupported platform, or a failed integrity check). Setup stopped for safety — check the connection and paste the command again.'
    exit 1
  fi

  mkdir -p "$NODE_DEST"
  if ! tar -xzf "$NODE_TMP/$NODE_TARBALL" -C "$NODE_DEST" --strip-components=1; then
    rm -rf "$NODE_TMP"
    say 'Could not unpack Node.js. Check available disk space and paste the command again.'
    exit 1
  fi
  rm -rf "$NODE_TMP"
  NODE_DIR="$NODE_DEST/bin"
fi

# Put the chosen Node first on PATH so every node started below (and any 'env node' shebang) resolves to it.
PATH="$NODE_DIR:$PATH"
export PATH

# --- Egress: forward proxy + loopback bypass + extra CA ---------------------
# curl honours HTTPS_PROXY and the OS trust store; Node does neither unless told
# at start. NODE_USE_ENV_PROXY routes fetch and http(s) through the proxy; the
# loopback hosts stay direct (the daemon's witness, OTLP and model-shim ports are
# 127.0.0.1); NODE_EXTRA_CA_CERTS makes Node trust what curl trusts (a
# TLS-inspecting proxy's CA lives in the OS store). The bundle records these in
# ~/.provian/runtime.env so the supervised daemon and the git hook get them too.
if [ -n "$PROVIAN_PROXY_SET" ]; then
  NODE_USE_ENV_PROXY=1
  case ",\${NO_PROXY:-}," in *,127.0.0.1,*) ;; *) NO_PROXY="127.0.0.1,localhost,::1\${NO_PROXY:+,$NO_PROXY}" ;; esac
  case ",\${no_proxy:-}," in *,127.0.0.1,*) ;; *) no_proxy="127.0.0.1,localhost,::1\${no_proxy:+,$no_proxy}" ;; esac
  export NODE_USE_ENV_PROXY NO_PROXY no_proxy
fi
if [ -z "\${NODE_EXTRA_CA_CERTS:-}" ] && [ "$(uname -s 2>/dev/null)" = "Linux" ]; then
  for PROVIAN_CA in "\${SSL_CERT_FILE:-}" "\${CURL_CA_BUNDLE:-}" /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem; do
    if [ -n "$PROVIAN_CA" ] && [ -f "$PROVIAN_CA" ]; then
      NODE_EXTRA_CA_CERTS="$PROVIAN_CA"
      export NODE_EXTRA_CA_CERTS
      break
    fi
  done
fi`;
}

/**
 * PowerShell Node prelude. Requires a `Say` function and
 * `$ErrorActionPreference = 'Stop'` context. Leaves Node's dir first on $env:PATH.
 */
export function nodeEnsurePs(): string {
  return `# --- Ensure a Node.js that can read the transcript store ---------------------
# Always uses the pinned private installer Node22, with working flagless
# node:sqlite. Fetches an official, checksum-verified standalone build into
# ~\\.provian\\node. Nothing installed machine-wide; remove any time with:
# Remove-Item -Recurse ~\\.provian\\node
$NodeVersion = '${BOOTSTRAP_NODE_VERSION}'
$NodeDir = $null
switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { $nodeArch = 'arm64' } default { $nodeArch = 'x64' } }
$privateNode = Join-Path $HOME ".provian\\node\\node-$NodeVersion-win-$nodeArch\\node.exe"
if (Test-Path $privateNode) {
  try {
    & $privateNode -e 'const m=require("node:sqlite");if(typeof m.DatabaseSync!=="function")process.exit(1)' 2>$null
    if ($LASTEXITCODE -eq 0 -and (& $privateNode --version) -eq $NodeVersion) { $NodeDir = Split-Path $privateNode }
  } catch { $NodeDir = $null }
}

if (-not $NodeDir) {
  switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { $nodeArch = 'arm64' } default { $nodeArch = 'x64' } }
  Say "Setting up a private Node.js runtime for Provian (~30 MB, into ~\\.provian\\node)..."
  $nodeZip = "node-$NodeVersion-win-$nodeArch.zip"
  $nodeBase = "https://nodejs.org/dist/$NodeVersion"
  $nodeDest = Join-Path $HOME '.provian\\node'
  $nodeTmp = Join-Path $env:TEMP ("provian-" + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $nodeTmp | Out-Null
  try {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$nodeBase/$nodeZip" -OutFile (Join-Path $nodeTmp $nodeZip)
    } catch {
      Say 'Could not download Node.js. Check your internet connection and paste the command again.'
      exit 1
    }
    # Integrity check — FAIL CLOSED (F36). The expected SHA256 is PINNED in this
    # relay-served script (trust anchored to the relay's TLS, not a same-origin
    # checksum manifest). An unknown-platform pin or a mismatch STOPS setup.
    $nodeExpected = switch ("win-$nodeArch") {
      'win-arm64' { '${BOOTSTRAP_NODE_SHA256['win-arm64']}' }
      'win-x64'   { '${BOOTSTRAP_NODE_SHA256['win-x64']}' }
      default     { '' }
    }
    $nodeActual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $nodeTmp $nodeZip)).Hash.ToLower()
    if (-not $nodeExpected -or ($nodeExpected.ToLower() -ne $nodeActual)) {
      Say 'Could not verify the Node.js download (unsupported platform or a failed integrity check). Setup stopped for safety — check the connection and paste the command again.'
      exit 1
    }
    New-Item -ItemType Directory -Force -Path $nodeDest | Out-Null
    Expand-Archive -Path (Join-Path $nodeTmp $nodeZip) -DestinationPath $nodeDest -Force
    $NodeDir = Join-Path $nodeDest "node-$NodeVersion-win-$nodeArch"
  } finally {
    Remove-Item -Recurse -Force -Path $nodeTmp -ErrorAction SilentlyContinue
  }
}

$env:PATH = "$NodeDir;$env:PATH"`;
}
