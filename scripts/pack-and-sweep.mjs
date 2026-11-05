#!/usr/bin/env node
/**
 * Pack the launch publish set from this checkout and sweep the exact packed bytes.
 *
 *   node scripts/pack-and-sweep.mjs [--out <dir>] [--evidence <file>] [--replace]
 *
 * The publish set: @provian/agent-sdk, @provian/cli, @provian/mcp, @provian/commons (npm) and
 * provian-sdk (PyPI, sdist + wheel). Each is built fresh from this checkout first, the way the
 * publish workflow (.github/workflows/build-foreground-helpers.yml) builds it, so no stale local
 * dist/ is packed: the SDK is installed, built and packed after its helper stage
 * (scripts/build-helper.js, the package's prepack, run explicitly so npm's ignore-scripts setting
 * cannot skip it); the CLI is built against that SDK tarball, installed --no-save so its published
 * `^` dependency stays intact; the MCP package is built after the core-mirror gate;
 * the Python package is built with `python -m build` in a scratch venv.
 *
 * Every artifact is then extracted and swept with
 * `node scripts/check-armed-state-copy.mjs --artifact --root <extracted dir>`, which reads every
 * text file the artifact ships. The report names the commit, whether the tree was clean, and each
 * artifact's file name, version, sha256 and sweep result. Exit 0 only when every pack, every
 * content check and every sweep passed.
 *
 * Bytes differ from the workflow's own pack where the host differs: the workflow builds the macOS
 * and Windows helpers on native runners and packs on Linux, so its SDK tarball carries both
 * helpers and its own sha256. The workflow's pack jobs print the sha256 of the bytes they publish.
 *
 * --out defaults to ~/Projects/provian-store-builds/pack-<UTC date>; it must be empty, or
 * --replace clears the artifacts and extracted/ a previous run left there.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] }
const OUT = path.resolve(flag('--out') ?? path.join(homedir(), 'Projects', 'provian-store-builds', `pack-${new Date().toISOString().slice(0, 10)}`))
const EVIDENCE = flag('--evidence')
const REPLACE = argv.includes('--replace')

const report = []
const problems = []
const say = (s = '') => { report.push(s); console.log(s) }
const problem = (s) => { problems.push(s); say(`  PROBLEM: ${s}`) }

function run(cmd, args, cwd, { quiet = true } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 256 * 1024 * 1024 })
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n')
    throw new Error(`${cmd} ${args.join(' ')} (in ${path.relative(REPO, cwd) || '.'}) failed:\n${out}`)
  }
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const newest = (dir, pred) => readdirSync(dir).filter(pred).sort()

// ── where and what ────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true })
const leftovers = readdirSync(OUT).filter((n) => /\.(tgz|whl)$|\.tar\.gz$/.test(n) || n === 'extracted' || n === '.pybuild-venv')
if (leftovers.length) {
  if (!REPLACE) { console.error(`pack-and-sweep: ${OUT} already holds ${leftovers.join(', ')}; pass --replace or another --out`); process.exit(2) }
  for (const n of leftovers) rmSync(path.join(OUT, n), { recursive: true, force: true })
}
const head = run('git', ['rev-parse', 'HEAD'], REPO).trim()
const dirty = run('git', ['status', '--porcelain'], REPO).trim()
say(`pack-and-sweep — ${new Date().toISOString()}`)
say(`checkout: ${REPO}`)
say(`commit:   ${head}${dirty ? ' (TREE NOT CLEAN: the artifacts include uncommitted changes)' : ' (clean tree)'}`)
if (dirty) for (const l of dirty.split('\n')) say(`          ${l}`)
say(`out:      ${OUT}`)
say(`node ${process.version}, npm ${run('npm', ['-v'], REPO).trim()}`)
say('')

const artifacts = [] // { file, name, version, kind }
function tarList(tgz) { return run('tar', ['-tzf', tgz], REPO).split('\n').filter(Boolean) }
function tarPkgJson(tgz) { return JSON.parse(run('tar', ['-xzOf', tgz, 'package/package.json'], REPO)) }
function requireEntries(tgz, entries) {
  const list = new Set(tarList(tgz))
  for (const e of entries) if (!list.has(e)) problem(`${path.basename(tgz)} is missing ${e}`)
  return list
}

function npmPack(dir) {
  const before = new Set(readdirSync(OUT))
  run('npm', ['pack', '--pack-destination', OUT], path.join(REPO, dir))
  const made = readdirSync(OUT).filter((n) => n.endsWith('.tgz') && !before.has(n))
  if (made.length !== 1) throw new Error(`npm pack in ${dir} produced ${made.length} tarballs`)
  return path.join(OUT, made[0])
}

try {
  // ── @provian/agent-sdk ──────────────────────────────────────────────────
  say('[1/5] @provian/agent-sdk: npm ci, build, stage the helper this host builds, pack')
  run('npm', ['ci', '--no-audit', '--no-fund'], path.join(REPO, 'provian-agent-sdk'))
  run('npm', ['run', 'build'], path.join(REPO, 'provian-agent-sdk'))
  // The package's prepack hook, run explicitly: with npm's ignore-scripts set, `npm pack` skips it.
  run('node', ['scripts/build-helper.js'], path.join(REPO, 'provian-agent-sdk'))
  const sdk = npmPack('provian-agent-sdk')
  {
    const list = requireEntries(sdk, ['package/package.json', 'package/dist/index.js'])
    const darwin = list.has('package/bin/helpers/darwin/ProvianForegroundHelper.app/Contents/MacOS/ProvianForegroundHelper')
    const win32 = list.has('package/bin/helpers/win32/ProvianForegroundHelper.exe')
    say(`  helpers in this tarball: macOS ${darwin ? 'yes' : 'NO'}, Windows ${win32 ? 'yes' : 'no (built only on the workflow\'s windows runner)'}`)
    if (process.platform === 'darwin' && !darwin) problem('macOS helper missing from the SDK tarball on a Mac')
    artifacts.push({ file: sdk, name: '@provian/agent-sdk', version: tarPkgJson(sdk).version, kind: 'npm' })
  }

  // ── @provian/cli (against the in-repo SDK tarball, --no-save) ───────────
  say('[2/5] @provian/cli: install with the SDK tarball --no-save (its ^ SDK dependency is not on npm yet), build, pack')
  run('npm', ['install', sdk, '--no-save', '--no-audit', '--no-fund'], path.join(REPO, 'provian-cli'))
  run('npm', ['run', 'build'], path.join(REPO, 'provian-cli'))
  const cli = npmPack('provian-cli')
  {
    requireEntries(cli, ['package/package.json', 'package/dist/index.js', 'package/bin/provian.mjs'])
    const pkg = tarPkgJson(cli)
    const dep = (pkg.dependencies ?? {})['@provian/agent-sdk'] ?? ''
    if (/^(file:|\.|\/)/.test(dep) || !dep) problem(`CLI ships SDK dependency ${JSON.stringify(dep)}`)
    say(`  CLI publishes @provian/agent-sdk dependency ${dep}`)
    artifacts.push({ file: cli, name: '@provian/cli', version: pkg.version, kind: 'npm' })
  }

  // ── @provian/mcp ────────────────────────────────────────────────────────
  say('[3/5] @provian/mcp: core-mirror gate, npm ci, build, pack')
  run('bash', ['scripts/check-mcp-core-mirror.sh'], REPO)
  run('npm', ['ci', '--no-audit', '--no-fund'], path.join(REPO, 'provian-mcp'))
  run('npm', ['run', 'build'], path.join(REPO, 'provian-mcp'))
  const mcp = npmPack('provian-mcp')
  requireEntries(mcp, ['package/package.json', 'package/dist/index.js', 'package/bin/provian-mcp.mjs'])
  artifacts.push({ file: mcp, name: '@provian/mcp', version: tarPkgJson(mcp).version, kind: 'npm' })

  // ── @provian/commons ────────────────────────────────────────────────────
  say('[4/5] @provian/commons: pack (README and licence; no code)')
  const commons = npmPack('provian-commons')
  {
    const list = requireEntries(commons, ['package/package.json', 'package/README.md', 'package/LICENSE'])
    const code = [...list].filter((n) => /\.(js|mjs|cjs|ts)$/.test(n))
    if (code.length) problem(`commons tarball carries code: ${code.join(', ')}`)
    const pkg = tarPkgJson(commons)
    if (pkg.private) problem('@provian/commons is still marked private; npm publish would refuse it')
    artifacts.push({ file: commons, name: '@provian/commons', version: pkg.version, kind: 'npm' })
  }

  // ── provian-sdk (PyPI) ──────────────────────────────────────────────────
  say('[5/5] provian-sdk (PyPI): python -m build (sdist + wheel) in a scratch venv')
  const venv = path.join(OUT, '.pybuild-venv')
  run('python3', ['-m', 'venv', venv], REPO)
  run(path.join(venv, 'bin', 'pip'), ['install', '--quiet', '--upgrade', 'build'], REPO)
  const pyBefore = new Set(readdirSync(OUT))
  run(path.join(venv, 'bin', 'python'), ['-m', 'build', '--outdir', OUT, path.join(REPO, 'provian-python-sdk')], REPO)
  const pyMade = readdirSync(OUT).filter((n) => !pyBefore.has(n) && (n.endsWith('.whl') || n.endsWith('.tar.gz')))
  rmSync(venv, { recursive: true, force: true })
  for (const n of pyMade.sort()) {
    const m = /^provian_sdk-([^-]+?)(?:-py3-none-any\.whl|\.tar\.gz)$/.exec(n)
    if (!m) problem(`unexpected Python artifact ${n}`)
    artifacts.push({ file: path.join(OUT, n), name: 'provian-sdk', version: m ? m[1] : '?', kind: n.endsWith('.whl') ? 'wheel' : 'sdist' })
  }
  if (!pyMade.some((n) => n.endsWith('.whl'))) problem('no wheel was built')
} catch (err) {
  problem(err instanceof Error ? err.message : String(err))
}
say('')

// ── extract and sweep the exact packed bytes ────────────────────────────
say('ARTIFACTS (file, version, sha256, armed-state sweep over the extracted contents)')
const extractedRoot = path.join(OUT, 'extracted')
mkdirSync(extractedRoot, { recursive: true })
for (const a of artifacts) {
  const base = path.basename(a.file)
  const dest = path.join(extractedRoot, base.replace(/(\.tgz|\.whl|\.tar\.gz)$/, '') + (a.kind === 'sdist' ? '-sdist' : ''))
  mkdirSync(dest, { recursive: true })
  if (a.kind === 'wheel') run('unzip', ['-q', '-o', a.file, '-d', dest], REPO)
  else run('tar', ['-xzf', a.file, '-C', dest], REPO)
  a.sha256 = sha256(a.file)
  let sweep
  let ok = true
  try {
    sweep = run('node', [path.join(REPO, 'scripts', 'check-armed-state-copy.mjs'), '--artifact', '--root', dest], REPO).trim()
  } catch (err) {
    ok = false
    sweep = err instanceof Error ? err.message : String(err)
  }
  a.sweep = sweep
  say(`  ${base}`)
  say(`    package ${a.name} ${a.version} (${a.kind})`)
  say(`    sha256  ${a.sha256}`)
  for (const l of sweep.split('\n')) say(`    sweep   ${l}`)
  if (!ok) problem(`armed-state sweep failed for ${base}`)
}
const names = new Set(artifacts.map((a) => a.name))
for (const n of ['@provian/agent-sdk', '@provian/cli', '@provian/mcp', '@provian/commons', 'provian-sdk']) if (!names.has(n)) problem(`${n} was not packed`)
say('')
say(problems.length ? `RESULT: FAIL — ${problems.length} problem(s)` : `RESULT: PASS — ${artifacts.length} artifacts packed from ${head.slice(0, 12)} and swept`)
for (const p of problems) say(`  - ${p.split('\n')[0]}`)
if (EVIDENCE) writeFileSync(EVIDENCE, report.join('\n') + '\n')
process.exit(problems.length ? 1 : 0)
