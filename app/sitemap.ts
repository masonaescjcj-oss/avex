import type { MetadataRoute } from 'next';
import { posts, projects } from '@/lib/content';
import { site } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: site.url, changeFrequency: 'monthly', priority: 1, lastModified: now },
    { url: `${site.url}/services`, changeFrequency: 'monthly', priority: 0.9, lastModified: now },
    { url: `${site.url}/work`, changeFrequency: 'monthly', priority: 0.8, lastModified: now },
    { url: `${site.url}/process`, changeFrequency: 'yearly', priority: 0.7, lastModified: now },
    { url: `${site.url}/about`, changeFrequency: 'yearly', priority: 0.7, lastModified: now },
    { url: `${site.url}/blog`, changeFrequency: 'weekly', priority: 0.7, lastModified: now },
    { url: `${site.url}/careers`, changeFrequency: 'monthly', priority: 0.6, lastModified: now },
    { url: `${site.url}/contact`, changeFrequency: 'yearly', priority: 0.9, lastModified: now },
  ];

  return [
    ...staticRoutes,
    ...projects.map((p) => ({
      url: `${site.url}/work/${p.slug}`,
      changeFrequency: 'yearly' as const,
      priority: 0.6,
      lastModified: now,
    })),
    ...posts.map((p) => ({
      url: `${site.url}/blog/${p.slug}`,
      changeFrequency: 'yearly' as const,
      priority: 0.5,
      lastModified: new Date(p.date),
    })),
  ];
}
