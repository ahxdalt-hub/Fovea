/**
 * Fovea — single source of truth for the website's content and business
 * data. Everything a marketer needs to change (pricing, positioning, FAQ)
 * lives here; the section components read from it.
 *
 * Facts are kept honest to what the desktop app actually does today. Every
 * capability listed here has a code path behind it, and the two files that
 * matter most for verification are `src-tauri/src/services/` (what the engine
 * really does) and `src/` (what the UI really exposes). If a claim here stops
 * being true in the app, the claim goes — it does not get softened.
 */

export const site = {
  name: 'Fovea',
  tagline: 'Enhance and upscale images on your own computer.',
  url: 'https://fovea.caelmont.in',
  description:
    'Fovea is a Windows app that enhances and upscales your photos with a local AI model. Your images are processed on your own machine and never uploaded.',
} as const;

export const navLinks = [
  { href: '/#showcase', label: 'Results' },
  { href: '/#compare', label: 'Compare' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/product', label: 'Product' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/docs', label: 'Docs' },
] as const;

export const howItWorks = [
  { title: 'Import', body: 'Drag photos in or pick them. JPEG, PNG and WebP are supported.' },
  {
    title: 'Choose enhancement',
    body: 'Pick 2× or 4× and a mode — Standard, Natural, or Detail.',
  },
  { title: 'Enhance locally', body: 'The AI model runs on your machine. Nothing is uploaded.' },
  { title: 'Compare', body: 'Slide between original and result before you commit.' },
  { title: 'Export', body: 'Save as PNG, JPEG or WebP, at the quality you want.' },
] as const;

/** Only capabilities that genuinely exist in the app, named the way the
 * app names them. A feature that is designed but not wired is not here. */
export const features = [
  {
    title: '2× and 4× upscaling',
    body: 'The model runs at 4× and Fovea resamples that output to 2× — a real downsampling of real generated pixels, so 2× is a genuinely smaller result, not an enlarged preview.',
  },
  {
    title: 'Real AI enhancement',
    body: 'Real-ESRGAN reconstructs detail. Three distinct behaviors — Standard, Natural and Detail — backed by two separate model files and a real sharpening pass, not one setting with three names.',
  },
  {
    title: 'Before / after compare',
    body: 'A split slider over the same region at the same scale, with the handle and labels held at constant size whatever zoom you are at.',
  },
  {
    title: 'Zoom, pan and fit',
    body: 'Wheel-zoom anchored under the cursor, drag to pan, and full-resolution pixels fetched only when you zoom past the working view. Keys: + − 0 1 C F.',
  },
  {
    title: 'Batch processing',
    body: 'Queue up to 500 images at the same settings, watch each item’s state, cancel one or all, and retry what failed.',
  },
  {
    title: 'GPU acceleration, CPU fallback',
    body: 'Uses any DirectX 12 graphics card through DirectML — no CUDA. If the GPU fails mid-run, Fovea retries on the CPU and then with smaller tiles, and tells you which device it ended up on.',
  },
  {
    title: 'Memory-aware tiling',
    body: 'Tile size is planned from your actual free RAM and VRAM, so an image larger than your graphics memory degrades in speed instead of crashing.',
  },
  {
    title: 'Fully local',
    body: 'The model ships inside the app. There is no upload step, no account, and no network call while you work.',
  },
  {
    title: 'Multiple export formats',
    body: 'PNG keeps every pixel, JPEG and WebP offer a real quality control from 1 to 100. Choose your folder; your original file is never touched.',
  },
  {
    title: 'Never overwrites, never half-saves',
    body: 'Each export is written to a temporary file and renamed into place, and a taken name gets a numeric suffix rather than clobbering your work.',
  },
  {
    title: 'Safe on bad files',
    body: 'Corrupt, unsupported, enormous or mislabelled files are refused with a plain reason before anything is decoded — one bad file never blocks a batch.',
  },
  {
    title: 'Remembers your work',
    body: 'A local history journal of up to 200 runs and a recent-files list, both kept on your disk. Fovea flags an entry whose file has since moved or gone.',
  },
  {
    title: 'Settings that match the app',
    body: 'Theme, startup view, default scale and mode, default export format and folder, and an engine preference of Auto or CPU-only — plus a diagnostics page showing your real hardware and model status.',
  },
  {
    title: 'No watermark, ever',
    body: 'Fovea does not stamp output. That is true unlicensed, so it is a fact rather than a promise you buy.',
  },
] as const;

