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
import { Login } from './EntryScreen';
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
