#!/usr/bin/env node
/**
 * regen-vision-images.mjs — regenerate the Vision / onboarding art with
 * Nano Banana (Gemini 2.5 Flash Image) through the Leonardo API.
 *
 * Why this exists: the revised render set does not illustrate the copy it sits
 * on. See docs/archive/audits/IMAGE_ALIGNMENT_AUDIT.md. The replacement prompts live in
 * scripts/image-prompts.json so the brief is reviewable as data, separate from
 * the transport code here.
 *
 *   export LEONARDO_API_KEY=...            # https://app.leonardo.ai → API keys
 *   node scripts/regen-vision-images.mjs --dry-run       # print the plan only
 *   node scripts/regen-vision-images.mjs --only vision-other-fear,vision-trust
 *   node scripts/regen-vision-images.mjs                 # everything not "keep"
 *   node scripts/regen-vision-images.mjs --all           # include "keep" images
 *
 * By default nothing is written over the originals: each render lands in
 * assets/images/regen-<date>/ and a one-line summary tells you what to copy
 * where. Pass --write to place files at their target paths directly (the
 * originals are backed up alongside as <name>.bak-<date> first).
 *
 * The images are 1376x768 to match the existing set and the 220pt-tall,
 * cover-fitted section card in VisionScreen.tsx. Targets marked
 * {"crop":"square"} (the website) are centre-cropped after download, and
 * {"crop":"WxH"} centre-crops to that exact size (Nano Banana Pro accepts
 * 1376 but not 1344 as a width, so its banners render at 1376x768 and are
 * cropped to the set's 1344x768).
 * An image may set its own "model" / "width" / "height", and "spine":"none"
 * when its prompt carries its own style paragraph (the square hero does).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const API = 'https://cloud.leonardo.ai/api/rest';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
};

const DRY = has('--dry-run');
const WRITE = has('--write');
const ALL = has('--all');
// --place-staged <date>: skip generation and place the renders already staged in
// assets/images/regen-<date>/ (implies --write). Lets you generate once, review
// the staged files by eye, then place exactly those without paying to regenerate.
const PLACE_STAGED = val('--place-staged');
const ONLY = (val('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const STAMP = PLACE_STAGED || new Date().toISOString().slice(0, 10);

const spec = JSON.parse(readFileSync(resolve(HERE, 'image-prompts.json'), 'utf8'));
const OUT_DIR = resolve(ROOT, `assets/images/regen-${STAMP}`);

// ── selection ────────────────────────────────────────────────────────────────

const selected = spec.images.filter((img) => {
    if (ONLY.length) return ONLY.includes(img.name);
    return ALL || !img.keep;
});

if (!selected.length) {
    console.error(`No images selected.${ONLY.length ? ` Unknown --only name(s): ${ONLY.join(', ')}` : ''}`);
    console.error(`Available: ${spec.images.map((i) => i.name).join(', ')}`);
    process.exit(1);
}

const targetsOf = (img) => img.targets.map((t) => (typeof t === 'string' ? { path: t, crop: null } : t));
// Abundance sections use the warm spine; fear sections set mood:'dark'. Falls
// back to the legacy single styleSpine when the two-mood spines are absent.
const spineFor = (img) => {
    if (img.spine === 'none') return ''; // the prompt carries its own style paragraph
    const warm = spec.styleSpineWarm;
    const dark = spec.styleSpineDark ?? spec.styleSpine;
    return (img.mood === 'dark' ? dark : (warm ?? spec.styleSpine));
};
const fullPrompt = (img) => [img.prompt, spineFor(img)].filter(Boolean).join('\n\n');
// An image may override the set's model and size (the hero is square: its
// 400pt-tall cover-fitted box is nearly square on a phone, not a banner).
const renderOf = (img) => ({
    model: img.model ?? spec.model,
    width: img.width ?? spec.width,
    height: img.height ?? spec.height,
});

console.log(`\nNano Banana via Leonardo — model ${spec.model}, ${spec.width}x${spec.height}`);
console.log(`${selected.length} image(s) selected${DRY ? ' (dry run)' : ''}:\n`);
for (const img of selected) {
    const r = renderOf(img);
    console.log(`      ${img.name}`);
    console.log(`    section : ${img.section}`);
    if (r.model !== spec.model || r.width !== spec.width || r.height !== spec.height) {
        console.log(`    render  : ${r.model}, ${r.width}x${r.height}`);
    }
    for (const t of targetsOf(img)) console.log(`    target  : ${t.path}${t.crop ? ` (${t.crop})` : ''}`);
    if (DRY) console.log(`    prompt  : ${fullPrompt(img).replace(/\n+/g, ' ')}\n`);
}

if (DRY) {
    console.log('Dry run — nothing generated. Drop --dry-run to run it.\n');
    process.exit(0);
}

const KEY = process.env.LEONARDO_API_KEY;
if (!KEY && !PLACE_STAGED) {
    console.error('\nLEONARDO_API_KEY is not set. Get one at https://app.leonardo.ai → Settings → API keys.');
    process.exit(1);
}

// ── transport ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
    let res;
    try {
        res = await fetch(`${API}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${KEY}`,
                accept: 'application/json',
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
    } catch (err) {
        // A bare "fetch failed" here is almost always the network, not the API:
        // an egress policy that does not allow cloud.leonardo.ai, or a proxy
        // Node's built-in fetch is not reading (set NODE_USE_ENV_PROXY=1 on
        // Node >= 22.21 when behind one).
        throw new Error(
            `cannot reach ${API} (${err.cause?.code || err.cause?.message || err.message}). `
            + 'Check that this network allows cloud.leonardo.ai:443; if you are behind '
            + 'a proxy, run with NODE_USE_ENV_PROXY=1.',
        );
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok) {
        throw new Error(`${method} ${path} → ${res.status} ${res.statusText}\n${text.slice(0, 600)}`);
    }
    return json ?? {};
}

/** The v2 create response has moved field names before; probe the known shapes. */
function generationIdOf(payload) {
    const cands = [
        payload?.generate?.generationId,   // the live v2 shape: { generate: { generationId } }
        payload?.generate?.generation_id,
        payload?.generation_id,
        payload?.generationId,
        payload?.id,
        payload?.generations_by_pk?.id,
        payload?.sdGenerationJob?.generationId,
        payload?.data?.generation_id,
        payload?.data?.id,
    ];
    const id = cands.find((v) => typeof v === 'string' && v.length > 0);
    if (!id) throw new Error(`No generation id in create response: ${JSON.stringify(payload).slice(0, 600)}`);
    return id;
}