/**
 * The plan matrix, row by row. Every capability cell here is enforced by
 * the desktop app at its command boundary (see `services::license::
 * minimum_edition`), so a cell may only claim what the build actually
 * refuses without a key. The rights-and-coverage rows are the honest
 * exception: those are terms, and each one says so in its note.
 */
export type PlanValue = boolean | string;

export type PlanRow = {
  label: string;
  note: string;
  free: PlanValue;
  pro: PlanValue;
  studio: PlanValue;
};

export const planRows: PlanRow[] = [
  {
    label: 'Enhancement modes',
    note: 'Standard is free; Natural and Detail need a Pro key.',
    free: 'Standard',
    pro: 'All three',
    studio: 'All three',
  },
  {
    label: '2× and 4× upscaling',
    note: 'Both scales come from the model, never by stretching — 4× is the Pro ceiling.',
    free: '2×',
    pro: '2× and 4×',
    studio: '2× and 4×',
  },
  {
    label: 'Finishing looks',
    note: 'Ten pixel-math looks plus “original”. Portrait is the face-specific one, and it needs Pro.',
    free: 'All but Portrait',
    pro: 'All eleven',
    studio: 'All eleven',
  },
  {
    label: 'Batch queue',
    note: 'Up to 500 images, cancel and retry included. A batch spends from the same monthly count.',
    free: true,
    pro: true,
    studio: true,
  },
  {
    label: 'PNG, JPEG and WebP export',
    note: 'Including the full quality range and your choice of folder.',
    free: true,
    pro: true,
    studio: true,
  },
  {
    label: 'GPU acceleration and CPU fallback',
    note: 'DirectML on any DirectX 12 card, automatic fallback, adaptive tiling — free, like the engine itself.',
    free: true,
    pro: true,
    studio: true,
  },
  {
    label: 'Engine controls',
    note: 'The Settings switches that force the CPU path, or let a CPU run claim every logical core.',
    free: false,
    pro: false,
    studio: true,
  },
  {
    label: 'History journal and recents',
    note: 'Local only, up to 200 entries.',
    free: true,
    pro: true,
    studio: true,
  },
  {
    label: 'Watermarks',
    note: 'There is no stamping code in the app at all.',
    free: 'None',
    pro: 'None',
    studio: 'None',
  },
  {
    label: 'Monthly processing cap',
    note: 'Counted in images actually written, not time or days, and it refills with the calendar month. A failed or cancelled run costs nothing.',
    free: '10 a month',
    pro: 'None',
    studio: 'None',
  },
  {
    label: 'Works fully offline',
    note: 'Including activation — the key is verified on your machine.',
    free: true,
    pro: true,
    studio: true,
  },
  {
    label: 'Signed license key',
    note: 'An Ed25519-signed FOVEA1. key, stored securely on your machine.',
    free: '—',
    pro: true,
    studio: true,
  },
  {
    label: 'Commercial and client work',
    note: 'Licensed use of the app for paid, client or business output.',
    free: false,
    pro: true,
    studio: true,
  },
  {
    label: 'Machines the license covers',
    note: 'A license term, not software-enforced — see the FAQ.',
    free: 'Your machine',
    pro: '1 machine',
    studio: 'Up to 5 machines',
  },
  {
    label: 'Distributing keys to a team',
    note: 'Studio is the tier written for more than one person.',
    free: false,
    pro: false,
    studio: true,
  },
  {
    label: 'Re-issued keys and support',
    note: 'Handling a lost key, a moved machine, or a billing question.',
    free: '—',
    pro: 'Via your receipt',
    studio: 'Via your receipt',
  },
];

