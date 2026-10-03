/**
 * Pixora — single source of truth for the website's content and business
 * data. Everything a marketer needs to change (pricing, positioning, FAQ)
 * lives here; the section components read from it. Facts are kept honest to
 * what the desktop app actually does (see the README's stage notes).
 */

export const site = {
  name: 'Pixora',
  tagline: 'Enhance and upscale images on your own computer.',
  url: 'https://pixora.app',
  description:
    'Pixora is a Windows app that enhances and upscales your photos with a local AI model. Your images are processed on your own machine and never uploaded.',
} as const;

export const navLinks = [
  { href: '#problem', label: 'Why Pixora' },
  { href: '#showcase', label: 'Results' },
  { href: '#privacy', label: 'Privacy' },
  { href: '#features', label: 'Features' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
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

/** Only capabilities that genuinely exist in the app. */
export const features = [
  {
    title: '2× and 4× upscaling',
    body: 'Genuinely larger output, not a stretched preview. 4× suits print; 2× is often plenty for screens.',
  },
  {
    title: 'Real AI enhancement',
    body: 'Real-ESRGAN reconstructs detail. Three distinct behaviors — Standard, Natural and Detail.',
  },
  {
    title: 'Before / after compare',
    body: 'A split slider at full resolution, so you can judge the result before exporting.',
  },
  {
    title: 'Batch processing',
    body: 'Run a whole folder through the same settings and check each item’s outcome.',
  },
  {
    title: 'GPU acceleration, CPU fallback',
    body: 'Uses any DirectX 12 graphics card through DirectML — no CUDA — and falls back to the processor automatically.',
  },
  {
    title: 'Fully local',
    body: 'The model ships with the app. There is no upload step, and no account or server is involved.',
  },
  {
    title: 'Multiple export formats',
    body: 'PNG keeps every pixel; JPEG and WebP offer a real quality control. Choose your folder.',
  },
  {
    title: 'Remembers your work',
    body: 'A local history journal and recent-files list make it easy to pick up where you left off.',
  },
] as const;

/**
 * Pricing. These are the values to edit when the business decides final
 * numbers — kept here so no business assumption leaks into a component.
 *
 * Grounded in the app’s actual licensing model (offline, Ed25519-signed keys
 * with Pro / Studio editions and optional per-machine binding). Pixora does
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
    name: 'Pixora Pro',
    price: '$49',
    cadence: 'one-time',
    blurb: 'For a single machine. The full app, for your personal and freelance work.',
    seats: '1 computer',
    highlights: [
      'Every enhancement mode, 2× and 4×',
      'Batch processing and history journal',
      'All export formats',
      'Offline activation — no server, no account',
    ],
    featured: false,
  },
  {
    id: 'studio',
    name: 'Pixora Studio',
    price: '$129',
    cadence: 'one-time',
    blurb: 'For studios and teams. Covers multiple machines and commercial use.',
    seats: 'Up to 5 computers',
    highlights: [
      'Everything in Pro, on up to 5 machines',
      'Cleared for client and commercial work',
      'Priority updates',
      'One key to distribute, per-machine binding',
    ],
    featured: true,
  },
  {
    id: 'evaluate',
    name: 'Try it free',
    price: '$0',
    cadence: 'no time limit',
    blurb: 'Run Pixora and see your own results first. Enhancement is not locked behind a key.',
    seats: 'Your machine',
    highlights: [
      'Full workflow, free to run',
      'Activate a license any time',
      'Nothing is gated while you evaluate',
    ],
    featured: false,
  },
];

export const faqs = [
  {
    q: 'Does Pixora upload my images?',
    a: 'No. Pixora runs a local AI model that is bundled with the app. There is no upload step, and no image or file path is sent anywhere or written to the log.',
  },
  {
    q: 'Does it need an internet connection?',
    a: 'No. After the one-time install, Pixora works fully offline — enhancement, batch, export, and even license activation all run without a connection.',
  },
  {
    q: 'What Windows versions are supported?',
    a: 'Windows 10 and Windows 11, 64-bit. The installer is a normal setup you can run without administrator rights or any developer tools.',
  },
  {
    q: 'Does it work without a dedicated graphics card?',
    a: 'Yes. When a DirectX 12 GPU is available Pixora uses it through DirectML for speed; when it isn’t, it falls back to your processor automatically. Nothing fails over a missing GPU.',
  },
  {
    q: 'What image formats can I use?',
    a: 'You can import JPEG, PNG and WebP, and export to all three. PNG export is lossless; JPEG and WebP offer a quality control.',
  },
  {
    q: 'What does 2× and 4× actually mean?',
    a: 'The output is that multiple larger in each dimension — a 4× result is four times wider and taller, so sixteen times the pixels, produced by the model rather than by simple stretching.',
  },
  {
    q: 'Where are my processed images saved?',
    a: 'Working results are kept in Pixora’s private app folder until you export. When you export, you choose the exact folder, and each file is written atomically so it never lands half-saved.',
  },
  {
    q: 'How does licensing work?',
    a: 'A license is a signed key you paste into Settings → License. It’s verified offline on your machine and stored securely. Enhancement itself works with or without a license, so a licensing hiccup can never block your work.',
  },
] as const;