/** Likewise for the poll response: return {status, urls}. */
function progressOf(payload) {
    const gen = payload?.generations_by_pk ?? payload?.generation ?? payload?.data ?? payload;
    const status = String(gen?.status ?? gen?.state ?? '').toUpperCase();
    const imgs = gen?.generated_images ?? gen?.images ?? gen?.output ?? [];
    const urls = (Array.isArray(imgs) ? imgs : [])
        .map((i) => (typeof i === 'string' ? i : i?.url ?? i?.image_url ?? i?.imageUrl))
        .filter(Boolean);
    return { status, urls };
}

async function generate(img) {
    const { model, width, height } = renderOf(img);
    const created = await call('POST', '/v2/generations', {
        model,
        parameters: {
            prompt: fullPrompt(img),
            width,
            height,
            quantity: 1,
            prompt_enhance: 'OFF',
        },
        public: false,
    });
    const id = generationIdOf(created);

    // Poll. Nano Banana usually lands inside 30s; allow five minutes.
    const deadline = Date.now() + 5 * 60_000;
    let last = '';
    while (Date.now() < deadline) {
        await sleep(3000);
        let payload;
        try {
            payload = await call('GET', `/v1/generations/${id}`); // the live reader path
        } catch {
            payload = await call('GET', `/v2/generations/${id}`); // fallback if it moves
        }
        const { status, urls } = progressOf(payload);
        if (status && status !== last) {
            process.stdout.write(`      ${status.toLowerCase()}…\n`);
            last = status;
        }
        if (status === 'FAILED') throw new Error(`generation ${id} FAILED`);
        if (urls.length) return urls[0];
        if (status === 'COMPLETE') throw new Error(`generation ${id} COMPLETE with no image url`);
    }
    throw new Error(`generation ${id} timed out after 5 minutes`);
}