/** Real limits from the code, so nobody discovers them by hitting one. */
export const limits = [
  {
    k: 'Import',
    v: 'JPEG · PNG · WebP',
    d: 'Up to 200 MB per file and 64 megapixels per source image.',
  },
  {
    k: 'Upscale',
    v: '2× · 4×',
    d: 'A factor beyond 4×, or a result past the 256 MP ceiling, is refused with a plain message — never quietly downscaled.',
  },
  { k: 'Output ceiling', v: '256 megapixels', d: 'About 16 MP in at 4×, or 64 MP in at 2×.' },
  {
    k: 'Batch',
    v: '500 images',
    d: 'One item at a time, so a queue never competes with itself for memory.',
  },
  { k: 'Tiling', v: '64–256 px', d: 'Chosen from your free RAM and VRAM at run time.' },
  {
    k: 'WebP edge',
    v: '16,383 px',
    d: 'The format’s own maximum on one edge; export PNG or JPEG if a result is wider.',
  },
  { k: 'History', v: '200 entries', d: 'Plus up to 12 recent files. Local JSON, never uploaded.' },
  {
    k: 'System',
    v: 'Windows 10 · 11, 64-bit',
    d: 'No CUDA, no Python, no terminal, no developer tools.',
  },
] as const;

/**
 * Measured, not estimated. Run on one test machine (RTX 3050 Laptop 6 GB,
 * Ryzen 5 5600) end to end — decode, inference, encode, commit — at 4×.
 * Reproduce with `cargo run --manifest-path src-tauri/Cargo.toml --release
 * --example stage07_bench`.
 */
export const benchmarks = [
  {
    size: '512 × 384',
    engine: 'DirectML GPU',
    tile: '256',
    time: '1.0 s',
    rate: '3.0 MP/s',
    peak: '301 MB',
  },
  {
    size: '1920 × 1440',
    engine: 'DirectML GPU',
    tile: '256',
    time: '5.6 s',
    rate: '7.8 MP/s',
    peak: '331 MB',
  },
  {
    size: '4032 × 3024',
    engine: 'DirectML GPU',
    tile: '256',
    time: '19.8 s',
    rate: '9.8 MP/s',
    peak: '362 MB',
  },
  {
    size: '5300 × 3000',
    engine: 'DirectML GPU',
    tile: '256',
    time: '23.3 s',
    rate: '10.9 MP/s',
    peak: '385 MB',
  },
  {
    size: '1920 × 1440',
    engine: 'CPU (forced)',
    tile: '256',
    time: '22.8 s',
    rate: '1.9 MP/s',
    peak: '214 MB',
  },
  {
    size: '4032 × 3024',
    engine: 'GPU, 16 MB memory cap',
    tile: '64',
    time: '49.9 s',
    rate: '3.9 MP/s',
    peak: '319 MB',
  },
] as const;

export const benchmarkNote =
  'The last row squeezes Fovea’s memory budget to 16 MB on purpose to reproduce a small integrated or low-VRAM graphics chip: tiles shrink to 64 px and the job runs about 2.5× slower — degraded, never a crash.';

/**
 * Pricing. These are the values to edit when the business decides final
 * numbers — kept here so no business assumption leaks into a component.
 *
 * Grounded in the app’s actual licensing model (offline, Ed25519-signed keys
 * with Pro / Studio editions and optional per-machine binding). Fovea does
 * not lock enhancement behind a key, so tiers differ by machines covered and
 * commercial use, not by fabricated feature gates.
 */
export type Tier = {
  id: string;
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  seats: string;
  highlights: string[];
  featured: boolean;
};

