// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sendContentNotification } from './notifications';

const register = vi.fn();
const show = vi.fn();
const permission = vi.fn();
beforeEach(() => {
  register.mockReset(); show.mockReset(); permission.mockReset();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: permission });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('asks on demand and only reports delivery after showNotification succeeds', async () => {
  permission.mockResolvedValue('granted');
  register.mockResolvedValue({ active: {}, showNotification: show });
  expect(permission).not.toHaveBeenCalled();
  expect(await sendContentNotification(3)).toBe('sent');
  expect(permission).toHaveBeenCalledTimes(1);
  expect(register).toHaveBeenCalledWith('/app-mobile/content-notifications.js', { scope: '/app-mobile/' });
  expect(show).toHaveBeenCalledWith('Ageniza · atividades do fluxo', expect.objectContaining({ tag: 'ageniza-content-activity' }));
});
it('never registers or claims success after permission was denied', async () => {
  vi.stubGlobal('Notification', { permission: 'denied', requestPermission: permission });
  expect(await sendContentNotification(3)).toBe('denied');
  expect(permission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled();
});
it('handles unavailable browsers and failed delivery without false success', async () => {
  vi.stubGlobal('Notification', undefined);
  expect(await sendContentNotification(3)).toBe('unsupported');
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: permission });
  register.mockResolvedValue({ active: {}, showNotification: vi.fn().mockRejectedValue(new Error('delivery failed')) });
  await expect(sendContentNotification(3)).rejects.toThrow('delivery failed');
});
it('bounds activation time and removes its event listener on failure', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Notification', { permission: 'granted' });
  const remove = vi.fn();
  register.mockResolvedValue({ installing: { state: 'installing', addEventListener: vi.fn(), removeEventListener: remove }, showNotification: show });
  const result = expect(sendContentNotification(3)).rejects.toThrow('A ativação demorou.');
  await vi.advanceTimersByTimeAsync(15_000); await result;
  expect(remove).toHaveBeenCalledWith('statechange', expect.any(Function));
  expect(show).not.toHaveBeenCalled();
});

it('does not leave the application busy forever when the permission prompt is unanswered', async () => {
  vi.useFakeTimers();
  permission.mockReturnValue(new Promise(() => {}));
  const result = expect(sendContentNotification(3)).rejects.toThrow('A permissão está pendente no navegador.');
  await vi.advanceTimersByTimeAsync(15_000); await result;
  expect(register).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled();
});
