/**
 * Download delivery metadata — read server-side from env, never committed.
 *
 * One engine ships as three branded builds: the installer, the exe, the
 * Start-menu entry and the window title each carry the plan they were
 * downloaded for, because a customer should open the product they bought.
 * The plan itself is still decided by the key, so all three share one
 * bundle identifier and a licence survives being reinstalled over.
 *
 * `scripts/build-tiers.mjs` produces the files; they are uploaded to the
 * GitHub Release and the published URLs are given to the site as env:
 *
 *   FOVEA_DOWNLOAD_URL          the free build's setup exe
 *   FOVEA_DOWNLOAD_MSI_URL       its MSI (optional)
 *   FOVEA_DOWNLOAD_SIZE          human-readable size, e.g. "58 MB" (optional)
 *
 * …and the same three with `_PRO` / `_STUDIO` suffixed onto each name.
 *
 * When a build's URL is unset its button is replaced by a pre-launch note
 * instead of an invented link — an honest state, not a broken button.
 */
export type PlanId = 'free' | 'pro' | 'studio';

/** The name printed on the button and on the file it downloads. */
export const buildNames: Record<PlanId, string> = {
  free: 'Fovea',
  pro: 'Fovea Pro',
  studio: 'Fovea Studio',
};

export type TierBuild = {
  plan: PlanId;
  name: string;
  exeUrl: string | null;
  /** The Windows Installer package, offered beside the setup exe for
   * machines that deploy by MSI. Optional — many builds ship NSIS only. */
  msiUrl: string | null;
  size: string | null;
  published: boolean;
};

export type DownloadInfo = {
  version: string | null;
  /** True when at least one plan's build is downloadable. */
  published: boolean;
  builds: Record<PlanId, TierBuild>;
};

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function buildFor(plan: PlanId): TierBuild {
  // The unsuffixed names are the free build's, so a single-URL launch keeps
  // working and the plain button still means "the one anyone can install".
  const suffix = plan === 'free' ? '' : `_${plan.toUpperCase()}`;
  const exeUrl = env(`FOVEA_DOWNLOAD_URL${suffix}`);
  return {
    plan,
    name: buildNames[plan],
    exeUrl,
    msiUrl: env(`FOVEA_DOWNLOAD_MSI_URL${suffix}`),
    size: env(`FOVEA_DOWNLOAD_SIZE${suffix}`),
    published: exeUrl !== null,
  };
}

export function downloadInfo(): DownloadInfo {
  const builds = {
    free: buildFor('free'),
    pro: buildFor('pro'),
    studio: buildFor('studio'),
  };
  return {
    version: env('FOVEA_DOWNLOAD_VERSION'),
    published: Object.values(builds).some((b) => b.published),
    builds,
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
  {
    k: 'Image sizes',
    v: 'Sources up to 200 MB and 64 megapixels; output capped at 256 megapixels',
  },
  {
    k: 'Memory',
    v: 'Adaptive tiling plans each run from your free RAM and VRAM — low graphics memory costs time, not a crash',
  },
  { k: 'Disk', v: 'The app plus its bundled model; leave room for your own output files' },
  {
    k: 'WebView2',
    v: 'Present on current Windows 11; the installer fetches the runtime itself if it is missing',
  },
  {
    k: 'Internet',
    v: 'For the download and install, and once more to open the free plan’s month — after that the balance is cached and everything runs offline',
  },
  { k: 'Developer tools', v: 'Not needed — Node, Rust, Git, Python and CUDA are all irrelevant' },
] as const;
