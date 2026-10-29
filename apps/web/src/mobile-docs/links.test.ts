import { describe, expect, it } from 'vitest';

import { buildGuide, guide, guideFiles } from './content.js';
import { headingSlug, remarkHeadingIds, type MarkdownNode } from './headings.js';
import { REPO_BLOB_URL, pageKey, pagePath, resolveDocLink } from './links.js';

const FILES = new Set(['README.md', 'comecar.md', 'fluxos/entrada.md', 'fluxos/agencia.md']);
const resolve = (href: string, from: string) => resolveDocLink(href, from, FILES);

describe('resolveDocLink', () => {
  it('keeps a link between guide files inside the page, with its anchor', () => {
    expect(resolve('fluxos/entrada.md#termos-e-privacidade', 'comecar.md')).toEqual({ kind: 'page', to: '/mobile/fluxos/entrada#termos-e-privacidade' });
    expect(resolve('../comecar.md#3-o-que-falta-no-backend-para-o-app', 'fluxos/entrada.md')).toEqual({ kind: 'page', to: '/mobile/comecar#3-o-que-falta-no-backend-para-o-app' });
    expect(resolve('agencia.md', 'fluxos/entrada.md')).toEqual({ kind: 'page', to: '/mobile/fluxos/agencia' });
  });

  it('sends the README to the home of the page', () => {
    expect(resolve('../README.md', 'fluxos/entrada.md')).toEqual({ kind: 'page', to: '/mobile' });
  });

  it('keeps an anchor-only link on the page it is written in', () => {
    expect(resolve('#ciclo', 'fluxos/agencia.md')).toEqual({ kind: 'page', to: '/mobile/fluxos/agencia#ciclo' });
    expect(resolve('#ciclo', 'README.md')).toEqual({ kind: 'page', to: '/mobile#ciclo' });
  });

  it('shows the generated API files in the reference tab', () => {
    expect(resolve('../../api/README.md', 'fluxos/entrada.md')).toEqual({ kind: 'page', to: '/mobile/api' });
    expect(resolve('../api/openapi.json', 'README.md')).toEqual({ kind: 'page', to: '/mobile/api' });
  });

  it('opens any other file of the repository on GitHub, and an absolute address as it is', () => {
    expect(resolve('../local-environment.md', 'comecar.md')).toEqual({ kind: 'external', href: `${REPO_BLOB_URL}docs/local-environment.md` });
    expect(resolve('../../../specs/clientes.md#x', 'fluxos/agencia.md')).toEqual({ kind: 'external', href: `${REPO_BLOB_URL}specs/clientes.md#x` });
    expect(resolve('https://dev.ageniza.com.br/health', 'README.md')).toEqual({ kind: 'external', href: 'https://dev.ageniza.com.br/health' });
  });

  it('does not treat a guide file that does not exist as a page', () => {
    expect(resolve('fluxos/inexistente.md', 'comecar.md')).toEqual({ kind: 'external', href: `${REPO_BLOB_URL}docs/mobile/fluxos/inexistente.md` });
  });
});

describe('page keys', () => {
  it('maps files to addresses', () => {
    expect(pageKey('README.md')).toBe('');
    expect(pageKey('fluxos/portal.md')).toBe('fluxos/portal');
    expect(pagePath('')).toBe('/mobile');
    expect(pagePath('comecar')).toBe('/mobile/comecar');
  });
});

describe('headingSlug', () => {
  it('follows the anchors GitHub gives, accents included', () => {
    expect(headingSlug('3. O que falta no backend para o app')).toBe('3-o-que-falta-no-backend-para-o-app');
    expect(headingSlug('Termos e Privacidade')).toBe('termos-e-privacidade');
    expect(headingSlug('Assinatura (só o Owner)')).toBe('assinatura-só-o-owner');
    expect(headingSlug('Estudo de marca e personas')).toBe('estudo-de-marca-e-personas');
  });

  it('numbers a repeated heading like GitHub does', () => {
    const heading = (text: string): MarkdownNode => ({ type: 'heading', depth: 2, children: [{ type: 'text', value: text }] });
    const tree: MarkdownNode = { type: 'root', children: [heading('Regras'), heading('Regras'), heading('Regras')] };
    remarkHeadingIds()(tree);
    expect(tree.children!.map((node) => node.data?.hProperties?.id)).toEqual(['regras', 'regras-1', 'regras-2']);
  });

  it('reads the text of a heading that has inline code in it', () => {
    const tree: MarkdownNode = { type: 'root', children: [{ type: 'heading', depth: 2, children: [{ type: 'text', value: 'Rota ' }, { type: 'inlineCode', value: 'GET /me' }] }] };
    remarkHeadingIds()(tree);
    expect(tree.children![0]!.data?.hProperties?.id).toBe('rota-get-me');
  });
});

describe('the guide', () => {
  it('lists every file of docs/mobile, README first', () => {
    expect(guide[0]!.file).toBe('README.md');
    expect(guide.map((page) => page.file)).toEqual(['README.md', 'comecar.md', 'fluxos/entrada.md', 'fluxos/agencia.md', 'fluxos/portal.md', 'fluxos/link-de-aprovacao.md']);
    expect(guideFiles.has('fluxos/agencia.md')).toBe(true);
  });

  it('puts a file nobody ordered after the known ones and takes its title from the first heading', () => {
    const pages = buildGuide({ '../docs/mobile/zeta.md': '# Zeta\r\n', '../docs/mobile/README.md': '# Home', '../docs/mobile/fluxos/novo.md': '# Fluxo novo' });
    expect(pages.map((page) => [page.file, page.key, page.title])).toEqual([['README.md', '', 'Visão geral'], ['fluxos/novo.md', 'fluxos/novo', 'Fluxo novo'], ['zeta.md', 'zeta', 'Zeta']]);
    expect(pages[2]!.source).toBe('# Zeta\n');
  });
});
