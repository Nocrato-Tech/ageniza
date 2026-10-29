// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

import { getReference } from './api-reference.js';
import { guide } from './content.js';
import { GuideMarkdown } from './markdown.js';
import MobileDocsPage, { MOBILE_DOCS_MARKER } from './page.js';

const MOBILE_DIR = join(__dirname, '../../../../docs/mobile');
const FENCE = '```';

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="mobile/*" element={<MobileDocsPage />} /></Routes>
    </MemoryRouter>
  );

const mermaidBlocks = (source: string): string[] => [...source.matchAll(new RegExp(`${FENCE}mermaid\\n([\\s\\S]*?)\\n${FENCE}`, 'g'))].map((match) => match[1]!);

beforeEach(() => {
  window.scrollTo = vi.fn();
  mermaid.initialize.mockReset();
  mermaid.render.mockReset().mockImplementation(async (id: string) => ({ svg: `<svg id="${id}" data-drawn="true"></svg>` }));
});
afterEach(cleanup);

describe('the guide on /mobile', () => {
  it('shows the README with the pages of docs/mobile in the sidebar', () => {
    renderAt('/mobile');
    expect(screen.getByTestId(MOBILE_DOCS_MARKER)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Ageniza no celular — ponto de partida' })).toBeTruthy();
    const side = within(screen.getByRole('complementary', { name: 'Páginas do guia' }));
    expect(side.getAllByRole('link').map((link) => link.textContent)).toEqual(guide.map((page) => page.title));
    expect(side.getByRole('link', { name: 'Visão geral' }).getAttribute('aria-current')).toBe('page');
  });

  it('opens another page from the sidebar and from a link written inside the Markdown', () => {
    renderAt('/mobile');
    const main = within(screen.getByRole('main'));
    fireEvent.click(main.getByRole('link', { name: 'Entrada' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Entrada' })).toBeTruthy();
    expect(within(screen.getByRole('complementary', { name: 'Páginas do guia' })).getByRole('link', { name: 'Entrada' }).getAttribute('aria-current')).toBe('page');

    fireEvent.click(within(screen.getByRole('complementary', { name: 'Páginas do guia' })).getByRole('link', { name: guide[1]!.title }));
    expect(screen.getByRole('heading', { level: 1, name: guide[1]!.title })).toBeTruthy();
  });

  it('says the page does not exist for a path that is not in the guide', () => {
    renderAt('/mobile/fluxos/inexistente');
    expect(screen.getByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
  });

  it('turns every link between guide files into a page of /mobile whose anchor exists', () => {
    const idsOf = new Map<string, Set<string>>();
    const linksOf = new Map<string, string[]>();
    for (const page of guide) {
      const { container, unmount } = render(<MemoryRouter><GuideMarkdown page={page} /></MemoryRouter>);
      idsOf.set(`/mobile${page.key === '' ? '' : `/${page.key}`}`, new Set([...container.querySelectorAll('[id]')].map((node) => node.id)));
      linksOf.set(page.file, [...container.querySelectorAll('a')].map((link) => link.getAttribute('href')!).filter((href) => href.startsWith('/mobile')));
      unmount();
    }
    const internal = [...linksOf.values()].flat();
    expect(internal.length).toBeGreaterThan(8);
    for (const [file, hrefs] of linksOf) {
      for (const href of hrefs) {
        const [path, hash] = href.split('#') as [string, string | undefined];
        if (path === '/mobile/api') continue;
        expect(idsOf.has(path), `${file} links to ${href}, which is not a page`).toBe(true);
        if (hash !== undefined) expect(idsOf.get(path)!.has(decodeURIComponent(hash)), `${file} links to ${href}, which has no such heading`).toBe(true);
      }
    }
  });

  it('opens the files that are not part of the guide on GitHub, in another tab', () => {
    const { container } = render(<MemoryRouter><GuideMarkdown page={guide.find((page) => page.file === 'comecar.md')!} /></MemoryRouter>);
    const link = [...container.querySelectorAll('a')].find((anchor) => anchor.textContent === 'docs/local-environment.md')!;
    expect(link.getAttribute('href')).toBe('https://github.com/Nocrato-Tech/ageniza/blob/develop/docs/local-environment.md');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('keeps a table inside a box that scrolls', () => {
    const { container } = render(<MemoryRouter><GuideMarkdown page={guide.find((page) => page.file === 'fluxos/entrada.md')!} /></MemoryRouter>);
    expect(container.querySelectorAll('.mdocs-table > table').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('table:not(.mdocs-table > table)').length).toBe(0);
  });
});

describe('diagrams', () => {
  it('has a mermaid block in the files where the flows are, and no arrow drawn with text', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : []));
    for (const file of files(MOBILE_DIR)) expect(readFileSync(file, 'utf8'), file).not.toContain('─▶');
    const count = (name: string) => mermaidBlocks(guide.find((page) => page.file === name)!.source).length;
    expect(count('fluxos/agencia.md')).toBe(6);
    expect(count('fluxos/entrada.md')).toBe(2);
    expect(count('fluxos/link-de-aprovacao.md')).toBe(1);
  });

  it('draws each block of the page through mermaid, themed and in strict mode', async () => {
    const page = guide.find((entry) => entry.file === 'fluxos/agencia.md')!;
    const { container } = render(<MemoryRouter><GuideMarkdown page={page} /></MemoryRouter>);
    await waitFor(() => expect(container.querySelectorAll('[data-drawn="true"]').length).toBe(6));
    expect(mermaid.render.mock.calls.map((call) => call[1] as string)).toEqual(mermaidBlocks(page.source));
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false, securityLevel: 'strict' }));
    expect(container.querySelector('pre code.language-mermaid')).toBeNull();
  });

  it('keeps the text of the diagram on the page when it cannot be drawn', async () => {
    mermaid.render.mockRejectedValue(new Error('parse error'));
    const page = guide.find((entry) => entry.file === 'fluxos/link-de-aprovacao.md')!;
    const { container } = render(<MemoryRouter><GuideMarkdown page={page} /></MemoryRouter>);
    expect(await screen.findByText(/Não foi possível desenhar o diagrama/)).toBeTruthy();
    expect(container.querySelector('details.mdocs-diagram__source')!.hasAttribute('open')).toBe(true);
    expect(container.querySelector('.mdocs-diagram__source code')!.textContent).toContain('sequenceDiagram');
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('the tab Referência da API', () => {
  it('lists every route, grouped by tag, and counts them', () => {
    renderAt('/mobile/api');
    const model = getReference();
    expect(screen.getByRole('heading', { level: 1, name: 'Referência da API' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(`${model.operationCount} rotas`);
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(model.groups.map((group) => group.name));
    expect(screen.getByRole('link', { name: 'Referência da API' }).getAttribute('aria-current')).toBe('page');
  });

  it('narrows the list by path, permission or text, and says so when nothing matches', () => {
    renderAt('/mobile/api');
    const search = screen.getByRole('searchbox', { name: 'Buscar rota ou texto' });
    fireEvent.change(search, { target: { value: '/portal-approval' } });
    const shown = document.querySelectorAll('.mdocs-op').length;
    expect(shown).toBeGreaterThan(3);
    expect(shown).toBeLessThan(getReference().operationCount);
    expect(screen.getByRole('status').textContent).toBe(`${shown} de ${getReference().operationCount} rotas`);

    fireEvent.change(search, { target: { value: 'conteudo.aprovar_pela_agencia' } });
    expect(document.querySelectorAll('.mdocs-op').length).toBeGreaterThan(0);

    fireEvent.change(search, { target: { value: 'rota-que-nao-existe-xyz' } });
    expect(document.querySelectorAll('.mdocs-op').length).toBe(0);
    expect(screen.getByText(/Nenhuma rota encontrada/)).toBeTruthy();
  });

  it('opens a route with its description, parameters, example, responses and fetch call', () => {
    renderAt('/mobile/api');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar rota ou texto' }), { target: { value: 'Cria uma conta com e-mail e senha' } });
    const operation = document.querySelector<HTMLDetailsElement>('.mdocs-op')!;
    expect(within(operation).getByText('POST')).toBeTruthy();
    expect(within(operation).getByText('/auth/sign-up')).toBeTruthy();
    expect(operation.textContent).not.toContain('credentials');

    operation.open = true;
    fireEvent(operation, new Event('toggle'));
    expect(within(operation).getByText(/nenhuma além do acesso descrito/)).toBeTruthy();
    expect(within(operation).getByLabelText('Código — Exemplo do corpo (JSON)').textContent).toContain('"acceptTerms": true');
    expect(within(operation).getByText('202')).toBeTruthy();
    expect(within(operation).getByText('400')).toBeTruthy();
    expect(within(operation).getByLabelText('Código — Exemplo com fetch').textContent).toContain("credentials: 'include'");
  });

  it('shows the permission of a route and every alternative when there is more than one', () => {
    renderAt('/mobile/api');
    const alternatives = getReference().groups.flatMap((group) => group.operations).find((operation) => operation.permissions.length > 1)!;
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar rota ou texto' }), { target: { value: alternatives.id } });
    const operation = document.getElementById(`op-${alternatives.id}`) as HTMLDetailsElement;
    for (const permission of alternatives.permissions) expect(within(operation).getByText(permission, { selector: '.mdocs-op__pill' })).toBeTruthy();
    operation.open = true;
    fireEvent(operation, new Event('toggle'));
    expect(within(operation).getByText(/Uma destas permissões/)).toBeTruthy();
  });

  it('copies the fetch example', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAt('/mobile/api');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar rota ou texto' }), { target: { value: 'Cria uma conta com e-mail e senha' } });
    const operation = document.querySelector<HTMLDetailsElement>('.mdocs-op')!;
    operation.open = true;
    fireEvent(operation, new Event('toggle'));
    const block = within(within(operation).getByRole('region', { name: 'Exemplo com fetch' }));
    fireEvent.click(block.getByRole('button', { name: 'Copiar' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("fetch(`${API_URL}/auth/sign-up`")));
    expect(await block.findByRole('button', { name: 'Copiado' })).toBeTruthy();
  });

  it('opens the route named in the address', () => {
    const target = getReference().groups[1]!.operations[0]!;
    renderAt(`/mobile/api#op-${target.id}`);
    expect((document.getElementById(`op-${target.id}`) as HTMLDetailsElement).open).toBe(true);
  });
});
