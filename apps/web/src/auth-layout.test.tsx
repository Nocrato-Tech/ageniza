// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { EmailChangeDialog } from './email-change.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

/** Behaves like the API for a visitor with no session: everything but the login answers as the real routes do. */
const visitorFetch = (login: Response = unauthenticated()): typeof fetch => async (input) => {
  const url = String(input);
  if (url.endsWith('/auth/session')) return unauthenticated();
  if (url.endsWith('/auth/login')) return login;
  if (url.endsWith('/health')) return json({ status: 'ok' });
  throw new Error(`unexpected ${url}`);
};

function SessionHarness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

const renderAt = (path: string, impl: typeof fetch = visitorFetch()) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl);
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  return render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <SessionHarness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};

const AUTH_PATHS = ['/entrar', '/senha/esquecida', '/senha/redefinir?token=abc', '/email/confirmar?token=abc'] as const;

describe('the auth layout', () => {
  it.each(AUTH_PATHS)('frames %s with the full logo, the legal links and a single main', async (path) => {
    const { container } = renderAt(path);
    await screen.findByRole('heading', { level: 1 });

    const brand = within(screen.getByRole('banner')).getByRole('link', { name: 'Ageniza' });
    expect(brand.getAttribute('href')).toBe('/');
    expect(brand.querySelector('img')?.getAttribute('src')).toBe('/brand/logo-para-fundo-claro.svg');
    const legal = within(screen.getByRole('contentinfo'));
    expect(legal.getByRole('link', { name: 'Termos de uso' }).getAttribute('href')).toBe('/termos');
    expect(legal.getByRole('link', { name: 'Privacidade' }).getAttribute('href')).toBe('/privacidade');
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' }).getAttribute('href')).toBe('#main-content');
    expect(container.querySelector('main')?.id).toBe('main-content');
  });

  it('serves the invitation inside the same frame', async () => {
    const impl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/session')) return unauthenticated();
      return json({ error: { code: 'INVALID_LINK', message: 'x' } }, 410);
    };
    renderAt('/convite/abc', impl);
    await screen.findByRole('heading', { name: 'Este convite não é mais válido' });

    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Ageniza' })).toBeTruthy();
    expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Privacidade' })).toBeTruthy();
  });

  it('keeps the other public pages in the plain public shell', async () => {
    const { container } = renderAt('/termos');
    await screen.findByRole('heading', { level: 1 });

    expect(container.querySelector('.auth')).toBeNull();
    expect(container.querySelector('.auth__legal')).toBeNull();
    expect(container.querySelector('.app-shell')).not.toBeNull();
  });

  it('hides the example week from assistive technology and gives it nothing to focus', async () => {
    const { container } = renderAt('/entrar');
    await screen.findByRole('heading', { name: 'Entrar' });

    const showcase = container.querySelector('.auth__showcase');
    expect(showcase?.getAttribute('aria-hidden')).toBe('true');
    expect(showcase?.textContent).toContain('O mês de cada cliente numa pauta só.');
    expect(showcase?.textContent).toContain('exemplo');
    expect(showcase?.querySelectorAll('a, button, input, h1, h2, h3, [tabindex]')).toHaveLength(0);
  });
});

