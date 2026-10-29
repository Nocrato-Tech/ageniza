/**
 * The guide is `docs/mobile/` itself: Vite reads the files when it builds the page, so a change in the Markdown shows up
 * on the next build and there is no copy to keep in sync.
 */
const files = import.meta.glob('../../../../docs/mobile/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface GuidePage {
  /** Path under `docs/mobile/`, like `fluxos/entrada.md`. */
  file: string;
  /** Path under `/mobile`; empty for the README. */
  key: string;
  title: string;
  source: string;
}

/** Reading order of the sidebar; a file that is not listed follows, in alphabetical order. */
const ORDER = ['README.md', 'comecar.md', 'fluxos/entrada.md', 'fluxos/agencia.md', 'fluxos/portal.md', 'fluxos/link-de-aprovacao.md'];

const firstHeading = (source: string): string => /^# (.+)$/m.exec(source)?.[1]?.trim() ?? '';
const keyOf = (file: string): string => (file === 'README.md' ? '' : file.replace(/\.md$/, ''));

const rank = (file: string): number => {
  const at = ORDER.indexOf(file);
  return at === -1 ? ORDER.length : at;
};

export function buildGuide(sources: Readonly<Record<string, string>>): GuidePage[] {
  return Object.entries(sources)
    .map(([path, source]) => {
      const file = path.slice(path.indexOf('docs/mobile/') + 'docs/mobile/'.length);
      return { file, key: keyOf(file), title: file === 'README.md' ? 'Visão geral' : firstHeading(source), source: source.replace(/\r\n/g, '\n') };
    })
    .sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file));
}

export const guide: readonly GuidePage[] = buildGuide(files);
export const guideFiles: ReadonlySet<string> = new Set(guide.map((page) => page.file));