export const tiers: Tier[] = [
  {
    id: 'pro',
    name: 'Fovea Pro',
    price: '$49',
    cadence: 'one-time',
    blurb:
      'The ceiling lifted: 4×, every mode, the Portrait look, and no monthly count — on one machine.',
    seats: 'Covers 1 machine',
    highlights: [
      '4× upscaling, Natural and Detail modes, the Portrait look',
      'No monthly cap — run as many images as you want',
      'Signed offline key — verified on your machine, no server',
      'Cleared for client, commercial and business work',
      'Re-issued key if you replace that machine',
    ],
    featured: false,
  },
  {
    id: 'studio',
    name: 'Fovea Studio',
    price: '$129',
    cadence: 'one-time',
    blurb: 'For studios and small teams. One purchase covering several machines.',
    seats: 'Covers up to 5 machines',
    highlights: [
      'Everything in Pro, across up to 5 machines',
      'Engine controls — force the CPU path, or claim every core',
      'Written for distributing Fovea around a team',
      'Re-issued keys as machines change',
    ],
    featured: true,
  },
  {
    id: 'evaluate',
    name: 'Free',
    price: '$0',
    cadence: 'no time limit',
    blurb:
      'The real engine on your own photos — no key, no account, no watermark. Standard mode at 2×, ten enhancements a month.',
    seats: 'Your machine',
    highlights: [
      'Standard mode at 2× — the general reconstruction model',
      'Batch, history, and all export formats',
      'GPU acceleration with automatic CPU fallback',
      '10 enhancements a calendar month, none watermarked',
    ],
    featured: false,
  },
];

/**
 * What a plan is actually allowed to run on the machine, as the desktop app
 * enforces it at its command boundary (`services::license::minimum_edition`
 * and `FREE_MAX_SCALE` in the Fovea source). /download and the pricing cards
 * read this instead of restating it, so the install page can never promise a
 * ceiling the build refuses. Keep it in step with that table.
 */
export type PlanFact = { k: string; v: string };

export const planFacts: Record<'evaluate' | 'pro' | 'studio', PlanFact[]> = {
  evaluate: [
    { k: 'Scale', v: '2×' },
    { k: 'Modes', v: 'Standard' },
    { k: 'Finishing looks', v: 'All but Portrait' },
    { k: 'Enhancements', v: '10 a calendar month' },
    { k: 'License key', v: 'None needed' },
  ],
  pro: [
    { k: 'Scale', v: '2× and 4×' },
    { k: 'Modes', v: 'Standard, Natural, Detail' },
    { k: 'Finishing looks', v: 'All eleven' },
    { k: 'Enhancements', v: 'Unlimited' },
    { k: 'License key', v: 'FOVEA1. — activate once' },
  ],
  studio: [
    { k: 'Scale', v: '2× and 4×' },
    { k: 'Modes', v: 'Standard, Natural, Detail' },
    { k: 'Finishing looks', v: 'All eleven' },
    { k: 'Enhancements', v: 'Unlimited' },
    { k: 'Engine controls', v: 'CPU-only and full-power' },
    { k: 'License key', v: 'One key, up to 5 machines' },
  ],
};

