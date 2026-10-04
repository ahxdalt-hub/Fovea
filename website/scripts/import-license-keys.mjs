#!/usr/bin/env node
/**
 * Import pre-issued license keys into the Supabase license pool.
 *
 * Keys are minted OFFLINE by the vendor tool (they must be — the Ed25519
 * signing seed never lives on the website or in Supabase):
 *
 *     cargo run --release --example issue_license -- --dev \
 *       --holder "orders@caelmont.in" --edition pro --id PL-2026-000001
 *
 * Collect the printed keys into a text file, one per line (extra tool output
 * on a line is fine — any FOVEA1.… token on a line is picked up), then:
 *
 *     node scripts/import-license-keys.mjs --file keys-pro.txt
 *
 * The edition and license id are read from the signed payload itself, so a
 * mismatch between file and flag is caught, not trusted. Run with the
 * service role key in the environment (see --env-file below); this is a
 * vendor-side script, never a website runtime dependency.
 *
 * Re-running is safe: already-imported keys are skipped, not overwritten.
 */

const usage = () => {
  console.error('Usage: node scripts/import-license-keys.mjs --file keys.txt [--edition pro|studio]');
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
  if (parts.length !== 3 || parts[0] !== 'FOVEA1.') return null;
  const json = Buffer.from(parts[1], 'base64url').toString('utf8');
  const payload = JSON.parse(json);
  if (payload.product !== 'fovea' && payload.product !== 'pixora') return null;
  return { licenseId: payload.id, edition: payload.edition };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !serviceKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (e.g. --env-file=.env.local).');
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
