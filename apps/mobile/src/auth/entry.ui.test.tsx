// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
const mode = vi.hoisted(() => ({ demo: false }));
vi.mock('../demo/config', () => ({ get demoWorkspaceEnabled() { return mode.demo; } }));
const approvalRequest = vi.hoisted(() => vi.fn());
vi.mock('../api/approval', () => ({ createApprovalClient: () => ({ request: approvalRequest, clear: async () => {} }) }));
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
import { EntryScreen, Login } from './EntryScreen';
import { AccountAction } from './AccountAction';
import { ApprovalScreen } from './ApprovalScreen';

beforeEach(() => {
  request.mockReset(); approvalRequest.mockReset(); mode.demo = false;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(cleanup);
const enter = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('native account forms rendered through React Native Web', () => {
  it('keeps sign-in as the entry and offers no demonstration entry', () => {
    render(<Login onLogin={async () => {}} onLink={() => {}} />);
    expect(screen.getByText('Entre no seu fluxo.')).toBeTruthy();
    expect(screen.getByLabelText('Senha').getAttribute('type')).toBe('password');
    expect(screen.getByLabelText('Senha').getAttribute('autocomplete')).toBe('current-password');
    expect(screen.queryByRole('button', { name: /demonstração/i })).toBeNull();
  });
  it('does not submit registration without consent, then sends exactly the approved contract', async () => {
    request.mockResolvedValue(undefined);
    render(<Login onLogin={async () => {}} onLink={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }));
    enter('Seu nome', 'Marcos Martins'); enter('E-mail', 'marcos@example.test'); enter('Senha', 'a-long-test-password'); enter('Confirme a senha', 'a-long-test-password');
    expect(screen.getByLabelText('Senha').getAttribute('autocomplete')).toBe('new-password');
    fireEvent.click(screen.getByRole('button', { name: 'Criar minha conta' }));
    await screen.findByText(/aceite os documentos/);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar minha conta' }));
    await screen.findByText('Confira seu e-mail');
    expect(request).toHaveBeenCalledWith('/auth/sign-up', { method: 'POST', body: { name: 'Marcos Martins', email: 'marcos@example.test', password: 'a-long-test-password', acceptTerms: true } });
  });
  it('preserves a failed reset form, and does not submit twice in one event batch', async () => {
    let reject: (cause: Error) => void = () => {};
    request.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    render(<AccountAction link={{ kind: 'reset', token: 'opaque' }} onDone={async () => {}} onClose={() => {}} />);
    enter('Nova senha', 'a-long-test-password'); enter('Confirme a senha', 'a-long-test-password');
    const submit = screen.getByRole('button', { name: 'Confirmar e continuar' });
    act(() => { fireEvent.click(submit); fireEvent.click(submit); });
    expect(request).toHaveBeenCalledTimes(1);
    reject(new Error('Falha de conexão.'));
    await screen.findByText('Falha de conexão.');
    expect((screen.getByLabelText('Nova senha') as HTMLInputElement).value).toBe('a-long-test-password');
  });
  it('does not reuse a verification token after success if context loading fails', async () => {
    request.mockResolvedValue({ user: { email: 'person@example.test' } });
    const onDone = vi.fn().mockRejectedValueOnce(new Error('Sem conexão.')).mockResolvedValueOnce(undefined);
    render(<AccountAction link={{ kind: 'verify', token: 'opaque' }} onDone={onDone} onClose={() => {}} />);
    enter('Senha da sua conta', 'existing-password');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e continuar' }));
    await screen.findByText('Ação concluída');
    fireEvent.click(screen.getByRole('button', { name: 'Continuar para meus acessos' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenCalledTimes(1);
  });
});


describe('email approval actions', () => {
  it('opens the batch without deciding, respects canDecide and approves only the selected revision', async () => {
    const content = { id: 'content-two', title: 'Segundo post', publishOn: '2026-11-03', format: 'image', status: 'awaiting_approval', caption: 'Legenda real', media: [], revision: 4, coverAssetId: null, canDecide: true };
    approvalRequest.mockImplementation(async (path: string) => path.endsWith('/batch') ? { clientName: 'Cliente real', agencyName: 'Agência real', contents: [{ ...content, id: 'content-one', title: 'Primeiro post', status: 'approved', canDecide: false }, content] } : path.endsWith('/approve') ? { ...content, status: 'approved', canDecide: false } : {});
    render(<ApprovalScreen token={'a'.repeat(43)} onClose={() => {}} />);
    const approve = await screen.findByRole('button', { name: 'Aprovar Segundo post' });
    expect(screen.queryByRole('button', { name: 'Aprovar Primeiro post' })).toBeNull();
    expect(approvalRequest.mock.calls.every(([path]) => !String(path).endsWith('/approve'))).toBe(true);
    fireEvent.click(approve);
    await screen.findByText('Aprovação registrada.');
    expect(approvalRequest).toHaveBeenCalledWith('/portal-approval/contents/content-two/approve', { method: 'POST', body: { revision: 4 } });
    expect(screen.queryByRole('button', { name: 'Aprovar Segundo post' })).toBeNull();
  });
});

async function sendResend() {
  request.mockResolvedValue(undefined);
  render(<Login onLogin={async () => {}} onLink={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar confirmação do e-mail' }));
  enter('E-mail', 'tester@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Enviar e-mail' }));
  expect(await screen.findByText('Confira seu e-mail')).toBeTruthy();
  expect(screen.getByText(/Confira também o spam/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Já tenho o link' })).toBeTruthy();
  expect(request).toHaveBeenCalledWith('/auth/email/verification/resend', { method: 'POST', body: { email: 'tester@example.test' } });
}

it('shows the normal check-your-email text outside demo builds, with no test inbox button', async () => {
  await sendResend();
  expect(screen.queryByText(/caixa de testes/i)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Caixa de testes da equipe' })).toBeNull();
});

it('shows the same real-email text in demo builds, plus only a discreet team test inbox button', async () => {
  mode.demo = true;
  await sendResend();
  expect(screen.getByRole('button', { name: 'Caixa de testes da equipe' })).toBeTruthy();
  expect(screen.queryByText(/A caixa exige acesso autorizado/)).toBeNull();
});

describe('entry without an agency', () => {
  it('explains a 409 TRIAL_ALREADY_EXISTS when creating the agency', async () => {
    const { ApiError } = await import('../api/client');
    request.mockRejectedValue(new ApiError(409, 'TRIAL_ALREADY_EXISTS', 'conflict'));
    render(<EntryScreen entry={{ kind: 'empty' }} busy={false} onSelect={() => {}} onContinue={async () => {}} onLink={() => {}} />);
    enter('Nome da agência', 'Minha agência');
    fireEvent.click(screen.getByRole('button', { name: 'Criar agência e começar' }));
    expect(await screen.findByText(/Sua conta já tem uma agência em período de teste\. Entre com a conta dona dessa agência ou peça um convite\./)).toBeTruthy();
  });
  it('hides agency creation and the demo when the account cannot create one', () => {
    mode.demo = true;
    render(<EntryScreen entry={{ kind: 'empty', canCreateAgency: false }} busy={false} onSelect={() => {}} onContinue={async () => {}} onLink={() => {}} />);
    expect(screen.getByText('Sua conta ainda não tem acesso a uma agência')).toBeTruthy();
    expect(screen.getByLabelText('Link do e-mail')).toBeTruthy();
    expect(screen.queryByLabelText('Nome da agência')).toBeNull();
    expect(screen.queryByRole('button', { name: /Criar agência/ })).toBeNull();
    expect(screen.queryByText(/demonstração/i)).toBeNull();
  });
  it('says so when refreshing finds nothing new', async () => {
    const entry = { kind: 'empty' as const, canCreateAgency: false };
    render(<EntryScreen entry={entry} busy={false} onSelect={() => {}} onContinue={async () => ({ ...entry })} onLink={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar meus acessos' }));
    expect(await screen.findByText('Nenhum acesso novo encontrado.')).toBeTruthy();
  });
});
it('reveals and conceals a password without changing its value or credential semantics', () => {
  render(<Login onLogin={async () => {}} onLink={() => {}} />);
  enter('Senha', 'keep this password');
  const input = screen.getByLabelText('Senha') as HTMLInputElement;
  input.focus(); input.setSelectionRange(3, 7);
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar Senha' }));
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(3);
  expect(input.selectionEnd).toBe(7);
  expect(input.type).toBe('text');
  expect(input.value).toBe('keep this password');
  expect(input.autocomplete).toBe('current-password');
  fireEvent.click(screen.getByRole('button', { name: 'Ocultar Senha' }));
  expect(input.type).toBe('password');
});

it('identifies the invalid sign-in field, focuses it and preserves valid values without calling the API', () => {
  render(<Login onLogin={async () => {}} onLink={() => {}} />);
  enter('E-mail', 'invalid'); enter('Senha', 'existing');
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(screen.getByText('Informe um e-mail válido.')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText('E-mail'));
  expect((screen.getByLabelText('Senha') as HTMLInputElement).value).toBe('existing');
  expect(request).not.toHaveBeenCalled();
  enter('E-mail', 'person@example.test');
  expect(screen.queryByText('Informe um e-mail válido.')).toBeNull();
});

it('shows the real new-password policy before submit and focuses mismatched confirmation', () => {
  render(<AccountAction link={{ kind: 'reset', token: 'opaque' }} onDone={async () => {}} onClose={() => {}} />);
  expect(screen.getByText('Use de 10 a 128 caracteres.')).toBeTruthy();
  enter('Nova senha', 'a-long-password'); enter('Confirme a senha', 'different-password');
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar e continuar' }));
  expect(screen.getByText('As senhas precisam ser iguais.')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText('Confirme a senha'));
  expect(request).not.toHaveBeenCalled();
});

it('presents an existing short password to the server without applying the new-password policy', async () => {
  request.mockRejectedValue(new Error('Credenciais inválidas.'));
  render(<Login onLogin={async () => {}} onLink={() => {}} />);
  enter('E-mail', 'person@example.test'); enter('Senha', 'short');
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  await screen.findByText('Credenciais inválidas.');
  expect(request).toHaveBeenCalledWith('/auth/login', { method: 'POST', body: { email: 'person@example.test', password: 'short' } });
  expect(screen.queryByText('Use de 10 a 128 caracteres.')).toBeNull();
});

it('communicates a verification resend as information instead of an error', async () => {
  request.mockResolvedValue(undefined);
  render(<EntryScreen entry={{ kind: 'unverified', email: 'person@example.test' }} busy={false} onSelect={() => {}} onContinue={async () => {}} onLink={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar confirmação' }));
  expect(await screen.findByText('Confira sua caixa de entrada')).toBeTruthy();
  expect(request).toHaveBeenCalledWith('/auth/email/verification/resend', { method: 'POST', body: { email: 'person@example.test' } });
});

it('conceals the next auth flow after revealing the password in another flow', () => {
  render(<Login onLogin={async () => {}} onLink={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar Senha' }));
  expect((screen.getByLabelText('Senha') as HTMLInputElement).type).toBe('text');
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }));
  expect((screen.getByLabelText('Senha') as HTMLInputElement).type).toBe('password');
});

it('associates the compact password toggle with its input and announces reveal state', () => {
  render(<Login onLogin={async () => {}} onLink={() => {}} />);
  const input = screen.getByLabelText('Senha');
  const toggle = screen.getByRole('button', { name: 'Mostrar Senha' });
  expect(input.id).not.toBe('');
  expect(toggle.getAttribute('aria-controls')).toBe(input.id);
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(toggle);
  expect(screen.getByRole('button', { name: 'Ocultar Senha' }).getAttribute('aria-pressed')).toBe('true');
});
