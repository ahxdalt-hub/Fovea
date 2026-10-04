/**
 * Rasterizes assets/app-icon.svg to assets/app-icon.png (1024×1024), the
 * input `npx tauri icon` needs to regenerate every bundled icon size in
 * src-tauri/icons/. Run after any change to the SVG source.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { Resvg } from '@resvg/resvg-js'

const svg = await readFile(new URL('../assets/app-icon.svg', import.meta.url), 'utf8')
const png = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1024 },
  font: { loadSystemFonts: false },
})
  .render()
  .asPng()

await writeFile(new URL('../assets/app-icon.png', import.meta.url), png)
console.log('wrote assets/app-icon.png (1024x1024)')
