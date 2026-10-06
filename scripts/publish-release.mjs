// Publish the six installer artifacts for a version as a GitHub Release.
// Usage: GITHUB_TOKEN=*** node scripts/publish-release.mjs <tag> <files...>
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

const token = process.env.GITHUB_TOKEN
if (!token) throw new Error('GITHUB_TOKEN is not set')

const [tag, ...files] = process.argv.slice(2)
if (!tag || files.length === 0) throw new Error('usage: publish-release.mjs <tag> <files...>')

const owner = 'ahxdalt-hub'
const repo = 'Fovea'
const version = tag.replace(/^v/, '')

const body = `## Fovea ${version}

The paid plans became visible, and the free counter stopped trusting the machine it runs on.

Each installer now compiles in the plan it was branded for, so a Pro build says "Fovea Pro" in its title bar and the License page states plainly what a paid installer owes its key. The marker is identity, not entitlement: an unactivated Pro build still runs the free plan until a key is entered. The monthly free allowance is now counted on our server against your install id rather than a local clock.

### Which build to download

All three run the identical engine. The plan you bought decides what unlocks at runtime, from the key you enter in Settings — not the installer you ran. Download the one that matches your plan so the name, icon and Start-menu entry match what you own.

| Plan | Price | What the key unlocks |
| --- | --- | --- |
| Free | $0 | 2x Standard mode, 10 enhancements a calendar month, all finishing looks except Portrait |
| Pro | $49 once | 4x, Advanced restoration, the Portrait look, unlimited processing |
| Studio | $129 once | Everything in Pro, plus the engine controls (provider, device, precision, threads, tiling), and one key on up to 5 machines |

\`Fovea-${version}-x64.exe\` is the primary build for everyone; the \`.msi\` exists for enterprise deployment.

### Also in this release

- Every finishing look is now covered by tests that run it at full strength and compare it against the other ten: each one changes the image in its own way, and none is another look under a new name. Verified against the real model end to end, writing eleven distinct masters from one source.
- Portrait's description corrected — it is the one look tuned for skin (a global soften-warm-lift pass), not face detection.

Requires Windows 10 or later, x64, with a DirectX 12 GPU (Intel, NVIDIA or AMD) for acceleration; it falls back to the CPU otherwise. Nothing is uploaded — images are processed on your machine.

Previous release: [v1.2.0](https://github.com/ahxdalt-hub/Fovea/releases/tag/v1.2.0).`

const gh = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${url}\n${text}`)
  return text ? JSON.parse(text) : null
}

const existing = await gh(
  `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
).catch(() => null)
let release = existing
if (!existing) {
  release = await gh(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: `Fovea ${version}`,
      body,
      draft: false,
      prerelease: false,
    }),
  })
}
console.log(`release ${release.id} ${release.html_url}`)

for (const file of files) {
  const name = basename(file)
  const dup = (release.assets || []).find((a) => a.name === name)
  if (dup) {
    console.log(`  ${name} already attached, deleting for a clean re-upload`)
    await gh(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${dup.id}`, {
      method: 'DELETE',
    })
  }
  const data = readFileSync(file)
  await gh(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
      },
      body: data,
    },
  )
  console.log(`  ↑ ${name} ${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`)
}

const final = await gh(`https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`)
console.log(`assets: ${final.assets.map((a) => a.name).join(', ')}`)
