// Build one branded installer per plan.
//
// The engine is identical in all three — the plan is decided by the key in
// Settings, not by the binary. What differs is the name on the exe, the
// Start-menu entry, the window title and the icon, so the build a customer
// downloads is the one they bought. The bundle identifier stays
// `com.fovea.desktop` across all three, which is what lets an activated key,
// settings and the month's meter survive a switch between builds.
//
//   node scripts/build-tiers.mjs                # all three
//   node scripts/build-tiers.mjs pro studio     # a subset

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleRoot = join(root, 'src-tauri', 'target', 'release', 'bundle')
const outDir = join(root, 'installers')

const version = JSON.parse(
  readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
).version

const TIERS = [
  { id: 'free', name: 'Fovea', config: null },
  { id: 'pro', name: 'Fovea Pro', config: 'src-tauri/tauri.pro.conf.json' },
  { id: 'studio', name: 'Fovea Studio', config: 'src-tauri/tauri.studio.conf.json' },
]

// Each tier's bundles land in the same directory and carry the product name,
// so the directory is cleared first and whatever appears is this tier's.
function collect(tier) {
  const copied = []
  for (const [kind, ext] of [
    ['nsis', 'exe'],
    ['msi', 'msi'],
  ]) {
    const dir = join(bundleRoot, kind)
    const built = readdirSync(dir).filter((f) => f.startsWith(`${tier.name}_`))
    if (built.length !== 1) {
      throw new Error(`expected 1 ${kind} bundle for ${tier.name}, found ${built.length}`)
    }
    const dest = join(outDir, `${tier.name.replace(/ /g, '-')}-${version}-x64.${ext}`)
    copyFileSync(join(dir, built[0]), dest)
    copied.push(dest)
  }
  return copied
}

const requested = process.argv.slice(2)
const tiers = requested.length ? TIERS.filter((t) => requested.includes(t.id)) : TIERS

mkdirSync(outDir, { recursive: true })

for (const tier of tiers) {
  for (const kind of ['nsis', 'msi']) {
    rmSync(join(bundleRoot, kind), { recursive: true, force: true })
  }
  const args = ['run', 'tauri', 'build']
  if (tier.config) args.push('--', '--config', tier.config)
  console.log(`\n── building ${tier.name} ──`)
  execFileSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  for (const dest of collect(tier)) console.log(`  → ${dest}`)
}

console.log(`\nDone. Artifacts in ${outDir}`)
