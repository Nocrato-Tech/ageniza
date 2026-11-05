// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const notify = vi.hoisted(() => vi.fn());
vi.mock('./notifications', () => ({ sendPresentationNotification: notify }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'ActivityIndicator', 'Linking'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>, SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('expo-font', () => ({ useFonts: () => [true, null] }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('../../assets/fonts/Sora-SemiBold.ttf', () => ({ default: '' }));
vi.mock('../../assets/fonts/Inter-Regular.ttf', () => ({ default: '' }));
vi.mock('../../assets/fonts/Inter-SemiBold.ttf', () => ({ default: '' }));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('../../App', () => ({ default: () => <p>Authenticated application</p> }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
import PresentationApp from './PresentationApp';
import WebRoot from '../root.web';

beforeEach(() => {
  notify.mockReset();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('academic web presentation', () => {
  it('identifies fictional data and recalculates risk through the actual model controls', () => {
    render(<PresentationApp />);
    expect(screen.getByText('Ambiente demonstrativo')).toBeTruthy();
    expect(screen.getByText('Risco elevado de atraso')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Testar cenário organizado' }));
    expect(screen.getByText('Risco reduzido de atraso')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver vizinhos do modelo' }));
    expect(screen.getAllByText(/Exemplo #/)).toHaveLength(5);
    expect(notify).not.toHaveBeenCalled();
  });
  it('keeps billing across tabs, prevents double payment and requires cancellation confirmation', async () => {
    vi.useFakeTimers();
    render(<PresentationApp />);
    fireEvent.click(screen.getByRole('tab', { name: 'Planos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Escolher Profissional' }));
    const confirm = screen.getByRole('button', { name: 'Simular pagamento aprovado' });
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getAllByText('DEMO-0001 · Aprovado')).toHaveLength(1);
    expect(screen.queryByText(/DEMO-0002/)).toBeNull();
    expect(screen.getByText('Plano atual: Profissional')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Avisos web' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Planos' }));
    expect(screen.getByText('Plano atual: Profissional')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar assinatura simulada' }));
    expect(screen.getByText('Assinatura demonstrativa ativa.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar cancelamento simulado' }));
    expect(screen.getByText('Cancelamento simulado agendado para o fim do ciclo.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reativar assinatura simulada' }));
    expect(screen.getByText('Assinatura demonstrativa ativa.')).toBeTruthy();
  });
  it('reports a declined payment without activating the selected plan', async () => {
    vi.useFakeTimers(); render(<PresentationApp />);
    fireEvent.click(screen.getByRole('tab', { name: 'Planos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Escolher Agência' }));
    fireEvent.click(screen.getByRole('button', { name: 'Simular pagamento recusado' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByText('DEMO-0001 · Recusado')).toBeTruthy();
    expect(screen.getByText('Nenhum plano simulado ativo')).toBeTruthy();
  });
  it('requests no notification on entry and renders permission refusal honestly', async () => {
    notify.mockResolvedValue('denied'); render(<PresentationApp />);
    fireEvent.click(screen.getByRole('tab', { name: 'Avisos web' }));
    expect(notify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar notificação de teste' }));
    expect(await screen.findByText(/Permissão não concedida/)).toBeTruthy();
    expect(screen.queryByText('Notificação enviada ao navegador.')).toBeNull();
  });
  it('keeps ordinary web routes in the real app and only enables the presentation explicitly', async () => {
    window.history.replaceState({}, '', '/apresentacao/');
    vi.stubEnv('EXPO_PUBLIC_PRESENTATION_FEATURES', 'false');
    const mounted = render(<WebRoot />);
    expect(screen.getByText('Authenticated application')).toBeTruthy();
    vi.stubEnv('EXPO_PUBLIC_PRESENTATION_FEATURES', 'true');
    mounted.rerender(<WebRoot />);
    expect(await screen.findByText('Ambiente demonstrativo')).toBeTruthy();
    expect(screen.queryByText('Authenticated application')).toBeNull();
  });
});
