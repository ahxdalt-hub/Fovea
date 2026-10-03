/**
 * Product documentation content — concise, task-shaped, and limited to what
 * the desktop app actually does today (verified against the Stage 06–13
 * surfaces). Each step is an action the user can take in the shipped app.
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
      'Pixora is a normal Windows setup. You do not need Node, Rust, Git, Python, CUDA or a terminal.',
    steps: [
      'Run the downloaded installer (`.exe`) and follow the two prompts.',
      'Launch Pixora from the Start menu or its desktop shortcut.',
      'The AI model is already inside the app — there is nothing separate to install.',
    ],
    note: 'Pixora works on Windows 10 and 11, 64-bit.',
  },
  {
    id: 'activation',
    title: 'Activation',
    intro:
      'Activation is optional for use and fully offline. Enhancement, batch and export work with or without a key; activating records your commercial license for this copy.',
    steps: [
      'Open Settings — click the gear in the top bar, or press Ctrl + ,.',
      'Select the License section.',
      'Paste your license key (it begins with PIXORA1.) into the License key box.',
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
    note: 'The model runs on your DirectX 12 GPU through DirectML when one is present, and on your CPU otherwise — the same quality either way.',
  },
  {
    id: 'batch',
    title: 'Batch processing',
    intro: 'Run several images through the same settings without doing each one by hand.',
    steps: [
      'Select the images to include.',
      'Set the scale and mode once.',
      'Run the batch, then review each item’s outcome in the results.',
    ],
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
    note: 'Each file is written atomically, so it never lands half-saved. If a name is taken, Pixora adds a suffix instead of overwriting your work.',
  },
];

export const troubleshooting: { q: string; a: string }[] = [
  {
    q: 'Activation says the key isn’t a Pixora license.',
    a: 'The key was probably edited or truncated in copying. Select the whole key from your order confirmation and paste it again; spaces and line breaks are fine.',
  },
  {
    q: 'It reports the key is bound to a different computer.',
    a: 'That key was issued for one specific machine. Re-activate on that machine, or contact the store you bought it from to re-issue for this one.',
  },
  {
    q: 'The license shows as expired or revoked.',
    a: 'Renew or contact the store that issued the key. Either way, enhancement on this machine keeps working meanwhile — the license is a record, not a gate.',
  },
  {
    q: 'A clock warning appears.',
    a: 'Pixora remembers the latest time it has seen. Correct the date and time in Windows settings; once the clock is right the warning clears on its own.',
  },
  {
    q: 'Enhancement is slow.',
    a: 'Large images and 4× take longer, especially on the CPU. If you have a DirectX 12 GPU, Pixora uses it automatically; otherwise the processor path is simply slower, not worse.',
  },
  {
    q: 'Where did my processed images go?',
    a: 'Working results stay in Pixora’s private app folder until you export. On export you choose the exact folder, and the finished file is written there.',
  },
];
