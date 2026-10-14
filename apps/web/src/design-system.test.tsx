// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ui from '@ageniza/ui';

import { componentEntries } from './design-system/components.js';
import { groupTokens, parseTokens } from './design-system/tokens.js';

const STYLES = join(__dirname, 'styles');
const declared = (file: string): string[] => [...readFileSync(join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]!);

const declaredValues = (file: string): Map<string, string> =>
  new Map([...readFileSync(join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((match) => [match[1]!, match[2]!.trim()] as const));

/** Exported with a capital letter but not a component, so the registry has nothing to show; give the name and the reason. */
const NOT_COMPONENTS: ReadonlyMap<string, string> = new Map();

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

describe('/design-system in development', { timeout: 30_000 }, () => {
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

  it.each(['light', 'dark'] as const)('shows in the %s panel the value the theme gives each semantic token', async (theme) => {
    await renderAt('/design-system');
    const panel = within(await screen.findByTestId(`semantic-${theme}`));
    const light = declaredValues('tokens/semantic.css');
    const dark = declaredValues('themes/dark.css');
    for (const [name, lightValue] of light) {
      if (name.startsWith('--shadow-')) continue;
      const expected = theme === 'dark' ? dark.get(name) ?? lightValue : lightValue;
      const shown = panel.getByText(name).closest('li')!.querySelector('.ds-token__value')!.textContent;
      expect(shown, `${theme} ${name}`).toBe(expected);
    }
    expect(dark.get('--bg-canvas')).not.toBe(light.get('--bg-canvas'));
  });

  it('shows the elevation of each theme with its own value', async () => {
    await renderAt('/design-system');
    const light = declaredValues('tokens/semantic.css').get('--shadow-floating')!;
    const dark = declaredValues('themes/dark.css').get('--shadow-floating') ?? light;
    for (const [theme, expected] of [['light', light], ['dark', dark]] as const) {
      const shown = within(await screen.findByTestId(`elevation-${theme}`)).getByText('--shadow-floating').closest('li')!.querySelector('.ds-token__value')!.textContent;
      expect(shown, theme).toBe(expected);
    }
  });

  it('switches the theme of the components', async () => {
    await renderAt('/design-system');
    const panel = await screen.findByTestId('components-panel');
    expect(panel.getAttribute('data-theme')).toBe('light');
    const dark = screen.getByRole('button', { name: 'Escuro', pressed: false });
    fireEvent.click(dark);
    expect(panel.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Escuro' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Claro' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('puts each component in a table whose columns are its states', async () => {
    await renderAt('/design-system');
    const panel = within(await screen.findByTestId('components-panel'));
    const table = panel.getByRole('heading', { name: 'Button', level: 3 }).parentElement!;
    const columns = within(table).getAllByRole('columnheader').map((header) => header.textContent);
    expect(columns).toEqual(['Variante', 'Padrão', 'Hover' + 'passe o mouse', 'Foco' + 'navegue com Tab', 'Desativado', 'Carregando']);
    const row = within(table).getByRole('row', { name: /primary/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells.map((cell) => cell.querySelector('button')?.hasAttribute('disabled'))).toEqual([false, false, false, true, false]);
    expect(cells.map((cell) => cell.querySelector('button')?.getAttribute('aria-disabled') ?? null)).toEqual([null, null, null, null, 'true']);
    expect(cells.map((cell) => cell.querySelector('button')?.getAttribute('aria-busy') ?? null)).toEqual([null, null, null, null, 'true']);
  });

  it('shows Segmented frozen when disabled and busy when loading, and Tabs with the disabled tabs', async () => {
    await renderAt('/design-system');
    const panel = within(await screen.findByTestId('components-panel'));
    const rows = (name: string) => within(panel.getByRole('heading', { name, level: 3 }).parentElement!).getAllByRole('row').slice(1)
      .map((row) => [within(row).getByRole('rowheader').firstChild!.textContent, row.querySelector('td')!] as const);
    const segmented = rows('Segmented').map(([state, cell]) => [state, cell.querySelector('[role=radiogroup]')!] as const);
    expect(segmented.map(([state]) => state)).toEqual(['Padrão', 'Hover', 'Foco', 'Desativado', 'Carregando']);
    expect(segmented.map(([, group]) => group.getAttribute('aria-disabled'))).toEqual([null, null, null, 'true', null]);
    expect(segmented.map(([, group]) => group.getAttribute('aria-busy'))).toEqual([null, null, null, null, 'true']);
    const tabs = rows('Tabs').map(([, cell]) => [...cell.querySelectorAll('[role=tab]')].map((tab) => (tab as HTMLButtonElement).disabled));
    expect(tabs).toEqual([[false, false, true], [false, false, true], [false, false, true], [true, true, true], [false, false, true]]);
  });

  it('puts the states of the wide components in rows', async () => {
    await renderAt('/design-system');
    const panel = within(await screen.findByTestId('components-panel'));
    for (const name of ['Pagination', 'Segmented', 'Tabs']) {
      const table = panel.getByRole('heading', { name, level: 3 }).parentElement!;
      expect(within(table).getAllByRole('rowheader').map((header) => header.firstChild!.textContent), name).toEqual(['Padrão', 'Hover', 'Foco', 'Desativado', 'Carregando']);
    }
  });

  it('lets a table of five columns scroll instead of squeezing the components', () => {
    const css = readFileSync(join(__dirname, 'design-system', 'design-system.css'), 'utf8');
    expect(css).toMatch(/\.ds-component table \{[^}]*min-width: 44rem/);
  });

  it('says "não se aplica" for a state a component does not have', async () => {
    await renderAt('/design-system');
    const panel = within(await screen.findByTestId('components-panel'));
    const table = panel.getByRole('heading', { name: 'Avatar', level: 3 }).parentElement!;
    const row = within(table).getByRole('row', { name: /^md/ });
    expect(within(row).getAllByLabelText('não se aplica').length).toBe(2);
  });

  it('catalogues every component exported by @ageniza/ui', () => {
    const exported = Object.keys(ui).filter((name) => /^[A-Z]/.test(name) && !NOT_COMPONENTS.has(name));
    const covered = new Set(componentEntries.flatMap((entry) => entry.covers));
    const missing = exported.filter((name) => !covered.has(name));
    expect(missing, `No entry in apps/web/src/design-system/components.tsx for: ${missing.join(', ')}. Add { id, name, covers: [...], examples: [{ label, render: (state) => ... }] } (docs/design-system.md, section 24), or list the export in NOT_COMPONENTS in this test with the reason.`).toEqual([]);
    const gone = [...covered].filter((name) => !exported.includes(name));
    expect(gone, `Entries in components.tsx cover names @ageniza/ui no longer exports: ${gone.join(', ')}. Remove them from \`covers\`.`).toEqual([]);
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
