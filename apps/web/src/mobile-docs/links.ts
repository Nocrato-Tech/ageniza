/** Where the page lives and where the files it does not render live (the repository is public). */
export const MOBILE_BASE = '/mobile';
export const API_REFERENCE_KEY = 'api';
export const REPO_BLOB_URL = 'https://github.com/Nocrato-Tech/ageniza/blob/develop/';

const GUIDE_DIR = 'docs/mobile/';
/** The generated API reference and its OpenAPI file are both shown by the "Referência da API" tab. */
const API_REFERENCE_FILES: ReadonlySet<string> = new Set(['docs/api/README.md', 'docs/api/openapi.json']);

export type ResolvedLink = { kind: 'page'; to: string } | { kind: 'external'; href: string };

/** `README.md` is the home of the page; every other file is its path under `docs/mobile/` without the extension. */
export const pageKey = (file: string): string => {
  const key = file.replace(/\.md$/, '');
  return key === 'README' ? '' : key;
};

export const pagePath = (key: string): string => (key === '' ? MOBILE_BASE : `${MOBILE_BASE}/${key}`);

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Turns a link written for GitHub (relative to the file that holds it) into one that works inside the page:
 * another guide file becomes a page of `/mobile`, the generated API files become the reference tab, and anything else
 * in the repository opens on GitHub. `guideFiles` are the paths under `docs/mobile/`, like `fluxos/entrada.md`.
 */
export function resolveDocLink(href: string, fromFile: string, guideFiles: ReadonlySet<string>): ResolvedLink {
  if (href.startsWith('#')) return { kind: 'page', to: `${pagePath(pageKey(fromFile))}${href}` };
  if (SCHEME.test(href) || href.startsWith('//')) return { kind: 'external', href };

  const hashAt = href.indexOf('#');
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const target = new URL(hashAt === -1 ? href : href.slice(0, hashAt), `http://repo.invalid/${GUIDE_DIR}${fromFile}`);
  const repoPath = decodeURIComponent(target.pathname.slice(1));

  if (repoPath.startsWith(GUIDE_DIR) && guideFiles.has(repoPath.slice(GUIDE_DIR.length))) {
    return { kind: 'page', to: `${pagePath(pageKey(repoPath.slice(GUIDE_DIR.length)))}${hash}` };
  }
  if (API_REFERENCE_FILES.has(repoPath)) return { kind: 'page', to: pagePath(API_REFERENCE_KEY) };
  return { kind: 'external', href: `${REPO_BLOB_URL}${repoPath.split('/').map(encodeURIComponent).join('/')}${hash}` };
}
