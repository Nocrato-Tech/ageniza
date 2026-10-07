// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PROFILE_PHOTO_MAX_BYTES } from '@ageniza/contracts';
import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { inviteLinkDays } from './invite-collaborator.js';
import { pendingInviteExpiryLabel } from './pending-invitations.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

afterEach(cleanup);

const dialogDescriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
beforeAll(() => {
  // jsdom has no top layer; these stubs only model opening and closing.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => {
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const AGENCY_B = '22222222-2222-4222-8222-222222222222';
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

interface TestRole {
  readonly key: string;
  readonly name: string;
}

const ADMIN_ROLE: TestRole = { key: 'admin', name: 'Admin' };

/** Mirrors `GET /agencies/:agencyId/roles` (#287): key order, admin only for the Owner. */
const SYSTEM_ROLES = [
  { id: '0a000000-0000-4000-8000-000000000001', key: 'account_manager', name: 'Gestor de conta' },
  { id: '0a000000-0000-4000-8000-000000000002', key: 'admin', name: 'Admin' },
  { id: '0a000000-0000-4000-8000-000000000003', key: 'finance', name: 'Financeiro' },
  { id: '0a000000-0000-4000-8000-000000000004', key: 'production', name: 'Produção' },
  { id: '0a000000-0000-4000-8000-000000000005', key: 'sales', name: 'Vendas' }
] as const;
const PRODUCTION_ROLE_ID = SYSTEM_ROLES[3].id;
const ADMIN_ROLE_ID = SYSTEM_ROLES[1].id;
const rolesFor = (isOwner: boolean) => json({ data: isOwner ? SYSTEM_ROLES : SYSTEM_ROLES.filter((role) => role.key !== 'admin') });

const agencyMe = (agencyId: string, agencyName: string, permissions: readonly string[], role: TestRole, isOwner: boolean) => ({
  agencyId, agencyName, isOwner, role, permissions
});
const agencyDisplayName = (agencyId: string): string => agencyId === AGENCY_B ? 'Agência Dois' : 'Agência Um';

const anaPrado = { membershipId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Ana Prado', email: 'ana@example.test', photoUrl: null, jobTitle: 'Editora', role: { key: 'production', name: 'Produção' }, isOwner: false, isSelf: false, status: 'active', joinedAt: '2026-03-12T12:00:00.000Z' };
/** Ana as the signed-in person sees her own link: the API says so with `isSelf`, never the e-mail. */
const anaSelf = { ...anaPrado, isSelf: true };
/** The session e-mail of the signed-in person, deliberately not Ana's link e-mail (the operation changed it). */
const sessionEmailAfterChange = 'ana.nova@example.test';
const marioCosta = { membershipId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Mário Costa', email: 'mario@example.test', photoUrl: null, jobTitle: 'Copywriter', role: { key: 'production', name: 'Produção' }, isOwner: false, isSelf: false, status: 'active', joinedAt: '2026-03-13T12:00:00.000Z' };
const juliaReis = { membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Júlia Reis', email: 'julia@example.test', photoUrl: 'https://storage.test/julia.png', jobTitle: 'Social Media', role: { key: 'account_manager', name: 'Gestor de conta' }, isOwner: false, isSelf: false, status: 'active', joinedAt: '2026-03-14T12:00:00.000Z' };
const biancaSouza = { membershipId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Bianca Souza', email: 'bianca@example.test', photoUrl: null, jobTitle: 'Redatora', role: { key: 'production', name: 'Produção' }, isOwner: false, isSelf: false, status: 'active', joinedAt: '2026-03-15T12:00:00.000Z' };
const pauloLima = { membershipId: '12121212-1212-4212-8212-121212121212', name: 'Paulo Lima', email: 'paulo@example.test', photoUrl: null, jobTitle: 'Motion', role: { key: 'production', name: 'Produção' }, isOwner: false, isSelf: false, status: 'removed', joinedAt: '2026-02-10T12:00:00.000Z' };

const meta = (page: number, totalItems: number, totalPages: number) => ({ page, pageSize: 24, totalItems, totalPages });
const listResponse = (data: readonly unknown[], page = 1) => json({ data, meta: meta(page, data.length, data.length === 0 ? 0 : 1) });

/** Noon local N calendar days ahead: the label counts calendar days, so the hour must not flip it. */
const expiryInDays = (days: number): string => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

const pendingInvite = (id: string, email: string, roleKey: string, roleName: string, expiresInDays: number) => ({
  id,
  email,
  purpose: 'collaborator_invite',
  role: { key: roleKey, name: roleName },
  client: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  expiresAt: expiryInDays(expiresInDays)
});
const inviteAna = pendingInvite('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ana@exemplo.com', 'production', 'Produção', 5);
const invitePaulo = pendingInvite('ffffffff-ffff-4fff-8fff-ffffffffffff', 'paulo@exemplo.com', 'admin', 'Admin', 1);
const inviteJulia = pendingInvite('99999999-9999-4999-8999-999999999999', 'julia@exemplo.com', 'account_manager', 'Gestor de conta', 6);
const defaultInvites = [inviteAna, invitePaulo, inviteJulia];

const pageInvites = (from: number, count: number) => Array.from({ length: count }, (_value, index) => {
  const position = from + index;
  return pendingInvite(`10000000-0000-4000-8000-${String(position).padStart(12, '0')}`, `p${position}@exemplo.com`, 'production', 'Produção', 5);
});

const noContent = (): Response => new Response(null, { status: 204 });
const invitationsResponse = (data: readonly unknown[], query?: URLSearchParams, totals?: { totalItems: number; totalPages: number }): Response => {
  const page = Number(query?.get('page') ?? '1');
  return json({ data, meta: meta(page, totals?.totalItems ?? data.length, totals?.totalPages ?? (data.length === 0 ? 0 : 1)) });
};

interface Scenario {
  readonly authenticated?: boolean;
  readonly role?: TestRole;
  readonly permissions?: readonly string[];
  readonly isOwner?: boolean;
  readonly session?: () => Response | Promise<Response>;
  readonly collaborators?: (query: URLSearchParams, agencyId: string) => Response | Promise<Response>;
  readonly jobTitles?: () => Response | Promise<Response>;
  readonly roles?: (agencyId: string) => Response | Promise<Response>;
  readonly detail?: (membershipId: string, agencyId: string) => Response | Promise<Response>;
  readonly updateCollaborator?: (membershipId: string, body: unknown, agencyId: string) => Response | Promise<Response>;
  readonly removeCollaborator?: (membershipId: string, agencyId: string) => Response | Promise<Response>;
  readonly reactivate?: (membershipId: string, body: unknown, agencyId: string) => Response | Promise<Response>;
  readonly invitations?: (query: URLSearchParams, agencyId: string) => Response | Promise<Response>;
  readonly createInvitation?: (body: unknown, agencyId: string) => Response | Promise<Response>;
  readonly resend?: (invitationId: string, agencyId: string) => Response | Promise<Response>;
  readonly cancel?: (invitationId: string, agencyId: string) => Response | Promise<Response>;
  readonly updateProfile?: (body: unknown) => Response | Promise<Response>;
  readonly uploadPhoto?: (body: unknown) => Response | Promise<Response>;
}

/** Behaves like the real API: 401 without a session, the listing and the job-titles contract shapes. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const requests: string[] = [];
  const authenticated = scenario.authenticated ?? true;
  const role = scenario.role ?? ADMIN_ROLE;
  const isOwner = scenario.isOwner ?? false;
  const permissions = scenario.permissions ?? ['colaborador.visualizar', 'colaborador.convidar', 'convite.reenviar', 'convite.cancelar'];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}${url.search}`);
    requests.push(String(input));
    if (path.endsWith('/auth/session')) return scenario.session?.() ?? (authenticated ? json(sessionBody) : unauthenticated());
    if (!authenticated) return unauthenticated();
    if (init?.method === 'PATCH' && path === '/me/profile') {
      if (scenario.updateProfile === undefined) throw new Error(`unexpected PATCH ${url}`);
      return scenario.updateProfile(JSON.parse(String(init.body)));
    }
    if (init?.method === 'POST' && path === '/me/photo') {
      if (scenario.uploadPhoto === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.uploadPhoto(JSON.parse(String(init.body)));
    }
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(me[1]!, agencyDisplayName(me[1]!), permissions, role, isOwner));
    const roles = /\/agencies\/([^/]+)\/roles$/.exec(path);
    if (roles !== null && method === 'GET') {
      if (!isOwner && !permissions.includes('colaborador.convidar') && !permissions.includes('colaborador.alterar_papel')) {
        return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      }
      return scenario.roles?.(roles[1]!) ?? rolesFor(isOwner);
    }
    const createInvitation = /\/agencies\/([^/]+)\/invitations\/collaborators$/.exec(path);
    if (createInvitation !== null && method === 'POST') {
      if (!permissions.includes('colaborador.convidar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      return scenario.createInvitation?.(JSON.parse(String(init?.body)), createInvitation[1]!) ?? json({ invitationId: inviteAna.id, expiresAt: inviteAna.expiresAt }, 201);
    }
    const resend = /\/agencies\/([^/]+)\/invitations\/([^/]+)\/resend$/.exec(path);
    if (resend !== null && method === 'POST') {
      if (!permissions.includes('convite.reenviar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      return scenario.resend?.(resend[2]!, resend[1]!) ?? json({ invitationId: inviteJulia.id, expiresAt: inviteJulia.expiresAt });
    }
    const cancel = /\/agencies\/([^/]+)\/invitations\/([^/]+)$/.exec(path);
    if (cancel !== null && method === 'DELETE') {
      if (!permissions.includes('convite.cancelar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      return scenario.cancel?.(cancel[2]!, cancel[1]!) ?? noContent();
    }
    const invitations = /\/agencies\/([^/]+)\/invitations$/.exec(path);
    if (invitations !== null && method === 'GET') {
      if (!permissions.includes('colaborador.convidar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      return scenario.invitations?.(url.searchParams, invitations[1]!) ?? invitationsResponse(defaultInvites, url.searchParams);
    }
    if (path.endsWith('/collaborators/job-titles')) return scenario.jobTitles?.() ?? json({ data: ['Editora', 'Copywriter'] });
    const remove = /\/agencies\/([^/]+)\/collaborators\/([^/]+)\/remove$/.exec(path);
    if (remove !== null && method === 'POST') {
      if (!permissions.includes('colaborador.remover')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      if (scenario.removeCollaborator === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.removeCollaborator(remove[2]!, remove[1]!);
    }
    const reactivate = /\/agencies\/([^/]+)\/collaborators\/([^/]+)\/reactivate$/.exec(path);
    if (reactivate !== null && method === 'POST') {
      if (!isOwner && !permissions.includes('colaborador.alterar_papel')) {
        return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      }
      if (scenario.reactivate === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.reactivate(reactivate[2]!, JSON.parse(String(init?.body)), reactivate[1]!);
    }
    const detail = /\/agencies\/([^/]+)\/collaborators\/([^/]+)$/.exec(path);
    if (detail !== null) {
      if (!permissions.includes('colaborador.visualizar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      if (method === 'PATCH') {
        if (scenario.updateCollaborator === undefined) throw new Error(`unexpected PATCH ${url}`);
        return scenario.updateCollaborator(detail[2]!, JSON.parse(String(init?.body)), detail[1]!);
      }
      const person = [anaPrado, marioCosta, juliaReis].find((item) => item.membershipId === detail[2]);
      return scenario.detail?.(detail[2]!, detail[1]!) ?? (person === undefined
        ? json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
        : json(person));
    }
    const list = /\/agencies\/([^/]+)\/collaborators$/.exec(path);
    if (list !== null) return scenario.collaborators?.(url.searchParams, list[1]!) ?? listResponse([anaPrado, marioCosta, juliaReis]);
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
  };
  return { impl, calls, requests };
};

interface SelfFetchOptions {
  readonly uploadImageUrl?: string;
  /** Returns a response the caller controls (a deferred promise, an error status, ...). */
  readonly uploadResponse?: (body: unknown) => Response | Promise<Response>;
  /** Returns a PATCH /me/profile response the caller controls (an error status, ...). */
  readonly updateProfileResponse?: (body: unknown) => Response | Promise<Response>;
}

/**
 * The session for this scenario is Ana herself: `/auth/session` answers her name, the listing and
 * the detail carry her as `agency_memberships` does in the real API, `PATCH /me/profile` changes
 * her name (and the session's, since both come from `auth."user"`), and `POST /me/photo` returns a
 * signed URL after recording her new photo -- exactly what the real routes do.
 */
const makeSelfFetch = (options: SelfFetchOptions = {}) => {
  // `photoUrl` starts null and becomes a signed URL after the upload, like the real person row.
  type SelfPerson = Omit<typeof anaPrado, 'photoUrl'> & { photoUrl: string | null };
  let person: SelfPerson = { ...anaSelf, photoUrl: null };
  let sessionName = person.name;
  const profileBodies: unknown[] = [];
  const photoBodies: unknown[] = [];
  const uploadSuccessUrl = options.uploadImageUrl ?? 'https://storage.test/ana-nova.png';
  const fetch = makeFetch({
    session: () => json({ user: { id: sessionBody.user.id, name: sessionName, email: sessionEmailAfterChange }, session: sessionBody.session }),
    collaborators: () => json({ data: [person, marioCosta, juliaReis], meta: meta(1, 3, 1) }),
    detail: (membershipId) => membershipId === person.membershipId
      ? json(person)
      : json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404),
    updateProfile: (body) => {
      profileBodies.push(body);
      if (options.updateProfileResponse !== undefined) return options.updateProfileResponse(body);
      const name = (body as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') {
        return json({ error: { code: 'VALIDATION_ERROR', message: 'invalid name' } }, 400);
      }
      person = { ...person, name: name.trim() };
      sessionName = person.name;
      return json({ id: sessionBody.user.id, name: person.name });
    },
    uploadPhoto: (body) => {
      photoBodies.push(body);
      if (options.uploadResponse !== undefined) return options.uploadResponse(body);
      person = { ...person, photoUrl: uploadSuccessUrl };
      return json({ imageUrl: person.photoUrl! });
    }
  });
  return { ...fetch, person: () => person, profileBodies, photoBodies };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface SearchProbeTarget {
  pathname: string;
  search: string;
  navigate: NavigateFunction;
}

function SearchProbe({ probe }: { probe: SearchProbeTarget }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  probe.navigate = useNavigate();
  return null;
}

const renderCollaborators = (impl: typeof fetch, entry = `/agencia/${AGENCY_A}/colaboradores`) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: SearchProbeTarget = { pathname: '', search: '', navigate: () => undefined };
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <SearchProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { container: rendered.container, probe, queryClient };
};

const badgeNames = (container: HTMLElement): (string | null)[] =>
  Array.from(container.querySelectorAll('.ui-badge-card__name')).map((element) => element.textContent);

describe('CollaboratorsPage (/agencia/:agenciaId/colaboradores)', () => {
  it('renders the badges in the order the server returned, without reordering', async () => {
    const { impl } = makeFetch();
    const { container } = renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    // The server order is Ana, Mário, Júlia — deliberately not alphabetical.
    expect(badgeNames(container)).toEqual(['Ana Prado', 'Mário Costa', 'Júlia Reis']);
  });

  it('asks for the first page with the fixed page size', async () => {
    const { impl, calls } = makeFetch();
    renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    expect(calls.some((call) => call === `GET /agencies/${AGENCY_A}/collaborators?page=1&pageSize=24`)).toBe(true);
  });

  it('shows the invite button only with colaborador.convidar', async () => {
    const without = makeFetch({ permissions: ['colaborador.visualizar'] });
    renderCollaborators(without.impl);
    await screen.findByText('Ana Prado');
    expect(screen.queryByRole('button', { name: /Convidar/ })).toBeNull();

    cleanup();
    const withPermission = makeFetch({ permissions: ['colaborador.visualizar', 'colaborador.convidar'] });
    renderCollaborators(withPermission.impl);
    expect(await screen.findByRole('button', { name: /Convidar/ })).toBeTruthy();
  });

  it('keeps the search term when there is no result and offers to clear it', async () => {
    const { impl } = makeFetch({
      collaborators: (query) => query.get('q') === 'mariana' ? listResponse([]) : listResponse([anaPrado, marioCosta, juliaReis])
    });
    const { probe } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');

    const search = screen.getByRole('searchbox', { name: 'Buscar por nome ou e-mail' }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'mariana' } });

    expect(await screen.findByText('Nenhuma pessoa encontrada para "mariana"')).toBeTruthy();
    expect(search.value).toBe('mariana');
    expect(probe.search).toContain('q=mariana');

    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }));
    expect(await screen.findByText('Ana Prado')).toBeTruthy();
    expect(probe.search).not.toContain('q=');
    expect((screen.getByRole('searchbox', { name: 'Buscar por nome ou e-mail' }) as HTMLInputElement).value).toBe('');
  });

  it('reads the filters from the URL, sends them to the server, and writes them back', async () => {
    const queries: string[] = [];
    const { impl } = makeFetch({
      collaborators: (query) => {
        queries.push(query.toString());
        // Three pages, so the requested page 2 is valid and the #229 redirect does not interfere.
        return json({ data: [anaPrado], meta: meta(Number(query.get('page') ?? '1'), 60, 3) });
      }
    });
    const { probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?q=ana&role=production&jobTitle=Editora&page=2`);

    await screen.findByText('Ana Prado');
    expect(queries.some((query) => query.includes('q=ana') && query.includes('role=production') && query.includes('jobTitle=Editora') && query.includes('page=2') && query.includes('pageSize=24'))).toBe(true);
    expect((screen.getByRole('searchbox', { name: 'Buscar por nome ou e-mail' }) as HTMLInputElement).value).toBe('ana');
    expect((screen.getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement).value).toBe('production');

    fireEvent.change(screen.getByRole('combobox', { name: 'Papel' }), { target: { value: 'sales' } });
    await waitFor(() => expect(probe.search).toContain('role=sales'));
    // A filter change returns to the first page.
    expect(probe.search).not.toContain('page=');
  });

  it('shows the initials when the person has no photo, and the photo when they do', async () => {
    const { impl } = makeFetch();
    const { container } = renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    expect(screen.getByText('AP')).toBeTruthy();
    expect(screen.getByText('MC')).toBeTruthy();
    expect(screen.queryByText('JR')).toBeNull();
    expect(container.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/julia.png');
  });

  it('renders a hostile collaborator name as literal text, never as HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeFetch({ collaborators: () => listResponse([{ ...anaPrado, name: hostile }]) });
    const { container } = renderCollaborators(impl);

    await screen.findByText(hostile);
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws a badge-shaped skeleton on the first load', async () => {
    const { impl } = makeFetch({ collaborators: () => new Promise<Response>(() => undefined) });
    const { container } = renderCollaborators(impl);

    await screen.findByRole('link', { name: 'Agência Um' });
    expect(container.querySelectorAll('.ui-badge-card__skeleton')).toHaveLength(24);
  });

  it('offers a retry when the listing fails', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      collaborators: () => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500)
          : listResponse([anaPrado]);
      }
    });
    renderCollaborators(impl);

    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar a equipe.');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await screen.findByText('Ana Prado');
  });

  it('disables the job-title filter when the job-titles route fails, without breaking the grid', async () => {
    const { impl } = makeFetch({ jobTitles: () => json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) });
    renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    const cargo = screen.getByRole('combobox', { name: 'Cargo' }) as HTMLSelectElement;
    await waitFor(() => expect(cargo.disabled).toBe(true), { timeout: 5000 });
  });

  it('draws no empty state for the team list', async () => {
    const { impl } = makeFetch({ collaborators: () => listResponse([]) });
    const { container } = renderCollaborators(impl);

    await waitFor(() => expect(container.querySelector('.collaborators__grid')).not.toBeNull());
    expect(screen.queryByText(/Nenhuma pessoa encontrada/)).toBeNull();
    expect(screen.queryByText(/Nenhum colaborador/)).toBeNull();
  });

  it('returns to the last valid page when the URL points past the end (#229)', async () => {
    const { impl } = makeFetch({
      collaborators: (query) => {
        const page = Number(query.get('page') ?? '1');
        // "Vendas" has seven people: one page. Page 2 exists in the URL but not on the server.
        return page > 1 ? json({ data: [], meta: meta(2, 7, 1) }) : json({ data: [anaPrado], meta: meta(1, 7, 1) });
      }
    });
    const { probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?role=sales&page=2`);

    // The out-of-range page must not read as "nobody found": it goes back to page 1 and shows them.
    await screen.findByText('Ana Prado');
    await waitFor(() => expect(probe.search).not.toContain('page='));
    expect(screen.queryByText(/Nenhuma pessoa encontrada/)).toBeNull();
  });

  // Review of #223, M1: without encoding, a `q` with `&role=admin`, `#` or `/` would smuggle or cut
  // parameters. The value must travel as one encoded segment.
  it('encodes the search value so it cannot smuggle another parameter (#223 review M1)', async () => {
    const hostile = 'a&role=admin#x/../';
    const { impl, requests } = makeFetch({ collaborators: () => listResponse([anaPrado]) });
    renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?q=${encodeURIComponent(hostile)}`);

    await screen.findByText('Ana Prado');
    const listRequest = requests.find((url) => url.includes('/collaborators?'));
    expect(listRequest).toBeDefined();
    const requested = new URL(listRequest!);
    expect(requested.searchParams.get('q')).toBe(hostile);
    expect(requested.searchParams.get('role')).toBeNull();
    expect(requested.searchParams.get('pageSize')).toBe('24');
  });

  // Review of #223, M2: the same QueryClient serves both agencies. The cache key carries the agency
  // id, so navigating directly to B never renders A's cached people.
  it('never shows one agency\'s people under another with the same cache (#223 review M2)', async () => {
    const { impl } = makeFetch({
      collaborators: (_query, agencyId) => listResponse(agencyId === AGENCY_B ? [biancaSouza] : [anaPrado])
    });
    const { container, probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores`);

    await within(container).findByText('Ana Prado');
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/colaboradores`); });

    await within(container).findByText('Bianca Souza');
    expect(within(container).queryByText('Ana Prado')).toBeNull();
  });
});

describe('collaborator detail (#103)', () => {
  const listUrl = `/agencia/${AGENCY_A}/colaboradores`;
  const detailUrl = (id = anaPrado.membershipId) => `${listUrl}?colaborador=${encodeURIComponent(id)}`;
  const detailCalls = (calls: string[]) => calls.filter((call) => /\/collaborators\/(?!job-titles)/.test(call));

  it('opens the selected badge with its own API detail and disabled future tabs', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = renderCollaborators(impl);
    fireEvent.click(await screen.findByRole('link', { name: 'Ver detalhes de Mário Costa' }));

    const modal = await screen.findByRole('dialog', { name: 'Mário Costa' });
    expect(probe.search).toContain(`colaborador=${marioCosta.membershipId}`);
    expect(detailCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/collaborators/${marioCosta.membershipId}`]);
    expect(within(modal).getAllByText('mario@example.test')).toHaveLength(2);
    expect(within(modal).getByText('13/03/2026')).toBeTruthy();
    expect(within(modal).getByText('A troca de e-mail é feita pela operação.')).toBeTruthy();
    expect(within(modal).getByRole('tab', { name: 'Detalhes' }).getAttribute('aria-selected')).toBe('true');
    for (const name of ['Performance', 'Entregas']) expect(within(modal).getByRole('tab', { name }).hasAttribute('disabled')).toBe(true);
    expect(within(modal).getAllByText('Disponível quando o módulo de Tarefas existir.')).toHaveLength(2);
    expect(within(modal).queryByRole('textbox')).toBeNull();
    expect(modal.textContent).not.toMatch(/salário|remuneração|salvar|remover/i);
  });

  it('preserves page and all filters when closing, going back, and going forward', async () => {
    const { impl } = makeFetch({ collaborators: () => json({ data: [anaPrado], meta: meta(2, 60, 3) }) });
    const original = '?q=ana&role=production&jobTitle=Editora&page=2';
    const { probe } = renderCollaborators(impl, listUrl + original);
    const badge = await screen.findByRole('link', { name: 'Ver detalhes de Ana Prado' });
    badge.focus();
    fireEvent.click(badge);
    await screen.findByRole('dialog', { name: 'Ana Prado' });
    await act(async () => { await probe.navigate(-1); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(probe.search).toBe(original);
    expect(document.activeElement).toBe(badge);
    await act(async () => { await probe.navigate(1); });
    await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar detalhe do colaborador' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(probe.search).toBe(original);
  });

  it('opens a copied URL without list history and closes into that filtered list', async () => {
    const { impl } = makeFetch();
    const { probe } = renderCollaborators(impl, detailUrl() + '&role=production');
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent(modal, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(probe.pathname).toBe(listUrl);
    expect(probe.search).toBe('?role=production');
  });

  it('only closes on a gesture that both starts and ends outside the modal', async () => {
    const { impl } = makeFetch();
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    vi.spyOn(modal, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 400));
    const pointerDown = (x: number) => fireEvent(modal, new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: x }));
    pointerDown(150);
    fireEvent.click(modal, { clientX: 150, clientY: 150 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    pointerDown(150);
    fireEvent.click(modal, { clientX: 5, clientY: 5 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    pointerDown(5);
    fireEvent.click(modal, { clientX: 5, clientY: 5 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows skeletons inside the modal while its request is pending', async () => {
    let finish: (value: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => { finish = resolve; });
    const { impl } = makeFetch({ detail: () => response });
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog');
    expect(await within(modal).findByText('Carregando colaborador…')).toBeTruthy();
    expect(modal.querySelectorAll('.ui-skeleton')).toHaveLength(2);
    await act(async () => { finish(json(anaPrado)); });
    await screen.findByRole('dialog', { name: 'Ana Prado' });
  });

  it('keeps an error inside the modal and retries without closing it', async () => {
    let attempts = 0;
    const { impl } = makeFetch({ detail: () => ++attempts <= 2
      ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
      : json(anaPrado) });
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog');
    await within(modal).findByRole('alert', undefined, { timeout: 5000 });
    expect(modal.textContent).not.toContain('private diagnostic');
    fireEvent.click(within(modal).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('dialog', { name: 'Ana Prado' })).toBe(modal);
  });

  it.each([403, 404])('renders %i as the same not-found state, with a return to the list', async (status) => {
    const { impl } = makeFetch({ detail: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status) });
    const { probe } = renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog');
    await within(modal).findByText('Colaborador não encontrado.');
    expect(within(modal).queryByRole('tablist')).toBeNull();
    expect(modal.textContent).not.toContain('sensitive detail');
    fireEvent.click(within(modal).getByRole('button', { name: 'Voltar à lista' }));
    expect(probe.search).toBe('');
  });

  it.each(['', '../me', '..%2Fme', 'not-a-uuid', 'x?role=admin#fragment'])('refuses a malformed membership id (%s) without a detail request', async (id) => {
    const { impl, calls } = makeFetch();
    renderCollaborators(impl, detailUrl(id));
    await screen.findByText('Colaborador não encontrado.');
    expect(detailCalls(calls)).toEqual([]);
  });

  it('does not load or reveal a detail without permission or an authenticated session', async () => {
    for (const scenario of [{ permissions: [] }, { authenticated: false }]) {
      const { impl, calls } = makeFetch(scenario);
      renderCollaborators(impl, detailUrl());
      if (scenario.authenticated === false) await screen.findByRole('heading', { name: 'Workspace unavailable' });
      else await screen.findByRole('heading', { name: 'Page not found' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(detailCalls(calls)).toEqual([]);
      cleanup();
    }
  });

  it('does not render another membership returned by a mismatched response', async () => {
    const { impl } = makeFetch({ detail: () => json(marioCosta) });
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog');
    await within(modal).findByRole('alert');
    expect(modal.textContent).not.toContain('Mário');
  });

  it('never reuses a cached detail across agencies, even with the same membership id in the URL', async () => {
    let finish: (value: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    const { impl, calls } = makeFetch({ detail: (_id, agencyId) => agencyId === AGENCY_A ? json(anaPrado) : delayed });
    const { probe } = renderCollaborators(impl, detailUrl());
    await screen.findByRole('dialog', { name: 'Ana Prado' });
    await act(async () => { await probe.navigate(`/agencia/${AGENCY_B}/colaboradores?colaborador=${anaPrado.membershipId}`); });
    const modal = await screen.findByRole('dialog', { name: 'Detalhe do colaborador' });
    expect(modal.textContent).not.toContain(anaPrado.email);
    await act(async () => { finish(json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)); });
    await within(modal).findByText('Colaborador não encontrado.');
    expect(detailCalls(calls)).toContain(`GET /agencies/${AGENCY_B}/collaborators/${anaPrado.membershipId}`);
  });

  it('keeps loaded details during revalidation, but hides them when access is refused', async () => {
    let finish: (value: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    let requests = 0;
    const { impl } = makeFetch({ detail: () => ++requests === 1 ? json(anaPrado) : delayed });
    const { queryClient } = renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    act(() => { void queryClient.invalidateQueries({ queryKey: ['agency', AGENCY_A, 'collaborators', 'detail'] }); });
    await waitFor(() => expect(requests).toBe(2));
    expect(modal.querySelector('.ui-skeleton')).toBeNull();
    expect(within(modal).getByRole('tab', { name: 'Detalhes' })).toBeTruthy();
    await act(async () => { finish(json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403)); });
    await within(modal).findByText('Colaborador não encontrado.');
    expect(modal.textContent).not.toContain(anaPrado.email);
    expect(within(modal).queryByRole('tablist')).toBeNull();
  });

  it('renders untrusted identity fields as text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeFetch({ detail: () => json({ ...anaPrado, name: hostile, jobTitle: hostile }) });
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog', { name: hostile });
    expect(modal.querySelector('img')).toBeNull();
    expect(modal.querySelector('[onerror]')).toBeNull();
  });
});

describe('collaborator admin actions (#104)', () => {
  const detailUrl = (id: string) => `/agencia/${AGENCY_A}/colaboradores?colaborador=${id}`;
  const OWNER_PERMISSIONS = ['colaborador.visualizar', 'colaborador.alterar_funcao', 'colaborador.alterar_papel', 'colaborador.remover', 'colaborador.atribuir_admin'];
  const ADMIN_PERMISSIONS = ['colaborador.visualizar', 'colaborador.alterar_funcao', 'colaborador.alterar_papel', 'colaborador.remover'];
  const MANAGER_PERMISSIONS = ['colaborador.visualizar', 'colaborador.alterar_funcao'];
  const VIEWER_PERMISSIONS = ['colaborador.visualizar'];
  const CUSTOM_ROLE = { key: 'custom', name: 'Papel personalizado' };
  const roleIdOf = (key: string): string => SYSTEM_ROLES.find((role) => role.key === key)!.id;

  const openMario = async (scenario: Scenario) => {
    const fetch = makeFetch(scenario);
    renderCollaborators(fetch.impl, detailUrl(marioCosta.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });
    return { ...fetch, dialog };
  };

  it('offers the Admin role only to the Owner, even if the roles response leaks it', async () => {
    const owner = makeFetch({ isOwner: true, permissions: OWNER_PERMISSIONS });
    renderCollaborators(owner.impl, detailUrl(marioCosta.membershipId));
    const ownerDialog = await screen.findByRole('dialog', { name: 'Mário Costa' });
    await within(ownerDialog).findByRole('option', { name: 'Admin' });
    expect(Array.from((within(ownerDialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement).options).map((option) => option.textContent))
      .toEqual(['Selecione', 'Gestor de conta', 'Admin', 'Financeiro', 'Produção', 'Vendas']);
    cleanup();

    // The API hides `admin` from a non-owner (#287); the screen has to hide it too, so this
    // response deliberately leaks it.
    const leaked = makeFetch({ permissions: ADMIN_PERMISSIONS, roles: () => json({ data: SYSTEM_ROLES }) });
    renderCollaborators(leaked.impl, detailUrl(marioCosta.membershipId));
    const adminDialog = await screen.findByRole('dialog', { name: 'Mário Costa' });
    await within(adminDialog).findByRole('option', { name: 'Gestor de conta' });
    const adminSelect = within(adminDialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement;
    expect(Array.from(adminSelect.options).map((option) => option.textContent))
      .toEqual(['Selecione', 'Gestor de conta', 'Financeiro', 'Produção', 'Vendas']);
    expect(Array.from(adminSelect.options).some((option) => option.value === ADMIN_ROLE_ID)).toBe(false);
  });

  it('lets the account manager edit the cargo and shows the role as read-only', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({
      role: { key: 'account_manager', name: 'Gestor de conta' },
      permissions: MANAGER_PERMISSIONS,
      updateCollaborator: (_membershipId, body) => {
        bodies.push(body);
        return json({ ...marioCosta, jobTitle: (body as { jobTitle: string | null }).jobTitle });
      }
    });
    renderCollaborators(impl, detailUrl(marioCosta.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });

    expect((within(dialog).getByRole('textbox', { name: 'Cargo' }) as HTMLInputElement).value).toBe('Copywriter');
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).getByText('Produção')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Remover do quadro' })).toBeNull();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Cargo' }), { target: { value: 'Editora' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    // The role is not theirs to change, so the request carries only the cargo.
    await waitFor(() => expect(bodies).toEqual([{ jobTitle: 'Editora' }]));
  });

  it.each([
    ['production', 'Produção'],
    ['sales', 'Vendas'],
    ['finance', 'Financeiro']
  ])('shows everything read-only for %s, without a save button', async (roleKey, roleName) => {
    const { impl } = makeFetch({ role: { key: roleKey, name: roleName }, permissions: VIEWER_PERMISSIONS });
    renderCollaborators(impl, detailUrl(marioCosta.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });

    expect(within(dialog).queryByRole('textbox', { name: 'Cargo' })).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Salvar' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Remover do quadro' })).toBeNull();
  });

  // Review of #104: the presets carry `alterar_papel` and `remover` together, so only a custom
  // role with a single permission proves each action answers to its own permission.
  it('lets a custom role with only colaborador.alterar_papel edit the papel, and never offers the removal', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({
      role: CUSTOM_ROLE,
      permissions: ['colaborador.visualizar', 'colaborador.alterar_papel'],
      updateCollaborator: (_membershipId, body) => {
        bodies.push(body);
        return json({ ...marioCosta, role: { key: 'finance', name: 'Financeiro' } });
      }
    });
    renderCollaborators(impl, detailUrl(marioCosta.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });

    expect(within(dialog).queryByRole('textbox', { name: 'Cargo' })).toBeNull();
    expect(within(dialog).getByText('Copywriter')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Remover do quadro' })).toBeNull();

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Papel' }), { target: { value: roleIdOf('finance') } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    // Only the role travels: the cargo is not this role's to change nor this save's to touch.
    await waitFor(() => expect(bodies).toEqual([{ roleId: roleIdOf('finance') }]));
  });

  it('lets a custom role with only colaborador.remover remove, with the fields read-only', async () => {
    const removed: string[] = [];
    const { impl } = makeFetch({
      role: CUSTOM_ROLE,
      permissions: ['colaborador.visualizar', 'colaborador.remover'],
      collaborators: () => json({ data: [marioCosta, juliaReis], meta: meta(1, 2, 1) }),
      detail: () => json(marioCosta),
      removeCollaborator: (membershipId) => {
        removed.push(membershipId);
        return json({ ...marioCosta, status: 'removed' });
      }
    });
    renderCollaborators(impl, detailUrl(marioCosta.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });

    expect(within(dialog).queryByRole('textbox', { name: 'Cargo' })).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).getByText('Copywriter')).toBeTruthy();
    expect(within(dialog).getByText('Produção')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover do quadro' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remover Mário Costa do quadro?' })).getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(removed).toEqual([marioCosta.membershipId]));
  });

  it('lets a custom role with only colaborador.alterar_funcao edit the cargo, and nothing else', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({
      role: CUSTOM_ROLE,
      permissions: ['colaborador.visualizar', 'colaborador.alterar_funcao'],
      updateCollaborator: (_membershipId, body) => {
        bodies.push(body);
        return json({ ...marioCosta, jobTitle: 'Editora' });
      }
    });
    renderCollaborators(impl, detailUrl(marioCosta.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });

    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).getByText('Produção')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Remover do quadro' })).toBeNull();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Cargo' }), { target: { value: 'Editora' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(bodies).toEqual([{ jobTitle: 'Editora' }]));
  });

  it('sends only the field that changed, even when both actions are allowed', async () => {
    const bodies: unknown[] = [];
    type AdminPerson = Omit<typeof marioCosta, 'jobTitle'> & { jobTitle: string | null };
    let person: AdminPerson = { ...marioCosta };
    const { impl } = makeFetch({
      permissions: ADMIN_PERMISSIONS,
      detail: () => json(person),
      updateCollaborator: (_membershipId, body) => {
        bodies.push(body);
        const next = body as { jobTitle?: string | null; roleId?: string };
        const role = next.roleId === undefined ? undefined : SYSTEM_ROLES.find((item) => item.id === next.roleId);
        person = {
          ...person,
          ...(next.jobTitle === undefined ? {} : { jobTitle: next.jobTitle }),
          ...(role === undefined ? {} : { role: { key: role.key, name: role.name } })
        };
        return json(person);
      }
    });
    renderCollaborators(impl, detailUrl(marioCosta.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Cargo' }), { target: { value: 'Editora' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toEqual([{ jobTitle: 'Editora' }]));

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Papel' }), { target: { value: roleIdOf('finance') } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toEqual([{ jobTitle: 'Editora' }, { roleId: roleIdOf('finance') }]));
  });

  it('does not let the person edit the own cargo or role in this modal', async () => {
    const { impl } = makeFetch({
      session: () => json({ user: { id: sessionBody.user.id, name: anaPrado.name, email: sessionEmailAfterChange }, session: sessionBody.session }),
      permissions: OWNER_PERMISSIONS,
      isOwner: true,
      detail: () => json(anaSelf)
    });
    renderCollaborators(impl, detailUrl(anaPrado.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Ana Prado' });

    expect(within(dialog).getByRole('textbox', { name: 'Nome' })).toBeTruthy();
    expect(within(dialog).queryByRole('textbox', { name: 'Cargo' })).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Remover do quadro' })).toBeNull();
  });

  // The e-mail heuristic is gone (#286): the session e-mail equals the link's, yet the API says the
  // link is not the signed-in person's own, so the modal must not offer to edit name and photo.
  it('does not treat a link as the own one just because the session e-mail matches', async () => {
    const { impl } = makeFetch({
      session: () => json({ user: { id: sessionBody.user.id, name: 'Pessoa', email: anaPrado.email }, session: sessionBody.session }),
      permissions: OWNER_PERMISSIONS,
      isOwner: true,
      detail: () => json(anaPrado)
    });
    renderCollaborators(impl, detailUrl(anaPrado.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Ana Prado' });

    expect(within(dialog).queryByRole('textbox', { name: 'Nome' })).toBeNull();
    expect(dialog.querySelector('input[type="file"]')).toBeNull();
    expect(within(dialog).getByRole('textbox', { name: 'Cargo' })).toBeTruthy();
  });

  it('lets the person edit name and photo when the API says the link is the own one, whatever the session e-mail', async () => {
    const { impl } = makeFetch({
      session: () => json({ user: { id: sessionBody.user.id, name: anaPrado.name, email: sessionEmailAfterChange }, session: sessionBody.session }),
      permissions: OWNER_PERMISSIONS,
      isOwner: true,
      detail: () => json(anaSelf)
    });
    renderCollaborators(impl, detailUrl(anaPrado.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Ana Prado' });

    expect(within(dialog).getByRole('textbox', { name: 'Nome' })).toBeTruthy();
    expect(dialog.querySelector('input[type="file"]')).not.toBeNull();
    expect(within(dialog).queryByRole('textbox', { name: 'Cargo' })).toBeNull();
  });

  it('offers no remove and no role edit on the Owner, for anyone', async () => {
    const ownerTarget = { ...marioCosta, isOwner: true };
    const { impl } = makeFetch({
      permissions: OWNER_PERMISSIONS,
      isOwner: true,
      collaborators: () => json({ data: [ownerTarget], meta: meta(1, 1, 1) }),
      detail: () => json(ownerTarget)
    });
    renderCollaborators(impl, detailUrl(ownerTarget.membershipId));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });

    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Remover do quadro' })).toBeNull();
    // The cargo stays editable for the roles the SPEC allows (Admin and account manager).
    expect(within(dialog).getByRole('textbox', { name: 'Cargo' })).toBeTruthy();
  });

  it('saves cargo and papel and updates the badge behind without reloading', async () => {
    const bodies: unknown[] = [];
    type AdminPerson = Omit<typeof marioCosta, 'jobTitle'> & { jobTitle: string | null };
    let person: AdminPerson = { ...marioCosta };
    const { impl } = makeFetch({
      permissions: ADMIN_PERMISSIONS,
      collaborators: () => json({ data: [person], meta: meta(1, 1, 1) }),
      detail: () => json(person),
      updateCollaborator: (_membershipId, body) => {
        bodies.push(body);
        const next = body as { jobTitle?: string | null; roleId?: string };
        const role = next.roleId === undefined ? undefined : SYSTEM_ROLES.find((item) => item.id === next.roleId);
        person = {
          ...person,
          ...(next.jobTitle === undefined ? {} : { jobTitle: next.jobTitle }),
          ...(role === undefined ? {} : { role: { key: role.key, name: role.name } })
        };
        return json(person);
      }
    });
    const { container, probe } = renderCollaborators(impl);
    fireEvent.click(await screen.findByRole('link', { name: 'Ver detalhes de Mário Costa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Cargo' }), { target: { value: 'Editor de Vídeo' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Papel' }), { target: { value: roleIdOf('finance') } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(bodies).toEqual([{ jobTitle: 'Editor de Vídeo', roleId: roleIdOf('finance') }]));
    // The modal header reflects the new values at once.
    expect(await within(dialog).findByText('Editor de Vídeo · Financeiro')).toBeTruthy();
    // And the badge behind, without a reload.
    await waitFor(() => {
      const badge = container.querySelector('.collaborators__grid .ui-badge-card');
      expect(badge?.querySelector('.ui-badge-card__job')?.textContent).toBe('Editor de Vídeo');
      expect(badge?.querySelector('.ui-badge-card__role')?.textContent).toBe('Financeiro');
    });
    expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/colaboradores`);
  });

  it('asks for confirmation explaining the consequence before removing, and takes the person out of the list', async () => {
    const removed: string[] = [];
    let people = [marioCosta, juliaReis];
    const { impl } = makeFetch({
      permissions: ADMIN_PERMISSIONS,
      collaborators: () => json({ data: people, meta: meta(1, people.length, 1) }),
      detail: () => json(marioCosta),
      removeCollaborator: (membershipId) => {
        removed.push(membershipId);
        people = people.filter((item) => item.membershipId !== membershipId);
        return json({ ...marioCosta, status: 'removed' });
      }
    });
    const { container, probe } = renderCollaborators(impl);
    fireEvent.click(await screen.findByRole('link', { name: 'Ver detalhes de Mário Costa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mário Costa' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover do quadro' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Remover Mário Costa do quadro?' });
    expect(confirmation.textContent).toContain('perde o acesso a esta agência na próxima requisição');
    expect(confirmation.textContent).toContain('pode ser reativada depois');
    expect(removed).toEqual([]);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remover Mário Costa do quadro?' })).toBeNull());
    expect(removed).toEqual([]);
    // The badge behind is the only place the name may appear twice with the modal heading, so the
    // grid is read directly.
    const badgeNames = (): (string | null)[] =>
      Array.from(container.querySelectorAll('.collaborators__grid .ui-badge-card__name')).map((element) => element.textContent);
    expect(badgeNames()).toContain('Mário Costa');

    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Mário Costa' })).getByRole('button', { name: 'Remover do quadro' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remover Mário Costa do quadro?' })).getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(removed).toEqual([marioCosta.membershipId]));
    // The modal closes and the badge leaves the default list, without a reload.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mário Costa' })).toBeNull());
    await waitFor(() => expect(badgeNames()).not.toContain('Mário Costa'));
    expect(badgeNames()).toContain('Júlia Reis');
    expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/colaboradores`);
  });

  it('shows its own permission message when the save answers 403', async () => {
    const { dialog } = await openMario({
      permissions: ADMIN_PERMISSIONS,
      updateCollaborator: () => json({ error: { code: 'FORBIDDEN', message: 'private diagnostic' } }, 403)
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Cargo' }), { target: { value: 'Editora' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('Você não tem permissão para alterar este colaborador.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
  });

  it('shows the not-found message when the save answers 404', async () => {
    const { dialog } = await openMario({
      permissions: ADMIN_PERMISSIONS,
      updateCollaborator: () => json({ error: { code: 'NOT_FOUND', message: 'private diagnostic' } }, 404)
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Cargo' }), { target: { value: 'Editora' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('Colaborador não encontrado.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
  });

  it('marks the cargo field for a validation error, preserving the typed value', async () => {
    const { dialog } = await openMario({
      permissions: ADMIN_PERMISSIONS,
      updateCollaborator: () => json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'private diagnostic',
          details: { issues: [{ path: 'jobTitle', code: 'custom', message: 'private issue message' }] }
        }
      }, 400)
    });
    const cargo = within(dialog).getByRole('textbox', { name: 'Cargo' }) as HTMLInputElement;
    fireEvent.change(cargo, { target: { value: 'Editora' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('O cargo contém caracteres que não são aceitos.')).toBeTruthy();
    expect(cargo.value).toBe('Editora');
    expect(dialog.textContent).not.toContain('private');
  });

  it('marks the role field when the API refuses the chosen role', async () => {
    const { dialog } = await openMario({
      permissions: ADMIN_PERMISSIONS,
      updateCollaborator: () => json({ error: { code: 'INVALID_ROLE', message: 'private diagnostic' } }, 400)
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Papel' }), { target: { value: roleIdOf('finance') } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('Escolha um papel da lista.')).toBeTruthy();
    expect((within(dialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement).value).toBe(roleIdOf('finance'));
    expect(dialog.textContent).not.toContain('private diagnostic');
  });

  it('shows its own permission message when the removal answers 403', async () => {
    const { dialog } = await openMario({
      permissions: ADMIN_PERMISSIONS,
      removeCollaborator: () => json({ error: { code: 'FORBIDDEN', message: 'private diagnostic' } }, 403)
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover do quadro' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remover Mário Costa do quadro?' })).getByRole('button', { name: 'Remover' }));

    expect(await within(dialog).findByText('Você não tem permissão para remover este colaborador.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
  });

  it('shows the already-removed message on a 409 and refreshes the list', async () => {
    let people = [marioCosta, juliaReis];
    const { dialog } = await openMario({
      permissions: ADMIN_PERMISSIONS,
      collaborators: () => json({ data: people, meta: meta(1, people.length, 1) }),
      removeCollaborator: () => {
        people = people.filter((item) => item.membershipId !== marioCosta.membershipId);
        return json({ error: { code: 'COLLABORATOR_ALREADY_REMOVED', message: 'private diagnostic' } }, 409);
      }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover do quadro' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remover Mário Costa do quadro?' })).getByRole('button', { name: 'Remover' }));

    expect(await within(dialog).findByText('Este colaborador já foi removido.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
    // The server already holds the removal; the list behind stops showing the person.
    await waitFor(() => expect(document.querySelector('.collaborators__grid')?.textContent).not.toContain('Mário Costa'));
  });

  it('shows the not-found message when the removal answers 404', async () => {
    const { dialog } = await openMario({
      permissions: ADMIN_PERMISSIONS,
      removeCollaborator: () => json({ error: { code: 'NOT_FOUND', message: 'private diagnostic' } }, 404)
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover do quadro' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remover Mário Costa do quadro?' })).getByRole('button', { name: 'Remover' }));

    expect(await within(dialog).findByText('Colaborador não encontrado.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
  });
});

describe('pending invitations (#106)', () => {
  const invitesRegion = () => screen.findByRole('region', { name: 'Convites aguardando aceite' });
  const invitationsCalls = (calls: string[]) => calls.filter((call) => call.includes('/invitations'));

  // Each preset answers `/me` with its own role, and none of the four holds `colaborador.convidar`.
  it.each([
    ['account_manager', 'Gestor de conta'],
    ['production', 'Produção'],
    ['sales', 'Vendas'],
    ['finance', 'Financeiro']
  ])('does not exist for %s', async (roleKey, roleName) => {
    const { impl, calls } = makeFetch({
      role: { key: roleKey, name: roleName },
      permissions: ['colaborador.visualizar']
    });
    renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    expect(screen.queryByText('Convites aguardando aceite')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Convites aguardando aceite' })).toBeNull();
    expect(invitationsCalls(calls)).toEqual([]);
  });

  // Visibility follows `colaborador.convidar`, not the invitation actions: a role that can resend
  // and cancel must still not see the section, and the listing is never requested for it.
  it('does not exist without colaborador.convidar, even holding the invitation actions', async () => {
    const { impl, calls } = makeFetch({
      role: { key: 'custom', name: 'Personalizado' },
      permissions: ['colaborador.visualizar', 'convite.reenviar', 'convite.cancelar']
    });
    renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    expect(screen.queryByRole('region', { name: 'Convites aguardando aceite' })).toBeNull();
    expect(invitationsCalls(calls)).toEqual([]);
  });

  it('lists e-mail, role and relative deadline, with the count in its own header', async () => {
    const { impl } = makeFetch();
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText('ana@exemplo.com')).toBeTruthy();
    expect(within(region).getByText('Produção')).toBeTruthy();
    expect(within(region).getByText('expira em 5 dias')).toBeTruthy();
    expect(within(region).getByText('paulo@exemplo.com')).toBeTruthy();
    expect(within(region).getByText('expira amanhã')).toBeTruthy();
    expect(region.querySelector('.invites__count')?.textContent).toBe('3');
    expect(within(region).getByRole('button', { name: 'Reenviar convite de ana@exemplo.com' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Cancelar convite de ana@exemplo.com' })).toBeTruthy();
  });

  it('draws a list-shaped skeleton on its first load', async () => {
    const { impl } = makeFetch({ invitations: () => new Promise<Response>(() => undefined) });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(region.querySelectorAll('.ui-skeleton')).toHaveLength(3);
    expect(region.querySelector('.invites__count')).toBeNull();
    expect(await screen.findByText('Ana Prado')).toBeTruthy();
  });

  it('offers the invite action in the empty state, and it opens the invite modal', async () => {
    const { impl } = makeFetch({ invitations: (query) => invitationsResponse([], query) });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText('Nenhum convite aguardando aceite')).toBeTruthy();
    const invite = within(region).getByRole('button', { name: 'Convidar' });
    expect(invite.hasAttribute('disabled')).toBe(false);
    expect(region.querySelector('.invites__count')?.textContent).toBe('0');

    fireEvent.click(invite);
    expect(await screen.findByRole('dialog', { name: 'Convidar colaborador' })).toBeTruthy();
  });

  it('offers a retry when the invitations listing fails, without echoing the API message', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      invitations: (query) => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
          : invitationsResponse(defaultInvites, query);
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    const alert = await within(region).findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar os convites.');
    expect(region.textContent).not.toContain('private diagnostic');

    fireEvent.click(within(region).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(region).findByText('ana@exemplo.com')).toBeTruthy();
  });

  it.each([403, 404])('stays out of the screen when the API answers %i', async (status) => {
    const { impl } = makeFetch({
      invitations: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status)
    });
    renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    await waitFor(() => expect(screen.queryByText('Convites aguardando aceite')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Convites aguardando aceite' })).toBeNull();
    expect(screen.queryByText('sensitive detail')).toBeNull();
  });

  it('ends the session when the API answers 401, never showing the invited e-mail', async () => {
    const { impl } = makeFetch({ invitations: () => unauthenticated() });
    renderCollaborators(impl);

    await screen.findByLabelText('E-mail');
    expect(screen.queryByText('ana@exemplo.com')).toBeNull();
  });

  it('keeps the section but hides the actions the role cannot perform', async () => {
    const { impl } = makeFetch({ permissions: ['colaborador.visualizar', 'colaborador.convidar'] });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText('ana@exemplo.com')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: /Reenviar/ })).toBeNull();
    expect(within(region).queryByRole('button', { name: /Cancelar/ })).toBeNull();
  });

  it('resends, renews the deadline in place and says the previous link stopped working', async () => {
    let pending = [inviteAna];
    const renewedId = 'abababab-abab-4bab-8bab-abababababab';
    const renewedExpiry = expiryInDays(7);
    const { impl, calls } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      resend: (invitationId) => {
        pending = pending.map((item) => item.id === invitationId ? { ...item, id: renewedId, expiresAt: renewedExpiry } : item);
        return json({ invitationId: renewedId, expiresAt: renewedExpiry });
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText('expira em 5 dias')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Reenviar convite de ana@exemplo.com' }));

    expect(await within(region).findByText('Convite reenviado para ana@exemplo.com. O link anterior deixou de valer.')).toBeTruthy();
    expect(await within(region).findByText('expira em 7 dias')).toBeTruthy();
    expect(calls).toContain(`POST /agencies/${AGENCY_A}/invitations/${inviteAna.id}/resend`);
  });

  // The API commits the revoke-and-insert before sending the e-mail: a 502 leaves a new invitation
  // in place, so the list must refetch and the next attempt must use the id the server actually kept.
  it('recovers from a resend that fails after the invitation was already renewed', async () => {
    let pending = [inviteAna];
    let attempts = 0;
    const renewedId = 'abababab-abab-4bab-8bab-abababababab';
    const renewedExpiry = expiryInDays(7);
    const { impl, calls } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      resend: () => {
        attempts += 1;
        if (attempts === 1) {
          pending = [{ ...inviteAna, id: renewedId, expiresAt: renewedExpiry }];
          return json({ error: { code: 'EMAIL_DELIVERY_FAILED', message: 'private diagnostic' } }, 502);
        }
        return json({ invitationId: renewedId, expiresAt: renewedExpiry });
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Reenviar convite de ana@exemplo.com' }));

    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível reenviar o convite.');
    expect(region.textContent).not.toContain('private diagnostic');
    expect(await within(region).findByText('expira em 7 dias')).toBeTruthy();
    expect(calls).toContain(`POST /agencies/${AGENCY_A}/invitations/${inviteAna.id}/resend`);

    // The second attempt goes to the id the failed response left in the database.
    fireEvent.click(within(region).getByRole('button', { name: 'Reenviar convite de ana@exemplo.com' }));
    expect(await within(region).findByText('Convite reenviado para ana@exemplo.com. O link anterior deixou de valer.')).toBeTruthy();
    expect(calls).toContain(`POST /agencies/${AGENCY_A}/invitations/${renewedId}/resend`);
  });

  it.each([403, 404])('shows an error and keeps the row when resend answers %i', async (status) => {
    const { impl } = makeFetch({
      resend: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status)
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Reenviar convite de ana@exemplo.com' }));

    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível reenviar o convite.');
    expect(region.textContent).not.toContain('sensitive detail');
    expect(within(region).getByText('ana@exemplo.com')).toBeTruthy();
  });

  it('asks for confirmation before cancelling, and only removes after confirming', async () => {
    let pending = [inviteAna, invitePaulo];
    const { impl, calls } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      cancel: (invitationId) => {
        pending = pending.filter((item) => item.id !== invitationId);
        return noContent();
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Cancelar convite de ana@exemplo.com' }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancelar este convite?' });
    expect(dialog.textContent).toContain('O link enviado para ana@exemplo.com deixa de valer imediatamente.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Voltar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((call) => call.startsWith(`DELETE /agencies/${AGENCY_A}/invitations/`))).toBe(false);
    expect(within(region).getByText('ana@exemplo.com')).toBeTruthy();

    fireEvent.click(within(region).getByRole('button', { name: 'Cancelar convite de ana@exemplo.com' }));
    const reopened = await screen.findByRole('dialog', { name: 'Cancelar este convite?' });
    fireEvent.click(within(reopened).getByRole('button', { name: 'Cancelar convite' }));

    await waitFor(() => expect(within(region).queryByText('ana@exemplo.com')).toBeNull());
    expect(region.querySelector('.invites__count')?.textContent).toBe('1');
    expect(calls).toContain(`DELETE /agencies/${AGENCY_A}/invitations/${inviteAna.id}`);
  });

  it('keeps the invitation when cancelling fails and allows repeating', async () => {
    let pending = [inviteAna];
    let attempts = 0;
    const { impl } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      cancel: () => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'INVITATION_NOT_PENDING', message: 'private diagnostic' } }, 409);
        pending = [];
        return noContent();
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    const cancel = async (): Promise<void> => {
      fireEvent.click(await within(region).findByRole('button', { name: 'Cancelar convite de ana@exemplo.com' }));
      const dialog = await screen.findByRole('dialog', { name: 'Cancelar este convite?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar convite' }));
    };

    await cancel();
    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível cancelar o convite.');
    expect(region.textContent).not.toContain('private diagnostic');
    expect(within(region).getByText('ana@exemplo.com')).toBeTruthy();

    await cancel();
    await waitFor(() => expect(within(region).queryByText('ana@exemplo.com')).toBeNull());
  });

  it.each([403, 404])('shows an error and keeps the row when the cancellation answers %i', async (status) => {
    const { impl } = makeFetch({
      cancel: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status)
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Cancelar convite de ana@exemplo.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar este convite?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar convite' }));

    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível cancelar o convite.');
    expect(region.textContent).not.toContain('sensitive detail');
    expect(within(region).getByText('ana@exemplo.com')).toBeTruthy();
  });

  // The invitation was already used, expired or revoked server-side: the row must leave with the
  // refetch instead of staying on screen with a stale error.
  it.each([409, 404])('removes the row after the cancellation answers %i', async (status) => {
    let pending = [inviteAna, invitePaulo];
    const { impl } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      cancel: (invitationId) => {
        pending = pending.filter((item) => item.id !== invitationId);
        return json({ error: { code: status === 409 ? 'INVITATION_NOT_PENDING' : 'NOT_FOUND', message: 'sensitive detail' } }, status);
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Cancelar convite de ana@exemplo.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar este convite?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar convite' }));

    await waitFor(() => expect(within(region).queryByText('ana@exemplo.com')).toBeNull());
    expect(region.textContent).not.toContain('sensitive detail');
    expect(region.querySelector('.invites__count')?.textContent).toBe('1');
  });

  it('reads its own page from the URL and writes it back, next to the team list', async () => {
    const { impl } = makeFetch({
      invitations: (query) => {
        const page = Number(query.get('page') ?? '1');
        return invitationsResponse(page === 2 ? pageInvites(24, 6) : pageInvites(0, 24), query, { totalItems: 30, totalPages: 2 });
      }
    });
    const { probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?convites=2`);

    const region = await invitesRegion();
    expect(await within(region).findByText('p24@exemplo.com')).toBeTruthy();
    expect(region.querySelector('.invites__count')?.textContent).toBe('30');
    // The team page has its own pagination; the invitations page never touches it.
    expect(probe.search).toContain('convites=2');

    fireEvent.click(within(region).getByRole('button', { name: 'Página anterior' }));
    await waitFor(() => expect(probe.search).not.toContain('convites='));
    expect(await within(region).findByText('p0@exemplo.com')).toBeTruthy();
  });

  it('paginates the invitations and the team independently', async () => {
    const { impl } = makeFetch({
      collaborators: (query) => json({ data: [anaPrado], meta: meta(Number(query.get('page') ?? '1'), 60, 3) }),
      invitations: (query) => {
        const page = Number(query.get('page') ?? '1');
        return invitationsResponse(page === 2 ? pageInvites(24, 6) : pageInvites(0, 24), query, { totalItems: 30, totalPages: 2 });
      }
    });
    const { container, probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?page=2&convites=2`);

    const paginationAt = (index: number): HTMLElement => {
      const pagination = container.querySelectorAll<HTMLElement>('.ui-pagination')[index];
      if (pagination === undefined) throw new Error(`Pagination ${index} was not rendered.`);
      return pagination;
    };

    const region = await invitesRegion();
    expect(await within(region).findByText('p24@exemplo.com')).toBeTruthy();
    expect(container.querySelectorAll('.ui-pagination')).toHaveLength(2);

    // The invitations go back to page 1 (their list reloads and the pagination returns); the team stays on page 2.
    fireEvent.click(within(paginationAt(1)).getByRole('button', { name: 'Página anterior' }));
    await waitFor(() => expect(probe.search).not.toContain('convites='));
    expect(probe.search).toContain('page=2');
    expect(await within(region).findByText('p0@exemplo.com')).toBeTruthy();

    // Forward again, then the team goes back to page 1; the invitations keep their page.
    fireEvent.click(within(paginationAt(1)).getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(probe.search).toContain('convites=2'));
    expect(await within(region).findByText('p24@exemplo.com')).toBeTruthy();
    fireEvent.click(within(paginationAt(0)).getByRole('button', { name: 'Página anterior' }));
    await waitFor(() => expect(probe.search).not.toContain('page='));
    expect(probe.search).toContain('convites=2');
  });

  it('returns to the last valid page instead of showing pending invitations as empty (#229)', async () => {
    const { impl } = makeFetch({
      invitations: (query) => {
        const page = Number(query.get('page') ?? '1');
        return page > 1
          ? invitationsResponse([], query, { totalItems: 3, totalPages: 1 })
          : invitationsResponse(defaultInvites, query, { totalItems: 3, totalPages: 1 });
      }
    });
    const { probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?convites=2`);

    const region = await invitesRegion();
    expect(await within(region).findByText('ana@exemplo.com')).toBeTruthy();
    await waitFor(() => expect(probe.search).not.toContain('convites='));
    expect(within(region).queryByText('Nenhum convite aguardando aceite')).toBeNull();
  });

  it('never shows one agency\'s invitations under another with the same cache', async () => {
    const { impl } = makeFetch({
      invitations: (_query, agencyId) => invitationsResponse(agencyId === AGENCY_B ? [invitePaulo] : [inviteAna])
    });
    const { probe } = renderCollaborators(impl);

    await screen.findByText('ana@exemplo.com');
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/colaboradores`); });

    await screen.findByText('paulo@exemplo.com');
    expect(screen.queryByText('ana@exemplo.com')).toBeNull();
  });

  it('renders an untrusted role name as literal text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeFetch({ invitations: (query) => invitationsResponse([{ ...inviteAna, role: { key: 'production', name: hostile } }], query) });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText(hostile)).toBeTruthy();
    expect(region.querySelector('img')).toBeNull();
  });

  // Aceite: "Nenhum token de convite aparece na tela, em nenhum estado." A response carrying one
  // fails the strict contract instead of rendering it, in the listing and in the resend alike.
  it('never renders an invitation token, even if a response carries one', async () => {
    const { impl } = makeFetch({
      invitations: (query) => json({ data: [{ ...inviteAna, token: 'live-credential' }], meta: meta(Number(query.get('page') ?? 1), 1, 1) })
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    await within(region).findByRole('alert');
    expect(screen.queryByText('live-credential')).toBeNull();
  });

  it('does not render a token from the resend response either', async () => {
    const { impl } = makeFetch({
      resend: () => json({ invitationId: inviteJulia.id, expiresAt: inviteJulia.expiresAt, token: 'live-credential' })
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Reenviar convite de ana@exemplo.com' }));

    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível reenviar o convite.');
    expect(screen.queryByText('live-credential')).toBeNull();
  });
});

describe('invite collaborator modal (#107)', () => {
  const invitesRegion = () => screen.findByRole('region', { name: 'Convites aguardando aceite' });

  const openInvite = async (container: HTMLElement): Promise<HTMLElement> => {
    const header = container.querySelector('.collaborators__header');
    if (header === null) throw new Error('The collaborators header was not rendered.');
    fireEvent.click(within(header as HTMLElement).getByRole('button', { name: /Convidar/ }));
    return await screen.findByRole('dialog', { name: 'Convidar colaborador' });
  };

  const fillInvite = async (dialog: HTMLElement, email: string, roleId: string = PRODUCTION_ROLE_ID): Promise<void> => {
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: email } });
    await within(dialog).findByRole('option', { name: 'Produção' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Papel' }), { target: { value: roleId } });
  };

  it('opens with the e-mail and role fields, the role hint and no cargo or remuneration', async () => {
    const { impl } = makeFetch();
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');

    const dialog = await openInvite(container);
    expect(within(dialog).getByRole('textbox', { name: 'E-mail' })).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'Papel' })).toBeTruthy();
    expect(within(dialog).getByText('Define o que a pessoa poderá fazer.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Enviar convite' }).hasAttribute('disabled')).toBe(true);
    expect(within(dialog).queryByText(/cargo|remunera/i)).toBeNull();
    expect(dialog.querySelectorAll('input, select')).toHaveLength(2);
  });

  it('offers Admin only to the Owner, even if the roles response leaks it', async () => {
    const { impl } = makeFetch({ isOwner: true });
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const ownerDialog = await openInvite(container);
    await within(ownerDialog).findByRole('option', { name: 'Admin' });
    const ownerSelect = within(ownerDialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement;
    expect(Array.from(ownerSelect.options).map((option) => option.textContent)).toEqual([
      'Selecione', 'Gestor de conta', 'Admin', 'Financeiro', 'Produção', 'Vendas'
    ]);
    cleanup();

    // The API hides `admin` from a non-owner (#287); the screen has to hide it too, so this
    // response deliberately leaks it.
    const leaked = makeFetch({ roles: () => json({ data: SYSTEM_ROLES }) });
    const leakedRender = renderCollaborators(leaked.impl);
    await screen.findByText('Ana Prado');
    const leakedDialog = await openInvite(leakedRender.container);
    await within(leakedDialog).findByRole('option', { name: 'Gestor de conta' });
    const leakedSelect = within(leakedDialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement;
    expect(Array.from(leakedSelect.options).map((option) => option.textContent)).toEqual([
      'Selecione', 'Gestor de conta', 'Financeiro', 'Produção', 'Vendas'
    ]);
    expect(Array.from(leakedSelect.options).some((option) => option.value === ADMIN_ROLE_ID)).toBe(false);
  });

  it('keeps Enviar convite disabled until e-mail and role are both filled', async () => {
    const { impl } = makeFetch();
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);
    const submit = within(dialog).getByRole('button', { name: 'Enviar convite' });
    const email = within(dialog).getByRole('textbox', { name: 'E-mail' });
    const role = within(dialog).getByRole('combobox', { name: 'Papel' });

    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(email, { target: { value: 'nova@exemplo.com' } });
    expect(submit.hasAttribute('disabled')).toBe(true);
    await within(dialog).findByRole('option', { name: 'Produção' });
    fireEvent.change(role, { target: { value: PRODUCTION_ROLE_ID } });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.change(email, { target: { value: '' } });
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('refuses a malformed e-mail next to the field, preserving what was typed and sending nothing', async () => {
    const { impl, calls } = makeFetch();
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'nao-e-email');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Informe um e-mail válido.')).toBeTruthy();
    expect((within(dialog).getByRole('textbox', { name: 'E-mail' }) as HTMLInputElement).value).toBe('nao-e-email');
    expect(calls.some((call) => call.startsWith('POST /agencies/'))).toBe(false);
  });

  it('refuses an empty form even if the disabled button is bypassed', async () => {
    const { impl, calls } = makeFetch();
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);
    const form = dialog.querySelector('form');
    if (form === null) throw new Error('The invite form was not rendered.');

    fireEvent.submit(form);
    expect(await within(dialog).findByText('Informe o e-mail.')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: 'nova@exemplo.com' } });
    fireEvent.submit(form);
    expect(await within(dialog).findByText('Selecione um papel.')).toBeTruthy();
    expect(calls.some((call) => call.startsWith('POST /agencies/'))).toBe(false);
  });

  it('sends e-mail and role, shows the 7-day confirmation and adds the invite to the pending list without reloading', async () => {
    const created = { ...inviteAna, id: 'abababab-abab-4bab-8bab-abababababab', email: 'nova@exemplo.com', expiresAt: expiryInDays(7) };
    let pending = [inviteAna];
    const bodies: unknown[] = [];
    const { impl, calls } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      createInvitation: (body) => {
        bodies.push(body);
        pending = [...pending, { ...created, email: (body as { email: string }).email }];
        return json({ invitationId: created.id, expiresAt: created.expiresAt }, 201);
      }
    });
    const { container, probe } = renderCollaborators(impl);
    const region = await invitesRegion();
    await within(region).findByText('ana@exemplo.com');
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'Nova@Exemplo.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Convite enviado para nova@exemplo.com. O link vale por 7 dias.')).toBeTruthy();
    // The creation invalidates the pending list, so the new invite appears behind the modal.
    expect(await within(region).findByText('nova@exemplo.com')).toBeTruthy();
    expect(region.querySelector('.invites__count')?.textContent).toBe('2');
    expect(bodies).toEqual([{ email: 'nova@exemplo.com', roleId: PRODUCTION_ROLE_ID }]);
    expect(calls).toContain(`POST /agencies/${AGENCY_A}/invitations/collaborators`);
    expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/colaboradores`);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('warns that the previous pending invitation stopped working when the e-mail already had one', async () => {
    const created = { ...inviteJulia, id: 'abababab-abab-4bab-8bab-abababababab', email: 'ana@exemplo.com', expiresAt: expiryInDays(7) };
    let pending = [inviteAna, invitePaulo];
    const { impl } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      createInvitation: () => {
        pending = [invitePaulo, created];
        return json({ invitationId: created.id, expiresAt: created.expiresAt }, 201);
      }
    });
    const { container } = renderCollaborators(impl);
    const region = await invitesRegion();
    await within(region).findByText('expira em 5 dias');
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'ana@exemplo.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Convite enviado para ana@exemplo.com. O link vale por 7 dias.')).toBeTruthy();
    expect(within(dialog).getByText('O convite anterior para este e-mail deixou de valer.')).toBeTruthy();
    // One invitation for that e-mail, with the renewed deadline, in the list behind the modal.
    expect(await within(region).findByText('expira em 7 dias')).toBeTruthy();
    expect(within(region).getAllByText('ana@exemplo.com')).toHaveLength(1);
  });

  it('shows its own message when the e-mail already belongs to the team, preserving the typed value', async () => {
    const { impl } = makeFetch({
      createInvitation: () => json({ error: { code: 'MEMBERSHIP_EXISTS', message: 'private diagnostic' } }, 409)
    });
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'ana@exemplo.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Esta pessoa já faz parte da equipe.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect((within(dialog).getByRole('textbox', { name: 'E-mail' }) as HTMLInputElement).value).toBe('ana@exemplo.com');
    expect(within(dialog).getByRole('button', { name: 'Enviar convite' }).hasAttribute('disabled')).toBe(false);
  });

  it('explains a 403 without leaking the API message', async () => {
    const { impl } = makeFetch({
      createInvitation: () => json({ error: { code: 'FORBIDDEN', message: 'private diagnostic' } }, 403)
    });
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'nova@exemplo.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Você não tem permissão para convidar para esta agência.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
  });

  it.each([400, 422])('marks the field the API refused on a %i, without echoing the API message', async (status) => {
    const { impl } = makeFetch({
      createInvitation: () => json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'private diagnostic',
          details: { issues: [{ path: 'email', code: 'invalid_string', message: 'private issue message' }] }
        }
      }, status)
    });
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'nova@exemplo.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Informe um e-mail válido.')).toBeTruthy();
    expect((within(dialog).getByRole('textbox', { name: 'E-mail' }) as HTMLInputElement).value).toBe('nova@exemplo.com');
    expect(dialog.textContent).not.toContain('private');
  });

  it('marks the role field when the API refuses the chosen role', async () => {
    const { impl } = makeFetch({
      createInvitation: () => json({ error: { code: 'INVALID_ROLE', message: 'private diagnostic' } }, 400)
    });
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'nova@exemplo.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Escolha um papel da lista.')).toBeTruthy();
    expect((within(dialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement).value).toBe(PRODUCTION_ROLE_ID);
    expect(dialog.textContent).not.toContain('private diagnostic');
  });

  it('shows a form-level message for a validation failure that names no field', async () => {
    const { impl } = makeFetch({
      createInvitation: () => json({ error: { code: 'VALIDATION_ERROR', message: 'private diagnostic' } }, 400)
    });
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'nova@exemplo.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Revise os dados do convite.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
  });

  // The API commits the invitation before sending the e-mail: a 502 leaves a real invitation
  // behind, so the list must refetch and show it even though the modal reports the failure.
  it('refreshes the pending list even when the send fails after the invitation was stored', async () => {
    const created = { ...inviteJulia, id: 'abababab-abab-4bab-8bab-abababababab', email: 'nova@exemplo.com', expiresAt: expiryInDays(7) };
    let pending = [inviteAna];
    const { impl, calls } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      createInvitation: () => {
        pending = [...pending, created];
        return json({ error: { code: 'EMAIL_DELIVERY_FAILED', message: 'private diagnostic' } }, 502);
      }
    });
    const { container } = renderCollaborators(impl);
    const region = await invitesRegion();
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'nova@exemplo.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    expect(await within(dialog).findByText('Não foi possível enviar o convite. Tente de novo.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect(await within(region).findByText('nova@exemplo.com')).toBeTruthy();
    expect(calls.filter((call) => call === `POST /agencies/${AGENCY_A}/invitations/collaborators`)).toHaveLength(1);
  });

  it('offers a retry when the roles fail to load, without breaking the modal', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      roles: () => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500)
          : rolesFor(false);
      }
    });
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);

    const alert = await within(dialog).findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar os papéis.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect((within(dialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement).disabled).toBe(false));
    expect(Array.from((within(dialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement).options).map((option) => option.textContent)).toContain('Produção');
  });

  it('keeps the busy state on the send button, not on the whole modal', async () => {
    let finish: (value: Response) => void = () => undefined;
    const deferred = new Promise<Response>((resolve) => { finish = resolve; });
    const { impl } = makeFetch({ createInvitation: () => deferred });
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const dialog = await openInvite(container);
    await fillInvite(dialog, 'nova@exemplo.com');
    const submit = within(dialog).getByRole('button', { name: 'Enviar convite' });
    fireEvent.click(submit);

    await waitFor(() => expect(submit.getAttribute('aria-busy')).toBe('true'));
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect((within(dialog).getByRole('textbox', { name: 'E-mail' }) as HTMLInputElement).disabled).toBe(false);
    await act(async () => { finish(json({ invitationId: inviteAna.id, expiresAt: expiryInDays(7) }, 201)); });
    expect(await within(dialog).findByText(/Convite enviado para nova@exemplo.com/)).toBeTruthy();
  });

  it('closes on Escape and returns the focus to the Convidar button', async () => {
    const { impl } = makeFetch();
    const { container } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');
    const header = container.querySelector('.collaborators__header');
    if (header === null) throw new Error('The collaborators header was not rendered.');
    const invite = within(header as HTMLElement).getByRole('button', { name: /Convidar/ });
    invite.focus();
    fireEvent.click(invite);
    const dialog = await screen.findByRole('dialog', { name: 'Convidar colaborador' });

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(invite);
  });

  it('is not reachable without colaborador.convidar', async () => {
    const { impl, calls } = makeFetch({ permissions: ['colaborador.visualizar'] });
    renderCollaborators(impl);
    await screen.findByText('Ana Prado');

    expect(screen.queryByRole('button', { name: /Convidar/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((call) => call.includes('/roles'))).toBe(false);
  });
});

describe('inviteLinkDays (#107)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  it('reads the deadline from the API expiry instead of a screen constant', () => {
    const now = new Date(2026, 9, 7, 12);
    expect(inviteLinkDays(new Date(now.getTime() + 7 * DAY).toISOString(), now)).toBe(7);
    expect(inviteLinkDays(new Date(now.getTime() + 5 * DAY).toISOString(), now)).toBe(5);
    expect(inviteLinkDays(new Date(now.getTime() - 1000).toISOString(), now)).toBe(1);
  });
});

describe('pendingInviteExpiryLabel (#106)', () => {
  // Local dates on purpose: the label counts calendar days in the reader's day, not elapsed time.
  const at = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute);

  it.each([
    { label: 'later the same day', now: at(2026, 10, 6, 12), expiresAt: at(2026, 10, 6, 23), expected: 'expira hoje' },
    // 30 minutes away, but the next calendar day: "amanhã" is how people read it.
    { label: 'next calendar day, half an hour later', now: at(2026, 10, 6, 23), expiresAt: at(2026, 10, 7, 0, 30), expected: 'expira amanhã' },
    { label: 'tomorrow morning', now: at(2026, 10, 6, 12), expiresAt: at(2026, 10, 7, 9), expected: 'expira amanhã' },
    { label: 'two calendar days away', now: at(2026, 10, 6, 12), expiresAt: at(2026, 10, 8, 9), expected: 'expira em 2 dias' },
    { label: 'five calendar days away', now: at(2026, 10, 6, 12), expiresAt: at(2026, 10, 11, 9), expected: 'expira em 5 dias' },
    { label: 'seven calendar days away', now: at(2026, 10, 6, 12), expiresAt: at(2026, 10, 13, 9), expected: 'expira em 7 dias' }
  ])('labels the deadline $label as "$expected"', ({ now, expiresAt, expected }) => {
    expect(pendingInviteExpiryLabel(expiresAt.toISOString(), now)).toBe(expected);
  });

  it('does not claim an already-passed deadline expires today', () => {
    // Same calendar day, but the moment has passed.
    expect(pendingInviteExpiryLabel(at(2026, 10, 6, 9).toISOString(), at(2026, 10, 6, 12))).toBe('expirado');
    expect(pendingInviteExpiryLabel(at(2026, 10, 5).toISOString(), at(2026, 10, 6))).toBe('expirado');
    expect(pendingInviteExpiryLabel('not-a-date', at(2026, 10, 6))).toBe('expirado');
  });
});

describe('self profile editing (#108)', () => {
  const selfUrl = (id = anaPrado.membershipId) => `/agencia/${AGENCY_A}/colaboradores?colaborador=${id}`;
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const modalFileInput = (modal: HTMLElement): HTMLInputElement =>
    modal.querySelector('input[type="file"]') as HTMLInputElement;

  it('renders the own profile editable, with role fields read-only and their notes', async () => {
    const { impl } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    expect(name.value).toBe('Ana Prado');
    expect(within(modal).getByRole('button', { name: 'Trocar foto' })).toBeTruthy();
    expect(within(modal).getByRole('button', { name: 'Salvar' })).toBeTruthy();
    expect(within(modal).getByText('Editora')).toBeTruthy();
    expect(within(modal).getByText('Produção')).toBeTruthy();
    expect(within(modal).getByText('ana@example.test')).toBeTruthy();
    expect(within(modal).getByText('Quem administra a agência define o cargo.')).toBeTruthy();
    expect(within(modal).getByText('A troca de e-mail é feita pela operação.')).toBeTruthy();
    expect(within(modal).getByText('Esta foto aparece nos seus crachás em todas as agências.')).toBeTruthy();
    expect(within(modal).queryByRole('combobox')).toBeNull();
    // No photo yet: initials, never a generic icon.
    expect(within(modal).getByText('AP')).toBeTruthy();
    expect(modal.querySelector('img')).toBeNull();
  });

  it('shows the own name once, in the modal heading, without repeating it under the photo', async () => {
    const { impl } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });

    expect(within(modal).getByRole('heading', { name: 'Ana Prado' })).toBeTruthy();
    expect(within(modal).getAllByText('Ana Prado')).toHaveLength(1);
    expect(modal.querySelector('.collaborator-detail__self-name')).toBeNull();
  });

  it('labels the read-only fields with the profile class, not the Select internal one', async () => {
    const { impl } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });

    expect(Array.from(modal.querySelectorAll('.self-profile__label')).map((element) => element.textContent))
      .toEqual(['Cargo', 'Papel', 'E-mail']);
    expect(modal.querySelector('.ui-field__label')).toBeNull();
  });

  it('does not send a blank or oversized name and shows the field error', async () => {
    const { impl, profileBodies } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    expect(await within(modal).findByText('Informe o seu nome.')).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(profileBodies).toEqual([]);

    fireEvent.change(name, { target: { value: 'x'.repeat(121) } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    expect(await within(modal).findByText('O nome pode ter no máximo 120 caracteres.')).toBeTruthy();
    expect(profileBodies).toEqual([]);
  });

  it('refuses a name with a character the display-name rules forbid, without sending it', async () => {
    const { impl, profileBodies } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    const hostile = `Ana${String.fromCharCode(7)}Prado`;
    fireEvent.change(name, { target: { value: hostile } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));

    expect(await within(modal).findByText('O nome contém caracteres que não são aceitos.')).toBeTruthy();
    expect(profileBodies).toEqual([]);
    expect(name.value).toBe(hostile);
  });

  it.each([400, 500])('keeps the typed name and shows its own message when the PATCH answers %i', async (status) => {
    const { impl, profileBodies } = makeSelfFetch({
      updateProfileResponse: () => json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, status)
    });
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Ana Nova' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));

    expect(await within(modal).findByText('Não foi possível salvar o nome. Tente de novo.')).toBeTruthy();
    expect(modal.textContent).not.toContain('private diagnostic');
    expect(name.value).toBe('Ana Nova');
    expect(profileBodies).toHaveLength(1);
  });

  it('follows an external name change while untouched and keeps a typed draft when dirty', async () => {
    const { impl } = makeSelfFetch();
    const { queryClient } = renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    const detailKey = ['agency', AGENCY_A, 'collaborators', 'detail', anaPrado.membershipId];

    // Another tab (or a revalidation) brought a newer name; the untouched field follows it.
    act(() => { queryClient.setQueryData(detailKey, { ...anaSelf, name: 'Ana Atualizada' }); });
    await waitFor(() => expect(name.value).toBe('Ana Atualizada'));

    // A typed draft is not overwritten by the same external update.
    fireEvent.change(name, { target: { value: 'Rascunho local' } });
    act(() => { queryClient.setQueryData(detailKey, { ...anaSelf, name: 'Outra Externa' }); });
    expect(name.value).toBe('Rascunho local');
  });

  it('saves a new name that shows in the modal, the badge and the account menu at once', async () => {
    const { impl, profileBodies } = makeSelfFetch();
    const { container } = renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Ana Prado Silva' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('dialog', { name: 'Ana Prado Silva' })).toBe(modal);
    await waitFor(() => expect(profileBodies).toContainEqual({ name: 'Ana Prado Silva' }));
    // The modal heading is the only place the name appears inside the dialog.
    expect(within(modal).getByRole('heading', { name: 'Ana Prado Silva' })).toBeTruthy();
    const badgeName = (): string | null | undefined =>
      container.querySelector('.collaborators__grid .ui-badge-card__name')?.textContent;
    await waitFor(() => expect(badgeName()).toBe('Ana Prado Silva'));
    // The app header reads the name from the session, so it must be fresh too.
    expect(await screen.findByRole('button', { name: 'Ana Prado Silva' })).toBeTruthy();
  });

  it('refuses a file outside the image allowlist without sending anything', async () => {
    const { impl, photoBodies } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(modalFileInput(modal), {
      target: { files: [new File(['<html>'], 'pagina.html', { type: 'text/html' })] }
    });
    expect(await within(modal).findByText('Formato não aceito. Envie uma foto PNG, JPEG, GIF ou WebP.')).toBeTruthy();
    expect(photoBodies).toEqual([]);
  });

  it('refuses a file above the accepted size without sending anything', async () => {
    const { impl, photoBodies } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(modalFileInput(modal), {
      target: { files: [new File([new Uint8Array(PROFILE_PHOTO_MAX_BYTES + 1)], 'grande.png', { type: 'image/png' })] }
    });
    expect(await within(modal).findByText('A foto passa do tamanho máximo aceito.')).toBeTruthy();
    expect(photoBodies).toEqual([]);
  });

  it('uploads a file the browser reported no type for, letting the API decide by the bytes', async () => {
    const { impl, calls, photoBodies } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const untagged = new File([pngBytes], 'foto', { type: '' });
    expect(untagged.type).toBe('');

    fireEvent.change(modalFileInput(modal), { target: { files: [untagged] } });

    await waitFor(() => expect(photoBodies).toHaveLength(1), { timeout: 5000 });
    expect(calls).toContain('POST /me/photo');
    expect(within(modal).queryByText('Formato não aceito. Envie uma foto PNG, JPEG, GIF ou WebP.')).toBeNull();
  });

  it('uploads with local progress without blocking the modal, and refreshes the badge', async () => {
    let finish: (value: Response) => void = () => undefined;
    const deferred = new Promise<Response>((resolve) => { finish = resolve; });
    const newPhoto = 'https://storage.test/ana-2026.png';
    const { impl, calls, photoBodies, person } = makeSelfFetch({ uploadResponse: () => deferred });
    const { probe } = renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(modalFileInput(modal), {
      target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] }
    });
    await waitFor(() => expect(photoBodies).toEqual([{ imageBase64: Buffer.from(pngBytes).toString('base64') }]), { timeout: 5000 });
    expect(modal.querySelector('progress')).toBeTruthy();
    expect(within(modal).getByText('Enviando foto…')).toBeTruthy();
    // Only the photo control is busy; the modal itself stays interactive.
    expect(within(modal).getByRole('button', { name: 'Trocar foto' }).hasAttribute('disabled')).toBe(true);
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    expect(name.disabled).toBe(false);
    await act(async () => {
      finish(json({ imageUrl: newPhoto }));
      // The deferred `uploadResponse` bypasses the fake's own success path, so the stored person is
      // updated by hand here; the real API persists the reference before it answers.
      person().photoUrl = newPhoto;
    });
    await waitFor(() => expect(modal.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe(newPhoto));
    await waitFor(() => expect(document.querySelector('.collaborators__grid img.ui-avatar__photo')?.getAttribute('src')).toBe(newPhoto));
    // The photo travelled only the global route, never an agency-scoped one, and nothing reloaded.
    expect(calls.filter((call) => call.startsWith('POST /'))).toEqual(['POST /me/photo']);
    expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/colaboradores`);
    expect(screen.queryByText(/nesta agência/i)).toBeNull();
  });

  it.each([
    [415, 'UNSUPPORTED_MEDIA_TYPE', 'Formato não aceito. Envie uma foto PNG, JPEG, GIF ou WebP.'],
    [413, 'PAYLOAD_TOO_LARGE', 'A foto passa do tamanho máximo aceito.']
  ] as const)('shows the API\'s %i rejection as its own message', async (status, code, expected) => {
    const { impl, photoBodies } = makeSelfFetch({
      uploadResponse: () => json({ error: { code, message: 'the api private message' } }, status)
    });
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(modalFileInput(modal), {
      target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] }
    });
    expect(await within(modal).findByText(expected)).toBeTruthy();
    expect(photoBodies).toHaveLength(1);
    expect(modal.textContent).not.toContain('the api private message');
    expect(modal.querySelector('progress')).toBeNull();
  });

  // Split on purpose (review of #288): each global field has its own invalidation call in
  // `SelfProfilePhoto` and `SelfProfileFields`. A test that changes both only proves the pair,
  // not either call, so the photo and the name are exercised apart from each other.
  it('refreshes the photo cached for another agency when only the photo changes', async () => {
    const membershipB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const newPhoto = 'https://storage.test/ana-global.png';
    let photoUrl: string | null = null;
    const personFor = (agencyId: string) => ({
      ...anaSelf,
      membershipId: agencyId === AGENCY_B ? membershipB : anaPrado.membershipId,
      photoUrl
    });
    const { impl } = makeFetch({
      session: () => json({ user: { id: sessionBody.user.id, name: anaPrado.name, email: sessionEmailAfterChange }, session: sessionBody.session }),
      collaborators: (_query, agencyId) => json({ data: [personFor(agencyId)], meta: meta(1, 1, 1) }),
      detail: (membershipId, agencyId) => membershipId === membershipB || membershipId === anaPrado.membershipId
        ? json(personFor(agencyId))
        : json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404),
      uploadPhoto: () => { photoUrl = newPhoto; return json({ imageUrl: newPhoto }); }
    });
    const { container, probe } = renderCollaborators(impl);

    // The account menu shows the same person's name; scope the badge, or the query matches twice.
    const badgeName = (): string | null | undefined =>
      container.querySelector('.collaborators__grid .ui-badge-card__name')?.textContent;

    // Agency A: Ana's badge starts with her name and initials, no photo.
    await waitFor(() => expect(badgeName()).toBe('Ana Prado'));
    // Agency B: the same global person, cached there before the upload.
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/colaboradores`); });
    await waitFor(() => expect(badgeName()).toBe('Ana Prado'));
    expect(container.querySelector('.collaborators__grid img.ui-avatar__photo')).toBeNull();

    // Back to A, upload a photo from the own profile without touching the name.
    await act(async () => { probe.navigate(`/agencia/${AGENCY_A}/colaboradores`); });
    fireEvent.click(await screen.findByRole('link', { name: 'Ver detalhes de Ana Prado' }));
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(modal.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] }
    });
    await waitFor(() => expect(modal.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe(newPhoto), { timeout: 5000 });

    // B's cache predates the upload; the photo must be there without a reload. The name never
    // changed, so only the photo invalidation can have carried anything across.
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/colaboradores`); });
    await waitFor(() => expect(container.querySelector('.collaborators__grid img.ui-avatar__photo')?.getAttribute('src')).toBe(newPhoto), { timeout: 5000 });
    expect(badgeName()).toBe('Ana Prado');
  });

  it('refreshes the name cached for another agency when only the name changes', async () => {
    const membershipB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    let displayName = anaPrado.name;
    const personFor = (agencyId: string) => ({
      ...anaSelf,
      name: displayName,
      membershipId: agencyId === AGENCY_B ? membershipB : anaPrado.membershipId
    });
    const { impl } = makeFetch({
      session: () => json({ user: { id: sessionBody.user.id, name: displayName, email: sessionEmailAfterChange }, session: sessionBody.session }),
      collaborators: (_query, agencyId) => json({ data: [personFor(agencyId)], meta: meta(1, 1, 1) }),
      detail: (membershipId, agencyId) => membershipId === membershipB || membershipId === anaPrado.membershipId
        ? json(personFor(agencyId))
        : json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404),
      updateProfile: (body) => {
        displayName = (body as { name: string }).name;
        return json({ id: sessionBody.user.id, name: displayName });
      }
    });
    const { container, probe } = renderCollaborators(impl);

    // The account menu shows the same person's name; scope the badge, or the query matches twice.
    const badgeName = (): string | null | undefined =>
      container.querySelector('.collaborators__grid .ui-badge-card__name')?.textContent;

    // Agency A, then B: the same global person cached under both, still named "Ana Prado".
    await waitFor(() => expect(badgeName()).toBe('Ana Prado'));
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/colaboradores`); });
    await waitFor(() => expect(badgeName()).toBe('Ana Prado'));

    // Back to A, save a new name without uploading a photo.
    await act(async () => { probe.navigate(`/agencia/${AGENCY_A}/colaboradores`); });
    fireEvent.click(await screen.findByRole('link', { name: 'Ver detalhes de Ana Prado' }));
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(within(modal).getByRole('textbox', { name: 'Nome' }), { target: { value: 'Ana Prado Silva' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    await screen.findByRole('dialog', { name: 'Ana Prado Silva' });

    // B's cache predates the save; the name must be there without a reload. No photo was uploaded,
    // so only the name invalidation can have carried anything across.
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/colaboradores`); });
    await waitFor(() => expect(badgeName()).toBe('Ana Prado Silva'));
    expect(container.querySelector('.collaborators__grid img.ui-avatar__photo')).toBeNull();
  });

  it('keeps another person\'s name and photo read-only', async () => {
    const { impl } = makeFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    expect(within(modal).queryByRole('textbox')).toBeNull();
    expect(within(modal).queryByRole('button', { name: 'Trocar foto' })).toBeNull();
    expect(within(modal).queryByRole('button', { name: 'Salvar' })).toBeNull();
    expect(modal.querySelector('input[type="file"]')).toBeNull();
  });

  it('renders the typed name as literal text, never as HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: hostile } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(within(modal).getByRole('heading', { name: hostile })).toBeTruthy());
    expect(modal.querySelector('img')).toBeNull();
    expect(modal.querySelector('[onerror]')).toBeNull();
  });
});