async function download(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

// ── place: convert to the TARGET's own format, optionally centre-crop square ──
// Leonardo returns JPEG. The app assets are .png (Metro resolves and RN Image
// decodes by extension, so a JPEG payload behind a .png name is a latent bug);
// the website asset is .jpg. We re-encode to the target extension with macOS
// `sips`, and centre-crop square when the target asks for it. If `sips` is not
// available we fall back to a raw copy and say so, so the run still produces a
// reviewable file rather than aborting.

function sipsPlace(stagedJpg, dest, crop) {
    const ext = (dest.split('.').pop() || '').toLowerCase();
    const fmt = ext === 'png' ? 'png' : ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext;
    const args = ['-s', 'format', fmt];
    const exact = /^(\d+)x(\d+)$/.exec(crop ?? '');
    if (exact) {
        // centre-crop to an exact WxH; sips takes height first
        args.push('-c', exact[2], exact[1]);
    } else if (crop === 'square') {
        // centre-crop to the shorter side; the wide render's subject sits in the
        // upper-middle, so a centre square keeps the person and the action.
        const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', stagedJpg], { encoding: 'utf8' });
        const w = Number((dims.match(/pixelWidth:\s*(\d+)/) || [])[1]);
        const h = Number((dims.match(/pixelHeight:\s*(\d+)/) || [])[1]);
        const side = Math.min(w, h) || 768;
        args.push('-c', String(side), String(side));
    }
    execFileSync('sips', [...args, stagedJpg, '--out', dest], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function place(stagedJpg, dest, crop) {
    try {
        sipsPlace(stagedJpg, dest, crop);
        return crop ? `${crop}-cropped + re-encoded` : 're-encoded';
    } catch (err) {
        copyFileSync(stagedJpg, dest); // last-resort raw copy
        return `RAW COPY (sips failed: ${err.message.split('\n')[0]})`;
    }
}

// ── run ──────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });
const results = [];
const doWrite = WRITE || !!PLACE_STAGED;

for (const img of selected) {
    console.log(`\n  ${img.name}`);
    try {
        const staged = resolve(OUT_DIR, `${img.name}.jpg`);
        if (PLACE_STAGED) {
            if (!existsSync(staged)) throw new Error(`no staged render at ${staged} — generate it first`);
            console.log(`      placing staged assets/images/regen-${STAMP}/${basename(staged)}`);
        } else {
            const url = await generate(img);
            const bytes = await download(url);
            writeFileSync(staged, bytes);
            console.log(`      staged ${(bytes.length / 1024).toFixed(0)} KB → assets/images/regen-${STAMP}/${basename(staged)}`);
        }

        const placed = [];
        for (const t of targetsOf(img)) {
            const dest = resolve(ROOT, t.path);
            if (!doWrite) { placed.push(`${t.path}${t.crop ? ` (${t.crop} crop on write)` : ''}`); continue; }
            if (existsSync(dest)) copyFileSync(dest, `${dest}.bak-${STAMP}`);
            const how = place(staged, dest, t.crop);
            placed.push(`${t.path} [${how}]`);
        }
        console.log(doWrite ? `      wrote ${placed.length} target(s)` : `      targets: ${placed.join(', ')}`);
        results.push({ name: img.name, ok: true, staged });
    } catch (err) {
        console.error(`      FAILED: ${err.message}`);
        results.push({ name: img.name, ok: false, error: err.message });
    }
}

const ok = results.filter((r) => r.ok).length;
const bad = results.filter((r) => !r.ok);
console.log(`\n${ok}/${results.length} ${PLACE_STAGED ? 'placed' : 'generated'} → assets/images/regen-${STAMP}/`);
if (bad.length) {
    console.log(`failed: ${bad.map((b) => b.name).join(', ')}`);
    console.log(`retry with:  node scripts/regen-vision-images.mjs --only ${bad.map((b) => b.name).join(',')}`);
}
if (!doWrite && ok) {
    console.log('\nReview the staged renders, then place exactly those (no regeneration) with:');
    console.log(`  node scripts/regen-vision-images.mjs --place-staged ${STAMP}`);
    console.log('(each original is backed up as <name>.bak-' + STAMP + ' first)');
}
console.log('');
process.exit(bad.length ? 1 : 0);
