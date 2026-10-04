#!/usr/bin/env node
/**
 * Import pre-issued license keys into the Supabase license pool.
 *
 * Keys are minted OFFLINE by the vendor tool (they must be — the Ed25519
 * signing seed never lives on the website or in Supabase), with the seed
 * through the environment and NOT `--dev`: a key signed with the committed
 * test pair is unverifiable by any released build, so a pool of `--dev` keys
 * would sell licenses that fail the moment they are pasted.
 *
 *     export FOVEA_LICENSE_PUBKEYS=$(cat ~/fovea-vendor/fovea-license-public.hex)
 *     export FOVEA_LICENSE_PRIVATE_KEY=$(cat ~/fovea-vendor/fovea-license-private.hex)
 *     cargo run --release --manifest-path ../src-tauri/Cargo.toml \
 *       --example issue_license -- --holder "orders@caelmont.in" \
 *       --edition pro --id PL-2026-000001
 *
 * Check one before importing it — the same verifier the shipped app uses,
 * from the same release profile, needs no private key:
 *
 *     cargo run --release --manifest-path ../src-tauri/Cargo.toml \
 *       --example issue_license -- --verify "FOVEA1.…"
 *
 * Collect the printed keys into a text file, one per line (extra tool output
 * on a line is fine — any FOVEA1.… token on a line is picked up), then:
 *
 *     export FOVEA_LICENSE_PUBKEYS=$(cat ~/fovea-vendor/fovea-license-public.hex)
 *     node scripts/import-license-keys.mjs --file keys-pro.txt
 *
 * The importer re-verifies every key's Ed25519 signature against those public
 * keys before storing it. It is required, not optional: a pool entry is a
 * product that has already been sold, and decoding the JSON alone cannot tell
 * a genuine key from one whose claims were edited.
 *
 * The edition and license id are read from the signed payload itself, so a
 * mismatch between file and flag is caught, not trusted. Run with the
 * service role key in the environment (see --env-file below); this is a
 * vendor-side script, never a website runtime dependency.
 *
 * Re-running is safe: already-imported keys are skipped, not overwritten.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const usage = () => {
  console.error(
    'Usage: node scripts/import-license-keys.mjs --file keys.txt [--edition pro|studio]' +
      '\n  FOVEA_LICENSE_PUBKEYS (comma-separated hex) and SUPABASE_* must be set.',
  );
  process.exit(2);
};

function parseArgs(argv) {
  const args = { file: null, edition: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--edition') args.edition = argv[++i];
    else usage();
  }
  if (!args.file) usage();
  if (args.edition && !['pro', 'studio'].includes(args.edition)) usage();
  return args;
}

function decodePayload(key) {
  const parts = key.split('.');
  // 'FOVEA1' is the first segment: the separator is not part of it, so a
  // prefix that keeps the dot rejects every real key.
  if (parts.length !== 3 || parts[0] !== 'FOVEA1') return null;
  const json = Buffer.from(parts[1], 'base64url').toString('utf8');
  const payload = JSON.parse(json);
  if (payload.product !== 'fovea' && payload.product !== 'pixora') return null;
  return { licenseId: payload.id, edition: payload.edition };
}

// Decoding claims proves nothing — anyone can write JSON that says "pro".
// The pool is the last place a bad key is cheap to catch, so verify the
// signature here against the same public key the shipped app carries. A key
// that fails this was signed with a different seed and would be a refund.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeys() {
  return (process.env.FOVEA_LICENSE_PUBKEYS ?? '')
    .split(',')
    .map((hex) => hex.trim())
    .filter(Boolean)
    .map((hex) => {
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`not a 32-byte hex public key: ${hex}`);
      return createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
        format: 'der',
        type: 'spki',
      });
    });
}

function signatureValid(key, keys) {
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  let signature;
  try {
    signature = Buffer.from(parts[2], 'base64url');
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  const message = Buffer.from(parts[1], 'base64url');
  return keys.some((pk) => {
    try {
      return cryptoVerify(null, message, pk, signature);
    } catch {
      return false;
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !serviceKey) {
    console.error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (e.g. --env-file=.env.local).',
    );
    process.exit(1);
  }

  let verifiers;
  try {
    verifiers = publicKeys();
  } catch (e) {
    console.error(`FOVEA_LICENSE_PUBKEYS: ${e.message}`);
    process.exit(1);
  }
  if (verifiers.length === 0) {
    console.error(
      'FOVEA_LICENSE_PUBKEYS is not set: keys would be imported on the strength of their ' +
        'JSON alone, and a tampered payload reads exactly like a real one.',
    );
    process.exit(1);
  }

  const fs = await import('node:fs');
  const lines = fs.readFileSync(args.file, 'utf8').split(/\r?\n/);
  const keys = lines
    .map((l) => (l.match(/FOVEA1\.\S+/g) ?? []).at(0))
    .filter((k) => typeof k === 'string');

  if (keys.length === 0) {
    console.error(`No FOVEA1. keys found in ${args.file}`);
    process.exit(1);
  }

  const rows = [];
  for (const key of keys) {
    let payload;
    try {
      payload = decodePayload(key);
    } catch {
      payload = null;
    }
    if (!payload) {
      console.error(`SKIP (unparseable key): ${key.slice(0, 24)}…`);
      continue;
    }
    if (!signatureValid(key, verifiers)) {
      console.error(
        `SKIP (signature does not verify against FOVEA_LICENSE_PUBKEYS — wrong pair or tampered ` +
          `claims, and the shipped app would reject it too): ${payload.licenseId}`,
      );
      continue;
    }
    if (args.edition && payload.edition !== args.edition) {
      console.error(
        `SKIP (edition mismatch: file flag says ${args.edition}, signed payload says ${payload.edition}): ${payload.licenseId}`,
      );
      continue;
    }
    rows.push({
      key,
      edition: payload.edition,
      license_id: payload.licenseId,
    });
  }

  if (rows.length === 0) {
    console.error('Nothing to import.');
    process.exit(1);
  }

  const res = await fetch(`${base}/rest/v1/license_pool`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    console.error(`Import failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }

  const inserted = await res.json();
  console.log(
    `Imported ${inserted.length} of ${rows.length} key(s) (${keys.length - rows.length} skipped). ` +
      `${inserted.length ? `Editions: {[...new Set(inserted.map((r) => r.edition))].join(', ')}.` : 'All were already in the pool.'}`,
  );
}

main();