// Issue #228: the grid must close in 3 and 4 columns. The shell's `.agency-content` is 840px at its
// widest (72rem minus the 16rem nav, the gap and the padding), so the badge minimum has to let four
// columns fit. jsdom has no layout, so the test reads the real CSS value and applies the same math
// `repeat(auto-fill, minmax(..., 1fr))` does.
describe('collaborators grid columns (#228)', () => {
  const globalsCss = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');

  const gridMinRem = (): number => {
    const match = /\.collaborators__grid\s*\{[^}]*minmax\(([\d.]+)rem,\s*1fr\)/.exec(globalsCss);
    if (match === null) throw new Error('The collaborators grid min width was not found in globals.css.');
    return Number(match[1]);
  };

  const columnsFor = (availableWidthPx: number, minRem: number, gapRem = 1, rootFontSizePx = 16): number => {
    const minPx = minRem * rootFontSizePx;
    const gapPx = gapRem * rootFontSizePx;
    return Math.max(1, Math.floor((availableWidthPx + gapPx) / (minPx + gapPx)));
  };

  it('fits four columns in the 840px content area and three in a narrower one', () => {
    const minRem = gridMinRem();
    expect(columnsFor(840, minRem)).toBe(4);
    expect(columnsFor(700, minRem)).toBe(3);
  });

  it('keeps the gap on the spacing scale', () => {
    expect(globalsCss).toMatch(/\.collaborators__grid\s*\{[^}]*gap:\s*var\(--space-4\)/);
  });
});

