// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
const pick = vi.hoisted(() => vi.fn());
vi.mock('expo-document-picker', () => ({ getDocumentAsync: pick }));
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
import { SubscriptionScreen } from './SubscriptionScreen';
const context = { type: 'agency' as const, agencyId: 'agency-one', agencyName: 'Demo', isOwner: true, roleKey: 'owner', roleName: 'Owner' };
let provider: 'simulado' | null;
let outcome: 'confirmed' | 'declined';
beforeEach(() => {
  request.mockReset(); provider = 'simulado'; outcome = 'confirmed';
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  request.mockImplementation(async (path: string) => {
    if (path.endsWith('/me')) return { plan: { kind: 'trial', readOnly: false } };
    if (path.endsWith('/plans')) return { plans: [{ key: 'essencial', name: 'Essencial', monthlyCents: 9700, clientLimit: 10, storageBytes: 20 * 1024 ** 3 }] };
    if (path.endsWith('/quote')) return { amountCents: 9700, monthlyCents: 9700, effect: 'subscribe', effectiveAt: '2026-11-05T12:00:00Z' };
    if (path.endsWith('/charges')) return { chargeId: 'charge-one', amountCents: 9700, monthlyCents: 9700, effect: 'subscribe', effectiveAt: '2026-11-05T12:00:00Z' };
    if (path.endsWith('/simulated-payment')) return { status: outcome };
    return { subscription: null, paymentProvider: provider };
  });
});
afterEach(cleanup);
async function quote() {
  render(<SubscriptionScreen context={context} />);
  await screen.findByRole('button', { name: 'Plano desejado' });
  fireEvent.click(screen.getByRole('button', { name: 'Plano desejado' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Selecionar Essencial' }));
  fireEvent.click(screen.getByRole('button', { name: 'Calcular alteração sem cobrar' }));
  await screen.findByText('Confira antes de confirmar');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar alteração no ambiente simulado' }).getAttribute('aria-disabled')).not.toBe('true'));
}
describe('server-backed simulated billing', () => {
  it('quotes, explicitly requests one charge and confirms only the server response', async () => {
    await quote();
    expect(request.mock.calls.some(([path]) => String(path).endsWith('/charges'))).toBe(false);
    const confirm = screen.getByRole('button', { name: 'Confirmar alteração no ambiente simulado' });
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    await screen.findByText('Pagamento simulado pendente');
    expect(request.mock.calls.filter(([path]) => String(path).endsWith('/charges'))).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('/agencies/agency-one/subscription/charges', { method: 'POST', body: { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Simular pagamento aprovado na API' }).getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Simular pagamento aprovado na API' }));
    await screen.findByText('Pagamento simulado confirmado pelo servidor.');
    expect(request).toHaveBeenCalledWith('/agencies/agency-one/subscription/charges/charge-one/simulated-payment', { method: 'POST', body: { outcome: 'approved' } });
  });
  it('does not report confirmation when the server declines an approval attempt', async () => {
    outcome = 'declined'; await quote();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar alteração no ambiente simulado' }));
    await screen.findByText('Pagamento simulado pendente');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Simular pagamento aprovado na API' }).getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Simular pagamento aprovado na API' }));
    await screen.findByText('O servidor não confirmou o pagamento. O plano não foi ativado.');
    expect(screen.queryByText('Pagamento simulado confirmado pelo servidor.')).toBeNull();
    expect(screen.getByText('Pagamento simulado pendente')).toBeTruthy();
  });
  it('does not expose a charge action when the backend has no simulated provider', async () => {
    provider = null; render(<SubscriptionScreen context={context} />);
    await screen.findByText('Pagamento no aplicativo ainda não liberado');
    expect(screen.queryByRole('button', { name: 'Confirmar alteração no ambiente simulado' })).toBeNull();
  });
});
