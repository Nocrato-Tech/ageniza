import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(webRoot, path), 'utf8');
const publicFile = (url: string) => join(webRoot, 'public', url.replace(/^\//, ''));
const pngSize = (path: string) => {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });

describe('brand wiring', () => {
  const html = read('index.html');
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => ({
    rel: /rel="([^"]+)"/.exec(tag)?.[1],
    sizes: /sizes="([^"]+)"/.exec(tag)?.[1],
    href: /href="([^"]+)"/.exec(tag)?.[1]
  }));

  it('serves the 16 and 32 px symbol as the favicon', () => {
    expect(links).toContainEqual({ rel: 'icon', sizes: '16x16', href: '/brand/icone-16.png' });
    expect(links).toContainEqual({ rel: 'icon', sizes: '32x32', href: '/brand/icone-32.png' });
    expect(pngSize(publicFile('/brand/icone-16.png'))).toEqual({ width: 16, height: 16 });
    expect(pngSize(publicFile('/brand/icone-32.png'))).toEqual({ width: 32, height: 32 });
  });

  it('serves a favicon SVG ahead of the PNGs that follows the browser theme', () => {
    const icons = links.filter((link) => link.rel === 'icon');
    expect(icons[0]).toEqual({ rel: 'icon', sizes: 'any', href: '/favicon.svg' });
    expect(html).toContain('type="image/svg+xml" sizes="any" href="/favicon.svg"');

    const svg = readFileSync(publicFile('/favicon.svg'), 'utf8');
    const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? '';
    expect(style).toContain('path{fill:#111827}');
    expect(style).toContain('@media (prefers-color-scheme:dark){path{fill:#fff}}');
    expect(style.indexOf('path{fill:#111827}')).toBeLessThan(style.indexOf('@media'));
    expect(svg.match(/<path/g)).toHaveLength(10);
  });

  it('serves the 180 px icon as the Apple touch icon', () => {
    expect(links).toContainEqual({ rel: 'apple-touch-icon', sizes: '180x180', href: '/brand/icone-180.png' });
    expect(pngSize(publicFile('/brand/icone-180.png'))).toEqual({ width: 180, height: 180 });
  });

  it('links a manifest that lists the 180 and 512 px icons, each a real file of that size', () => {
    const manifestLink = links.find((link) => link.rel === 'manifest');
    expect(manifestLink?.href).toBe('/manifest.webmanifest');

    const manifest = JSON.parse(readFileSync(publicFile(manifestLink!.href!), 'utf8')) as {
      name: string;
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest.name).toBe('Ageniza');
    expect(manifest.icons.map(({ src, sizes, type }) => ({ src, sizes, type }))).toEqual([
      { src: '/brand/icone-180.png', sizes: '180x180', type: 'image/png' },
      { src: '/brand/icone-512.png', sizes: '512x512', type: 'image/png' }
    ]);
    for (const icon of manifest.icons) {
      const [side] = icon.sizes.split('x').map(Number);
      expect(pngSize(publicFile(icon.src))).toEqual({ width: side, height: side });
    }
  });

  it('keeps the original JPGs out of the app', () => {
    const shipped = sourceFiles(join(webRoot, 'public')).map((path) => relative(webRoot, path));
    expect(shipped.filter((path) => /\.jpe?g$/i.test(path))).toEqual([]);

    const referencing = [join(webRoot, 'index.html'), ...sourceFiles(join(webRoot, 'src'))]
      .filter((path) => !path.endsWith('brand-assets.test.ts'))
      .filter((path) => /originais|logo-completo-|simbolo-mono-|mascote-(amigavel|serio)\.jpe?g/i.test(readFileSync(path, 'utf8')))
      .map((path) => relative(webRoot, path));
    expect(referencing).toEqual([]);
  });
});