// Issue #105: removed links are a filter of the same grid, and reactivation starts with no role.
describe('removed filter and reactivation (#105)', () => {
  const reactivatePermissions = ['colaborador.visualizar', 'colaborador.remover', 'colaborador.alterar_papel'];
  const removedOnly = (query: URLSearchParams): readonly unknown[] =>
    query.get('status') === 'removed' ? [pauloLima] : [anaPrado, marioCosta, juliaReis];

  it('shows the status filter only to those who can see removed links', async () => {
    const without = makeFetch({ permissions: ['colaborador.visualizar'] });
    renderCollaborators(without.impl);
    await screen.findByText('Ana Prado');
    expect(screen.queryByRole('combobox', { name: 'Status' })).toBeNull();
    cleanup();

    const withRemove = makeFetch({ permissions: ['colaborador.visualizar', 'colaborador.remover'] });
    renderCollaborators(withRemove.impl);
    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeTruthy();
    cleanup();

    const withChangeRole = makeFetch({ permissions: ['colaborador.visualizar', 'colaborador.alterar_papel'] });
    renderCollaborators(withChangeRole.impl);
    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeTruthy();
    cleanup();

    const owner = makeFetch({ permissions: ['colaborador.visualizar'], isOwner: true });
    renderCollaborators(owner.impl);
    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeTruthy();
  });

  it('writes the removed filter to the URL and asks the server for removed links only', async () => {
    const queries: string[] = [];
    const { impl } = makeFetch({
      permissions: reactivatePermissions,
      collaborators: (query) => { queries.push(query.toString()); return listResponse(removedOnly(query)); }
    });
    const { container, probe } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'removed' } });

    await screen.findByText('Paulo Lima');
    expect(badgeNames(container)).toEqual(['Paulo Lima']);
    expect(probe.search).toContain('status=removed');
    expect(queries.some((query) => query.includes('status=removed'))).toBe(true);

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'active' } });
    await screen.findByText('Ana Prado');
    expect(probe.search).not.toContain('status=');
  });

  it('marks the removed badge as ended', async () => {
    const { impl } = makeFetch({
      permissions: reactivatePermissions,
      collaborators: (query) => listResponse(removedOnly(query))
    });
    renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    await screen.findByText('Paulo Lima');
    expect(screen.getByText('removido')).toBeTruthy();
  });

  it('starts the reactivation with no role chosen and the button disabled until one is chosen', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({
      permissions: reactivatePermissions,
      collaborators: (query) => listResponse(removedOnly(query)),
      roles: () => rolesFor(false),
      reactivate: (membershipId, body) => {
        bodies.push({ membershipId, body });
        return json({ ...pauloLima, status: 'active' });
      }
    });
    renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    await screen.findByText('Paulo Lima');

    fireEvent.click(screen.getByRole('button', { name: 'Reativar Paulo Lima' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reativar Paulo Lima' });
    const role = within(dialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement;
    const confirm = within(dialog).getByRole('button', { name: 'Reativar' }) as HTMLButtonElement;
    // Paulo's previous role was Produção, and the select still starts empty.
    expect(role.value).toBe('');
    expect(confirm.disabled).toBe(true);

    await within(dialog).findByRole('option', { name: 'Produção' });
    fireEvent.change(role, { target: { value: PRODUCTION_ROLE_ID } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(bodies).toEqual([{ membershipId: pauloLima.membershipId, body: { roleId: PRODUCTION_ROLE_ID } }]));
  });

  it('offers Admin in the reactivation roles only to the Owner', async () => {
    // A regressed API that returns admin to everyone: the screen must still hide it.
    const nonOwner = makeFetch({
      permissions: reactivatePermissions,
      collaborators: (query) => listResponse(removedOnly(query)),
      roles: () => json({ data: SYSTEM_ROLES })
    });
    renderCollaborators(nonOwner.impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    await screen.findByText('Paulo Lima');
    fireEvent.click(screen.getByRole('button', { name: 'Reativar Paulo Lima' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reativar Paulo Lima' });
    await within(dialog).findByRole('option', { name: 'Produção' });
    expect(within(dialog).getAllByRole('option').map((option) => option.textContent)).not.toContain('Admin');
    cleanup();

    const owner = makeFetch({
      permissions: ['colaborador.visualizar'],
      isOwner: true,
      collaborators: (query) => listResponse(removedOnly(query)),
      roles: () => json({ data: SYSTEM_ROLES })
    });
    renderCollaborators(owner.impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    await screen.findByText('Paulo Lima');
    fireEvent.click(screen.getByRole('button', { name: 'Reativar Paulo Lima' }));
    const ownerDialog = await screen.findByRole('dialog', { name: 'Reativar Paulo Lima' });
    expect(await within(ownerDialog).findByRole('option', { name: 'Admin' })).toBeTruthy();
  });

  it('moves the reactivated person to the active list without a reload', async () => {
    let people: Array<{ membershipId: string; status: string }> = [anaPrado, marioCosta, juliaReis, pauloLima];
    const { impl } = makeFetch({
      permissions: reactivatePermissions,
      collaborators: (query) => listResponse(people.filter((person) => person.status === (query.get('status') === 'removed' ? 'removed' : 'active'))),
      roles: () => rolesFor(false),
      reactivate: (membershipId, body) => {
        people = people.map((person) => person.membershipId === membershipId ? { ...person, status: 'active' } : person);
        expect(body).toEqual({ roleId: PRODUCTION_ROLE_ID });
        return json(people.find((person) => person.membershipId === membershipId)!);
      }
    });
    const { probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    await screen.findByText('Paulo Lima');

    fireEvent.click(screen.getByRole('button', { name: 'Reativar Paulo Lima' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reativar Paulo Lima' });
    await within(dialog).findByRole('option', { name: 'Produção' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Papel' }), { target: { value: PRODUCTION_ROLE_ID } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reativar' }));

    // The removed query was invalidated: he leaves the filter without a reload.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reativar Paulo Lima' })).toBeNull());
    expect(await screen.findByText('Ninguém foi removido desta agência')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'active' } });
    expect(await screen.findByText('Paulo Lima')).toBeTruthy();
    expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/colaboradores`);
  });

  it('gives the removed filter its own empty state, not the search one', async () => {
    const { impl } = makeFetch({
      permissions: reactivatePermissions,
      collaborators: () => listResponse([])
    });
    renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    expect(await screen.findByText('Ninguém foi removido desta agência')).toBeTruthy();
    expect(screen.queryByText(/Nenhuma pessoa encontrada/)).toBeNull();
    cleanup();

    const searchFilter = makeFetch({ permissions: reactivatePermissions, collaborators: () => listResponse([]) });
    renderCollaborators(searchFilter.impl, `/agencia/${AGENCY_A}/colaboradores?status=removed&q=paulo`);
    expect(await screen.findByText('Nenhuma pessoa encontrada para "paulo"')).toBeTruthy();
    expect(screen.queryByText('Ninguém foi removido desta agência')).toBeNull();
  });

  it('hides the reactivate action from someone who sees removed but cannot change roles', async () => {
    const { impl } = makeFetch({
      permissions: ['colaborador.visualizar', 'colaborador.remover'],
      collaborators: (query) => listResponse(removedOnly(query))
    });
    renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    await screen.findByText('Paulo Lima');
    expect(screen.getByText('removido')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reativar Paulo Lima' })).toBeNull();
  });

  it('shows its own message when the reactivation answers 409, and refreshes the list', async () => {
    const { impl, calls } = makeFetch({
      permissions: reactivatePermissions,
      collaborators: (query) => listResponse(removedOnly(query)),
      roles: () => rolesFor(false),
      reactivate: () => json({ error: { code: 'COLLABORATOR_NOT_REMOVED', message: 'the api private message' } }, 409)
    });
    renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    await screen.findByText('Paulo Lima');
    const removedCalls = (): number => calls.filter((call) => call.includes('status=removed')).length;
    const before = removedCalls();

    fireEvent.click(screen.getByRole('button', { name: 'Reativar Paulo Lima' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reativar Paulo Lima' });
    await within(dialog).findByRole('option', { name: 'Produção' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Papel' }), { target: { value: PRODUCTION_ROLE_ID } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reativar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe('Este vínculo já está ativo. A lista foi atualizada.');
    expect(dialog.textContent).not.toContain('the api private message');
    await waitFor(() => expect(removedCalls()).toBeGreaterThan(before));
  });

  it('shows its own message when the API refuses the reactivation with 403', async () => {
    const { impl } = makeFetch({
      permissions: reactivatePermissions,
      collaborators: (query) => listResponse(removedOnly(query)),
      roles: () => rolesFor(false),
      reactivate: () => json({ error: { code: 'FORBIDDEN', message: 'the api private message' } }, 403)
    });
    renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    await screen.findByText('Paulo Lima');

    fireEvent.click(screen.getByRole('button', { name: 'Reativar Paulo Lima' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reativar Paulo Lima' });
    await within(dialog).findByRole('option', { name: 'Produção' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Papel' }), { target: { value: PRODUCTION_ROLE_ID } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reativar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe('Você não tem permissão para reativar com esse papel.');
    expect(dialog.textContent).not.toContain('the api private message');
  });

  it('keeps the dialog open and offers a retry when the roles fail to load', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      permissions: reactivatePermissions,
      collaborators: (query) => listResponse(removedOnly(query)),
      roles: () => {
        attempts += 1;
        // The query client retries a 5xx once; the third attempt is the manual retry.
        return attempts <= 2 ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) : rolesFor(false);
      }
    });
    renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?status=removed`);
    await screen.findByText('Paulo Lima');

    fireEvent.click(screen.getByRole('button', { name: 'Reativar Paulo Lima' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reativar Paulo Lima' });
    // The query client retries a 5xx after its delay, so the error state arrives later.
    expect(await within(dialog).findByText('Não foi possível carregar os papéis. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect((within(dialog).getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement).disabled).toBe(false));
  });
});
