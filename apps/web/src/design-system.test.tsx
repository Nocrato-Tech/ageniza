// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ui from '@ageniza/ui';

import { componentEntries } from './design-system/components.js';
import { groupTokens, parseTokens } from './design-system/tokens.js';

const STYLES = join(__dirname, 'styles');
const declared = (file: string): string[] => [...readFileSync(join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]!);

const user = { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' };
const fetchImpl: typeof fetch = async () => new Response(null, { status: 401 });

// Every module is imported again per render: `import.meta.env.DEV` is read when routes.tsx loads, and the contexts must come from the same module graph as the routes.
const renderAt = async (path: string, isAuthenticated = false) => {
  vi.resetModules();
  const [{ AuthSessionProvider, createAuthSessionStore }, { ApiClientProvider, HttpClient }, { createQueryClient }, { ApplicationRoutes }] =
    await Promise.all([import('./auth.js'), import('./http.js'), import('./query.js'), import('./routes.js')]);
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  return render(
    <AuthSessionProvider store={createAuthSessionStore(client)}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}><MemoryRouter initialEntries={[path]}>
          <ApplicationRoutes session={{ status: 'ready', isAuthenticated, user: isAuthenticated ? user : null }} />
        </MemoryRouter></ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('token parsing', () => {
  it('reads every declaration, ignores comments and keeps values with parentheses and commas', () => {
    const tokens = parseTokens(`:root {
      /* --commented: out; */
      --a: #fff; /* trailing */
      --b: color-mix(in srgb, var(--a) 10%, #000);
      --c: 800 2rem/2.375rem var(--font), sans-serif;
    }`);
    expect(tokens).toEqual([
      { name: '--a', value: '#fff' },
      { name: '--b', value: 'color-mix(in srgb, var(--a) 10%, #000)' },
      { name: '--c', value: '800 2rem/2.375rem var(--font), sans-serif' }
    ]);
  });

  it('groups in file order', () => {
    const groups = groupTokens(parseTokens(':root { --x-1: 1; --y-1: 2; --x-2: 3; }'), (token) => token.name.slice(2, 3));
    expect(groups.map((group) => [group.key, group.tokens.map((token) => token.name)])).toEqual([['x', ['--x-1', '--x-2']], ['y', ['--y-1']]]);
  });
});

describe('/design-system in development', () => {
  it('opens without a session, with the tokens read from the style files', async () => {
    await renderAt('/design-system');
    expect(await screen.findByRole('heading', { level: 1, name: 'Design system' })).toBeTruthy();
    const page = document.body.textContent ?? '';
    const files = ['tokens/primitives.css', 'tokens/semantic.css', 'tokens/typography.css', 'tokens/motion.css', 'themes/dark.css'];
    for (const name of files.flatMap(declared)) expect(page, name).toContain(name);
  });

  it('shows each semantic token in both themes and marks what the dark theme overrides', async () => {
    await renderAt('/design-system');
    const light = within(await screen.findByTestId('semantic-light'));
    const dark = within(await screen.findByTestId('semantic-dark'));
    for (const name of declared('tokens/semantic.css').filter((token) => !token.startsWith('--shadow-'))) {
      expect(light.getAllByText(name).length, name).toBe(1);
      expect(dark.getAllByText(name).length, name).toBe(1);
    }
    expect(dark.getAllByText('sobrescrito no escuro').length).toBe(declared('themes/dark.css').filter((name) => !name.startsWith('--shadow-')).length);
    expect(light.queryByText('sobrescrito no escuro')).toBeNull();
  });

  it('puts each component in a table whose columns are its states', async () => {
    await renderAt('/design-system');
    const panel = within(await screen.findByTestId('components-panel'));
    const table = panel.getByRole('heading', { name: 'Button', level: 3 }).parentElement!;
    const columns = within(table).getAllByRole('columnheader').map((header) => header.textContent);
    expect(columns).toEqual(['Variante', 'Padrão', 'Hover' + 'passe o mouse', 'Foco' + 'navegue com Tab', 'Desativado', 'Carregando']);
    const row = within(table).getByRole('row', { name: /primary/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells.map((cell) => cell.querySelector('button')?.hasAttribute('disabled'))).toEqual([false, false, false, true, true]);
    expect(cells.map((cell) => cell.querySelector('button')?.getAttribute('aria-busy') ?? null)).toEqual([null, null, null, null, 'true']);
  });

  it('says "não se aplica" for a state a component does not have', async () => {
    await renderAt('/design-system');
    const panel = within(await screen.findByTestId('components-panel'));
    const table = panel.getByRole('heading', { name: 'Avatar', level: 3 }).parentElement!;
    const row = within(table).getByRole('row', { name: /^md/ });
    expect(within(row).getAllByLabelText('não se aplica').length).toBe(2);
  });

  it('catalogues every component exported by @ageniza/ui', () => {
    const exported = Object.keys(ui).filter((name) => /^[A-Z]/.test(name));
    const covered = new Set(componentEntries.flatMap((entry) => entry.covers));
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
    expect([...covered].filter((name) => !exported.includes(name))).toEqual([]);
  });

  it('does not appear in the agency menu', async () => {
    const agency = '11111111-1111-4111-8111-111111111111';
    await renderAt(`/agencia/${agency}`, true);
    await screen.findByRole('main').catch(() => undefined);
    expect(document.querySelector('a[href*="design-system"]')).toBeNull();
  });
});

describe('/design-system outside development', () => {
  it('is the ordinary not-found page', async () => {
    vi.stubEnv('DEV', false);
    await renderAt('/design-system');
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Design system' })).toBeNull();
  });
});
