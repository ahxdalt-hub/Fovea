import type { MetadataRoute } from 'next';
import { site } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${site.url}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${site.url}/product`, lastModified: now, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${site.url}/download`, lastModified: now, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${site.url}/docs`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
  ];
}
