// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sendPresentationNotification } from './notifications';

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
  expect(await sendPresentationNotification()).toBe('sent');
  expect(permission).toHaveBeenCalledTimes(1);
  expect(register).toHaveBeenCalledWith('/presentation-notifications.js', { scope: '/apresentacao/' });
  expect(show).toHaveBeenCalledWith('Ageniza · aprovação pendente', expect.objectContaining({ tag: 'ageniza-academic-demo' }));
});
it('never registers or claims success after permission was denied', async () => {
  vi.stubGlobal('Notification', { permission: 'denied', requestPermission: permission });
  expect(await sendPresentationNotification()).toBe('denied');
  expect(permission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled();
});
it('handles unavailable browsers and failed delivery without false success', async () => {
  vi.stubGlobal('Notification', undefined);
  expect(await sendPresentationNotification()).toBe('unsupported');
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: permission });
  register.mockResolvedValue({ active: {}, showNotification: vi.fn().mockRejectedValue(new Error('delivery failed')) });
  await expect(sendPresentationNotification()).rejects.toThrow('delivery failed');
});
it('bounds activation time and removes its event listener on failure', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Notification', { permission: 'granted' });
  const remove = vi.fn();
  register.mockResolvedValue({ installing: { state: 'installing', addEventListener: vi.fn(), removeEventListener: remove }, showNotification: show });
  const result = expect(sendPresentationNotification()).rejects.toThrow('A ativação demorou.');
  await vi.advanceTimersByTimeAsync(15_000); await result;
  expect(remove).toHaveBeenCalledWith('statechange', expect.any(Function));
  expect(show).not.toHaveBeenCalled();
});
