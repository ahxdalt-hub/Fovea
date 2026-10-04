/**
 * Product documentation content — concise, task-shaped, and limited to what
 * the desktop app actually does today. Each step is an action the user can
 * take in the shipped app; nothing here describes a planned feature.
 */

export type DocStep = string;
export type DocSection = {
  id: string;
  title: string;
  intro: string;
  steps?: DocStep[];
  note?: string;
};

export const docs: DocSection[] = [
  {
    id: 'install',
    title: 'Installation',
    intro:
      'Fovea is a normal Windows setup. You do not need Node, Rust, Git, Python, CUDA or a terminal.',
    steps: [
      'Run the downloaded installer (`.exe`) and follow the two prompts.',
      'Launch Fovea from the Start menu or its desktop shortcut.',
      'The AI model is already inside the app — there is nothing separate to install.',
    ],
    note: 'Fovea works on Windows 10 and 11, 64-bit.',
  },
  {
    id: 'activation',
    title: 'Activation',
    intro:
      'Activation is optional and fully offline. Without a key Fovea runs the free plan — Standard mode at 2×, ten enhancements a calendar month, nothing watermarked. Activating lifts that ceiling and records your commercial license for this copy.',
    steps: [
      'Open Settings — click the gear in the top bar, or press Ctrl + ,.',
      'Select the License section.',
      'Paste your license key (it begins with FOVEA1.) into the License key box.',
      'Press Activate. The key is verified on your machine; no connection is needed.',
    ],
    note: 'Keys tolerate stray spaces and line breaks. To move machines, deactivate here first, then activate on the new one if your key is machine-bound.',
  },
  {
    id: 'import',
    title: 'Importing images',
    intro: 'Bring photos in from disk. Supported input: JPEG, PNG and WebP.',
    steps: [
      'Drag one or more images onto the window, or use the import control to pick files.',
      'Recent files are listed so you can reopen something you worked on before.',
      'Pick the image you want to work on; it opens in the workspace.',
    ],
  },
  {
    id: 'enhance',
    title: 'Enhancement',
    intro: 'Choose how much larger and which behavior, then let the local model rebuild detail.',
    steps: [
      'Select a scale — 2× or 4×.',
      'Select a mode — Standard, Natural or Detail.',
      'Start the enhancement. Progress and, on large images, adaptive tiling are handled for you.',
      'Use the before/after compare to judge the result at full resolution.',
    ],
    note: 'The model runs on your DirectX 12 GPU through DirectML when one is present, and on your CPU otherwise — the same quality either way. Without a key the choices are Standard and 2×; a Pro or Studio key adds Natural, Detail, the Portrait look and 4×.',
  },
  {
    id: 'batch',
    title: 'Batch processing',
    intro: 'Run several images through the same settings without doing each one by hand.',
    steps: [
      'Import the images you want to include, then switch to Batch.',
      'Set the scale and mode once — every item in the run uses them.',
      'Start the queue and watch each item move through Waiting, Processing, Completed or Failed.',
      'Cancel one item or the whole queue; retry what failed when it settles.',
      'Open the output folder to review the results.',
    ],
    note: 'A run holds to 500 images and processes one at a time so items never compete for memory. If a name is already taken in the output folder, Fovea adds a suffix instead of overwriting.',
  },
  {
    id: 'export',
    title: 'Export',
    intro: 'Save finished images to a folder you choose, in the format you want.',
    steps: [
      'Open the export control.',
      'Choose PNG, JPEG or WebP. PNG is lossless; JPEG and WebP offer a quality setting.',
      'Pick the destination folder and confirm.',
    ],
    note: 'Each file is written atomically, so it never lands half-saved. If a name is taken, Fovea adds a suffix instead of overwriting your work.',
  },
  {
    id: 'compare',
    title: 'Comparing and navigating',
    intro: 'Judge the result honestly before you spend time exporting it.',
    steps: [
      'Press C (or use the compare control) to split original and result down the same line.',
      'Drag the divider, or click it and use the arrow keys; Home and End jump to either side.',
      'Zoom with the mouse wheel or + and −; the point under your cursor stays put.',
      'Press 0 to fit the image to the window, 1 for actual size, F for fullscreen.',
    ],
    note: 'The slider handle and its labels stay the same size on screen at every zoom, so a 4× view is as easy to drag as a fitted one.',
  },
  {
    id: 'history',
    title: 'History and recent files',
    intro: 'A local journal of what Fovea has done, so you can find a result again later.',
    steps: [
      'Open History to see past runs: source name, dimensions, scale and mode, and where the output went.',
      'An entry whose file has since been moved or deleted is marked rather than silently dropped.',
      'Clear the journal from the same screen when you want a clean list.',
    ],
    note: 'Clearing history removes Fovea’s records only — your image files are untouched. The journal is a plain file in Fovea’s app folder on your disk and is never uploaded.',
  },
  {
    id: 'settings',
    title: 'Settings',
    intro: 'Everything configurable is on one screen, opened with the gear or Ctrl + ,.',
    steps: [
      'General — theme (System, Light, Dark), which view Fovea opens on, and whether recent files are remembered.',
      'Processing — your default scale and mode. The engine switches there (force CPU-only, or let a CPU run claim every logical core) belong to the Studio plan; on any plan the engine still picks GPU or CPU by itself.',
      'Export — default format, quality, and the folder results go to.',
      'Diagnostics — your CPU, memory and graphics adapters, the tile and band ceilings Fovea planned, model availability, and paths to the app data, models and log folders.',
    ],
    note: 'Settings are stored on your machine. Diagnostics shows the same numbers Fovea uses to plan a run, so you can see why an image is being tiled the way it is.',
  },
];

