// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiClientProvider, HttpClient } from '../http.js';
import { LiveApiPanel } from './live-api.js';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('waits for a click and displays the actual GET response from the configured API without credentials', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  render(<ApiClientProvider client={new HttpClient('https://dev.ageniza.com.br/api')}><LiveApiPanel /></ApiClientProvider>);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name:'Executar GET /health'}));
  await screen.findByText('HTTP 200');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('https://dev.ageniza.com.br/api/health');
  expect(fetcher.mock.calls[0][1]).toMatchObject({method:'GET',credentials:'omit',cache:'no-store',redirect:'error'});
  expect(screen.getByLabelText('Resposta real da API').textContent).toContain('"status": "ok"');
  expect(screen.getByText(/Recebida do servidor/)).toBeTruthy();
});
it('shows the server failure as HTTP 503 and never substitutes a successful example', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"status":"unavailable"}', { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  render(<ApiClientProvider client={new HttpClient('https://dev.ageniza.com.br/api')}><LiveApiPanel /></ApiClientProvider>);
  fireEvent.click(screen.getByRole('button', {name:'Executar GET /ready'}));
  await screen.findByText('HTTP 503');
  expect(screen.queryByText('HTTP 200')).toBeNull();
  expect(screen.getByLabelText('Resposta real da API').textContent).toContain('unavailable');
  expect(fetcher.mock.calls[0][0]).toBe('https://dev.ageniza.com.br/api/ready');
});
it('blocks overlapping clicks and aborts the request when the panel closes', () => {
  const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const view=render(<ApiClientProvider client={new HttpClient('https://dev.ageniza.com.br/api')}><LiveApiPanel /></ApiClientProvider>);
  const button=screen.getByRole('button', {name:'Executar GET /health'});
  fireEvent.click(button); fireEvent.click(button);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button', {name:'Executar GET /ready'}) as HTMLButtonElement).disabled).toBe(true);
  const signal=fetcher.mock.calls[0][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});
it('clears stale success on network failure and retries the real request', async () => {
  const fetcher=vi.fn().mockResolvedValueOnce(new Response('{"status":"ok"}', {status:200})).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('{"google":false}', {status:200}));
  vi.stubGlobal('fetch',fetcher);
  render(<ApiClientProvider client={new HttpClient('https://dev.ageniza.com.br/api')}><LiveApiPanel /></ApiClientProvider>);
  fireEvent.click(screen.getByRole('button',{name:'Executar GET /health'}));
  await screen.findByText('HTTP 200');
  fireEvent.click(screen.getByRole('button',{name:'Executar GET /auth/providers'}));
  await screen.findByRole('alert');
  expect(screen.queryByText('HTTP 200')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Executar GET /auth/providers'}));
  await screen.findByText('HTTP 200');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2][0]).toBe('https://dev.ageniza.com.br/api/auth/providers');
  expect(screen.getByLabelText('Resposta real da API').textContent).toContain('"google": false');
});