describe('the login screen in the new layout', () => {
  it('titles the page "Entrar" and says what it is for', async () => {
    renderAt('/entrar');

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Entrar');
    expect(screen.getByText('A pauta da sua agência está te esperando.')).toBeTruthy();
  });

  it('puts the field message in the field, marks the control invalid and links them', async () => {
    renderAt('/entrar');
    await screen.findByRole('heading', { name: 'Entrar' });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    const email = screen.getByLabelText('E-mail');
    const message = screen.getByText('Informe um e-mail válido.');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(email.getAttribute('aria-describedby')).toBe(message.id);
    expect(message.closest('.ui-field')?.contains(email)).toBe(true);
    expect(screen.getByLabelText('Senha').getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the wrong-credential sentence in the form, between the password and the button, with an icon', async () => {
    renderAt('/entrar', visitorFetch(json({ error: { code: 'INVALID_CREDENTIALS', message: 'x' } }, 401)));
    await screen.findByRole('heading', { name: 'Entrar' });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'pessoa@example.test' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'uma senha qualquer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    const alert = await screen.findByRole('alert');
    const form = screen.getByRole('button', { name: 'Entrar' }).closest('form')!;
    expect(form.contains(alert)).toBe(true);
    expect(alert.textContent).toBe('E-mail ou senha incorretos.');
    expect(alert.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByLabelText('Senha').compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(screen.getByRole('button', { name: 'Entrar' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('E-mail').getAttribute('aria-invalid')).toBeNull();
  });

  it('keeps "Esqueci minha senha" after the password control, so the tab order reads label, field, link', async () => {
    renderAt('/entrar');
    await screen.findByRole('heading', { name: 'Entrar' });

    const link = screen.getByRole('link', { name: 'Esqueci minha senha' });
    expect(screen.getByLabelText('Senha').compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.parentElement?.contains(screen.getByLabelText('Senha'))).toBe(true);
  });

  it('keeps one primary action: Entrar is the only button in the primary variant', async () => {
    const { container } = renderAt('/entrar');
    await screen.findByRole('heading', { name: 'Entrar' });

    const primary = [...container.querySelectorAll('.ui-button--primary')];
    expect(primary.map((element) => element.textContent)).toEqual(['Entrar']);
  });

  it('keeps the invitation note under the button', async () => {
    renderAt('/entrar');
    await screen.findByRole('heading', { name: 'Entrar' });

    const note = screen.getByText('O acesso ao Ageniza é por convite.');
    expect(screen.getByRole('button', { name: 'Entrar' }).compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the way forward of a dead link', () => {
  it('is a link wearing the primary button, so the one action of the screen stays in indigo', async () => {
    renderAt('/senha/redefinir');

    const link = await screen.findByRole('link', { name: 'Pedir um novo link' });
    expect(link.className).toContain('ui-button--primary');
    expect(link.getAttribute('href')).toBe('/senha/esquecida');
  });

  it('is the same on the e-mail confirmation with no token', async () => {
    renderAt('/email/confirmar');

    const link = await screen.findByRole('link', { name: 'Entrar' });
    await waitFor(() => expect(link.className).toContain('ui-button--primary'));
    expect(link.getAttribute('href')).toBe('/entrar');
  });
});

const invitationFetch = (accountExists: boolean, create: Response): typeof fetch => async (input) => {
  const url = String(input);
  if (url.endsWith('/auth/session')) return unauthenticated();
  if (url.endsWith('/accept-new-account')) return create;
  if (url.includes('/invitations/')) {
    return json({ purpose: 'collaborator_invite', email: 'rafaela@example.test', agency: { name: 'Agência Um' }, client: null, accountExists });
  }
  throw new Error(`unexpected ${url}`);
};

describe('the invitation form in the new layout', () => {
  it('puts the missing name in its field and the failed creation in the form', async () => {
    renderAt('/convite/abc', invitationFetch(false, json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)));
    fireEvent.click(await screen.findByLabelText(/Li e aceito os/));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    const name = screen.getByLabelText('Nome');
    const message = screen.getByText('Informe o seu nome.');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toBe(message.id);

    fireEvent.change(name, { target: { value: 'Rafaela' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'uma senha longa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Não foi possível criar a conta. Tente de novo.');
    expect(screen.getByRole('button', { name: 'Criar conta e entrar' }).closest('form')?.contains(alert)).toBe(true);
  });

  it('lists the invitation facts in one block and leaves the one primary action to the form', async () => {
    const { container } = renderAt('/convite/abc', invitationFetch(false, json({}, 500)));
    await screen.findByLabelText('Nome');

    const details = container.querySelector('dl.auth-details')!;
    expect(details.textContent).toBe('AgênciaAgência UmConvite enviado pararafaela@example.test');
    expect([...container.querySelectorAll('.ui-button--primary')].map((element) => element.textContent)).toEqual(['Criar conta e entrar']);
  });
});

describe('the other auth screens in the new layout', () => {
  it('shows the password rule under the new-password field and links it to the control', async () => {
    renderAt('/senha/redefinir?token=abc');

    const input = await screen.findByLabelText('Nova senha');
    const hint = screen.getByText('Mínimo de 10 caracteres');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('announces the e-mail change as a status, with its icon, above the way back to the sign-in', async () => {
    const impl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/session')) return unauthenticated();
      if (url.endsWith('/email-change/confirm')) return json({});
      throw new Error(`unexpected ${url}`);
    };
    renderAt('/email/confirmar?token=abc', impl);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar troca de e-mail' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toBe('O novo e-mail já vale para a sua conta. Por segurança, todas as sessões foram encerradas.');
    expect(status.querySelector('svg')).not.toBeNull();
    expect(status.compareDocumentPosition(screen.getByRole('link', { name: 'Entrar com o novo e-mail' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

interface CredentialField {
  readonly label: string;
  readonly type: string;
  readonly autocomplete: string;
  readonly name: string;
}

/** What the browser and the password manager read: a redesign swaps the markup, and none of this shows on the screen. */
const expectCredentialField = (field: CredentialField): void => {
  const control = screen.getByLabelText(field.label) as HTMLInputElement;
  expect({ type: control.type, autocomplete: control.getAttribute('autocomplete'), name: control.getAttribute('name') })
    .toEqual({ type: field.type, autocomplete: field.autocomplete, name: field.name });
};

describe('the credential fields of the auth screens', () => {
  it.each<[string, string, readonly CredentialField[]]>([
    ['login', '/entrar', [
      { label: 'E-mail', type: 'email', autocomplete: 'email', name: 'email' },
      { label: 'Senha', type: 'password', autocomplete: 'current-password', name: 'password' }
    ]],
    ['forgot password', '/senha/esquecida', [
      { label: 'E-mail', type: 'email', autocomplete: 'email', name: 'email' }
    ]],
    ['reset password', '/senha/redefinir?token=abc', [
      { label: 'Nova senha', type: 'password', autocomplete: 'new-password', name: 'newPassword' }
    ]]
  ])('fixes type, autocomplete and name on %s', async (_screen, path, fields) => {
    renderAt(path);
    await screen.findByLabelText(fields[0]!.label);

    for (const field of fields) expectCredentialField(field);
  });

  it('fixes type, autocomplete and name on the invitation of a new account', async () => {
    renderAt('/convite/abc', invitationFetch(false, json({}, 500)));
    await screen.findByLabelText('Nome');

    expectCredentialField({ label: 'Nome', type: 'text', autocomplete: 'name', name: 'name' });
    expectCredentialField({ label: 'Senha', type: 'password', autocomplete: 'new-password', name: 'password' });
  });

  it('opens the legal documents of the invitation in a new tab without handing over the referrer', async () => {
    renderAt('/convite/abc', invitationFetch(false, json({}, 500)));
    await screen.findByLabelText('Nome');

    for (const [name, href] of [['Termos de Uso', '/termos'], ['Política de Privacidade', '/privacidade']] as const) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('href')).toBe(href);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noreferrer');
    }
  });
});

describe('the credential fields of the e-mail change request', () => {
  const descriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
  beforeAll(() => {
    // jsdom has no top layer; these stubs only model opening and closing.
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  });
  afterAll(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
      else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    }
  });

  it('fixes type, autocomplete and name on the new e-mail and the current password', () => {
    const client = new HttpClient('http://127.0.0.1:3001', visitorFetch());
    render(<ApiClientProvider client={client}><EmailChangeDialog onClose={() => undefined} /></ApiClientProvider>);

    expectCredentialField({ label: 'Novo e-mail', type: 'email', autocomplete: 'email', name: 'newEmail' });
    expectCredentialField({ label: 'Senha atual', type: 'password', autocomplete: 'current-password', name: 'currentPassword' });
  });
});
