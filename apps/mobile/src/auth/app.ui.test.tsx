// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
const state = vi.hoisted(() => ({ request: vi.fn(), clearSession: vi.fn(), access: () => {}, expired: () => {}, initialUrl: null as string | null }));
vi.mock('../api/runtime', () => ({ api: { request: state.request, clearSession: state.clearSession, onExpired: (fn: () => void) => { state.expired = fn; }, onAccessRequired: (fn: () => void) => { state.access = fn; } }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => ({ ...Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'ActivityIndicator'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))), AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, Linking: { getInitialURL: async () => state.initialUrl, addEventListener: () => ({ remove() {} }) } }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>, SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('expo-font', () => ({ useFonts: () => [true, null] }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('../../assets/fonts/Sora-SemiBold.ttf', () => ({ default: '' }));
vi.mock('../../assets/fonts/Inter-Regular.ttf', () => ({ default: '' }));
vi.mock('../../assets/fonts/Inter-SemiBold.ttf', () => ({ default: '' }));
vi.mock('../auth/EntryScreen', () => ({ Login: ({ onLogin }: { onLogin(): void }) => <button onClick={onLogin}>Login form</button>, EntryScreen: ({ entry }: { entry: { kind: string } }) => <p>Entry {entry.kind}</p> }));
vi.mock('../product/MobileApp', () => ({ MobileApp: ({ onExit }: { onExit(): void }) => <button onClick={onExit}>Sair workspace</button> }));
vi.mock('../auth/ApprovalScreen', () => ({ ApprovalScreen: () => <p>Approval screen</p> }));
vi.mock('../auth/AccountAction', () => ({ AccountAction: () => <p>Account action</p> }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
import App from '../../App';
import { act } from '@testing-library/react';
const context = { type: 'agency', agencyId: 'one', agencyName: 'Agência', isOwner: true, roleKey: 'admin', roleName: 'Admin' };
function activeResponses() {
  state.request.mockImplementation(async (path: string) => path === '/auth/session' ? { emailVerified: true } : path === '/me/legal-acceptances' ? { required: false, documents: [] } : path === '/me/contexts/resolve' ? { decision: 'enter', context } : {});
}
beforeEach(() => { state.initialUrl = null; window.history.replaceState(null, '', '/'); state.request.mockReset(); state.clearSession.mockReset().mockResolvedValue(undefined); Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }); });
afterEach(cleanup);
describe('App session wiring', () => {
  it('clears local access when logout fails on the network', async () => {
    activeResponses(); render(<App />);
    const exit = await screen.findByRole('button', { name: 'Sair workspace' });
    state.request.mockImplementation(async () => { throw new Error('offline'); });
    fireEvent.click(exit);
    expect(await screen.findByRole('button', { name: 'Login form' })).toBeTruthy();
    expect(state.clearSession).toHaveBeenCalledOnce();
  });
  it('offers restoration retry instead of replacing a valid session with login', async () => {
    state.request.mockRejectedValue(new Error('temporary outage')); render(<App />);
    expect(await screen.findByText('temporary outage')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Login form' })).toBeNull();
    activeResponses(); fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: 'Sair workspace' })).toBeTruthy();
  });
  it('leaves the active workspace and resolves pending terms after an access-policy event', async () => {
    activeResponses(); render(<App />); await screen.findByRole('button', { name: 'Sair workspace' });
    state.request.mockImplementation(async (path: string) => path === '/auth/session' ? { emailVerified: true } : { required: true, documents: [{ pending: true }] });
    act(() => state.access());
    await waitFor(() => expect(screen.getByText('Entry legal')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Sair workspace' })).toBeNull();
  });
});


it('opens the mobile verification action and removes its token before confirmation', async () => {
  state.initialUrl = 'https://dev.ageniza.com.br/app-mobile/?action=verify&token=mail-token';
  window.history.replaceState(null, '', '/app-mobile/?action=verify&token=mail-token');
  state.request.mockRejectedValue(new Error('not signed in'));
  render(<App />);
  expect(await screen.findByText('Account action')).toBeTruthy();
  expect(window.location.pathname).toBe('/app-mobile/');
  expect(window.location.search).toBe('');
  expect(state.request.mock.calls.some(([path]) => path === '/auth/email/verify')).toBe(false);
});