export const faqs = [
  {
    q: 'Is the free version crippled in any way?',
    a: 'It is capped, not crippled — and the cap is honest about itself. Free runs the same bundled model doing real reconstruction: Standard mode at 2×, the batch queue, the history journal, every export format, GPU acceleration with CPU fallback, no watermark, no sign-in and no time limit, with ten enhancements in a calendar month. What it does not carry is the top end of the engine: 4×, the Natural and Detail modes, the Portrait look, and unlimited processing. That is what a $49 key switches on, offline and permanently.',
  },
  {
    q: 'What exactly does a key switch on?',
    a: 'Four things, each enforced by the app itself rather than just claimed on this page: 4× upscaling, the Natural and Detail restoration modes, the Portrait finishing look, and no monthly count. Studio adds the engine controls in Settings. Everything else — import, Standard mode at 2×, batch, history, PNG, JPEG and WebP export, GPU acceleration — keeps running with no key at all, and a failed or cancelled run never spends one of your ten.',
  },
  {
    q: 'Does Fovea upload my images?',
    a: 'No. Fovea runs a local AI model that is bundled with the app. There is no upload step, and no image, thumbnail, file path or history entry is sent anywhere or written to the log.',
  },
  {
    q: 'Does it need an internet connection?',
    a: 'No. After the one-time download and install, Fovea works fully offline — enhancement, batch, export, and even license activation all complete without a connection. ONNX Runtime’s Windows telemetry is explicitly switched off at startup, and the app has no HTTP client at run time.',
  },
  {
    q: 'What Windows versions are supported?',
    a: 'Windows 10 and Windows 11, 64-bit. The installer is a normal setup you can run without administrator rights, and it bundles the AI model and runtime — you never install Node, Rust, Python, CUDA or Visual Studio.',
  },
  {
    q: 'Does it work without a dedicated graphics card?',
    a: 'Yes. When a DirectX 12 GPU is available Fovea uses it through DirectML for speed; when it isn’t, it falls back to your processor automatically and produces the same quality, just more slowly. If a GPU run fails partway through an image, Fovea retries that job on the CPU and then with smaller tiles, and tells you which device actually finished it.',
  },
  {
    q: 'How much memory does a large image need?',
    a: 'Fovea sizes its working tiles from your free RAM and VRAM before it starts, so a very large image costs time rather than crashing. Measured peak memory on a 5300 × 3000 source was about 385 MB; squeezing the budget to 16 MB shrinks tiles to 64 px and completes the same job roughly 2.5× slower.',
  },
  {
    q: 'What are the real limits?',
    a: 'Sources up to 200 MB and 64 megapixels, output capped at 256 megapixels (about 16 MP in at 4×, or 64 MP in at 2×), batches of up to 500 images, and a history journal of 200 entries. Anything above a limit is refused with a plain message instead of being silently clamped.',
  },
  {
    q: 'What image formats can I use?',
    a: 'You can import JPEG, PNG and WebP, and export to all three. PNG export is lossless, JPEG and WebP offer a quality control from 1 to 100. EXIF orientation is applied on import, so a rotated phone photo comes in the right way up.',
  },
  {
    q: 'What does 2× and 4× actually mean?',
    a: 'The output is that multiple larger in each dimension — a 4× result is four times wider and taller, sixteen times the pixels. The bundled model is a 4× model, so 2× is produced by running 4× and then resampling down to the exact target size: pixels the model generated, reduced, rather than a small image stretched.',
  },
  {
    q: 'What’s the difference between the three modes?',
    a: 'They are genuinely different work, not three labels for one setting. Standard and Natural run two separate model files (Natural uses Real-ESRGAN’s denoising WDN variant, which keeps grain calmer), and Detail runs Standard plus a real unsharp pass over the result. Fovea’s own QA asserts that the three produce different bytes.',
  },
  {
    q: 'Will Fovea overwrite or damage my originals?',
    a: 'No. Fovea never writes to the file you imported. Results go to its own app folder until you export, and an export writes a new file into the folder you chose — atomically, via a temporary file that is renamed into place, so a crash mid-write cannot leave you a half-saved image. If the destination name is taken, it gains a numeric suffix.',
  },
  {
    q: 'Where are my processed images saved?',
    a: 'Working results are kept in Fovea’s private app folder until you export. When you export you choose the exact folder; the default is a Fovea folder in your Documents, and batch results go to a Batch folder beside it.',
  },
  {
    q: 'How does licensing work?',
    a: 'A license is a signed key beginning FOVEA1. that you paste into Settings → License. It is verified offline on your machine by a public key built into the app and stored in Windows Credential Manager. Enhancement runs with or without a key — the plan sets the ceiling, it does not switch the engine off — so a licensing problem can never lose work you already have, and deactivating simply drops you back to the free limits.',
  },
  {
    q: 'You say "up to 5 machines" — does the software count them?',
    a: 'Honest answer: no. A key can optionally be bound to a single specific machine, and Fovea will refuse such a key on a different computer. Nothing in the app counts five seats or polices how you spread a key — machine coverage is the term you’re agreeing to, enforced by that agreement rather than by the software.',
  },
  {
    q: 'Can I move my license to a new computer?',
    a: 'Yes. Deactivate in Settings → License, then activate on the new machine; a machine-bound key will simply be re-issued for it. Reinstalling Fovea does not consume a new place in your license.',
  },
  {
    q: 'Is my history or usage reported to you?',
    a: 'Never. History is a plain JSON file inside Fovea’s own app folder on your disk, and no network code in the app can read it. You can clear the journal from Settings, and doing so deletes records only — your images are untouched.',
  },
  {
    q: 'Why is it a one-time price instead of a subscription?',
    a: 'Because there is no service to pay for. The model runs on your hardware, so a subscription would be rent for a server we never use. You buy a license once and it keeps working offline.',
  },
] as const;
