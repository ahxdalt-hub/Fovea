/**
 * Download delivery metadata — read server-side from env, never committed.
 *
 * The installer is produced by Tauri packaging (Stage 14) into
 * `src-tauri/target/release/bundle/` as an NSIS `.exe` and an MSI `.msi`.
 * Those files are uploaded to whatever host the launch uses; the site links to
 * that published URL, which is set with:
 *
 *   PIXORA_DOWNLOAD_URL      the installer the "Download" button points at
 *   PIXORA_DOWNLOAD_VERSION  the version string shown next to it
 *   PIXORA_DOWNLOAD_SIZE     human-readable size, e.g. "58 MB" (optional)
 *
 * When these are unset the page says the build isn't published yet instead of
 * inventing a URL — an honest pre-launch state, not a broken link.
 */
export type DownloadInfo = {
  url: string | null;
  version: string | null;
  size: string | null;
  published: boolean;
};

export function downloadInfo(): DownloadInfo {
  const url = process.env.PIXORA_DOWNLOAD_URL?.trim() || null;
  return {
    url,
    version: process.env.PIXORA_DOWNLOAD_VERSION?.trim() || null,
    size: process.env.PIXORA_DOWNLOAD_SIZE?.trim() || null,
    published: url !== null,
  };
}

/** System requirements, stated exactly as the app and its fallback honour them. */
export const systemRequirements = [
  { k: 'Operating system', v: 'Windows 10 or Windows 11, 64-bit' },
  {
    k: 'Graphics',
    v: 'Any DirectX 12 GPU (AMD, Intel or NVIDIA) for acceleration — none required',
  },
  { k: 'CPU path', v: 'Runs on the processor automatically when no suitable GPU is present' },
  { k: 'Disk', v: 'The app plus its bundled model; leave room for your own output files' },
  { k: 'Internet', v: 'Only for the one-time download and install — everything else runs offline' },
  { k: 'Developer tools', v: 'Not needed — Node, Rust, Git, Python and CUDA are all irrelevant' },
] as const;