export const troubleshooting: { q: string; a: string }[] = [
  {
    q: 'Activation says the key isn’t a Fovea license.',
    a: 'The key was probably edited or truncated in copying. Select the whole key from your order confirmation and paste it again; spaces and line breaks are fine.',
  },
  {
    q: 'It reports the key is bound to a different computer.',
    a: 'That key was issued for one specific machine. Re-activate on that machine, or contact the store you bought it from to re-issue for this one.',
  },
  {
    q: 'The license shows as expired or revoked.',
    a: 'Renew or contact the store that issued the key. Until you do this machine falls back to the free plan — Standard mode at 2×, ten enhancements a calendar month — so the app keeps running and every image you already made stays exactly as it is.',
  },
  {
    q: 'A clock warning appears.',
    a: 'Fovea remembers the latest time it has seen. Correct the date and time in Windows settings; once the clock is right the warning clears on its own.',
  },
  {
    q: 'Enhancement is slow.',
    a: 'Large images and 4× take longer, especially on the CPU. If you have a DirectX 12 GPU, Fovea uses it automatically; otherwise the processor path is simply slower, not worse. Settings → Diagnostics shows which device and which tile size Fovea planned.',
  },
  {
    q: 'Fovea refuses a file that looks fine.',
    a: 'Sources are capped at 200 MB and 64 megapixels, and a single enhancement at 256 megapixels of output (about 16 MP at 4×). The limit is checked before decoding so an enormous file cannot exhaust your memory; crop or downsize the source and try again.',
  },
  {
    q: 'A WebP export failed on a very wide image.',
    a: 'WebP allows 16,383 px on its longest edge. Export that result as PNG or JPEG instead — PNG keeps every pixel and is byte-identical to Fovea’s working master.',
  },
  {
    q: 'Can I use the free version for paid client work?',
    a: 'Not as licensed use. The free plan is a real working tool — Standard mode at 2×, batch, every export format, no watermark — but it is capped at ten enhancements a calendar month, and the commercial right to use Fovea for client and business work is what a Pro or Studio key grants. A key also lifts the ceiling: 4×, the Natural and Detail modes, the Portrait look, and no monthly count.',
  },
  {
    q: 'Where did my processed images go?',
    a: 'Working results stay in Fovea’s private app folder until you export. On export you choose the exact folder, and the finished file is written there.',
  },
];
