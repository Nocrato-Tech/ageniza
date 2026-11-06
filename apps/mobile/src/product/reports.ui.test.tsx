// @vitest-environment jsdom
// Reports screen (issue #837): honest day bands for the month, client/period scope, CSV equal to the screen, empty state.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { dayBands } from '../contents/period';
const request = vi.hoisted(() => vi.fn());
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking', 'RefreshControl', 'BackHandler', 'Share'].map(async (name) => [name, name === 'BackHandler' ? { addEventListener: () => ({ remove() {} }) } : name === 'Share' ? { share: async () => ({}) } : (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
vi.mock('../demo/config', () => ({ demoWorkspaceEnabled: false, demoAgencyName: 'Agência Horizonte · Demonstração' }));
vi.mock('../demo/DemoWorkspace', () => ({ DemoWorkspace: () => null }));
vi.mock('../demo/WebNotifications', () => ({ WebNotifications: () => null }));
vi.mock('../demo/ContentLearning', () => ({ ContentLearning: () => null }));
const repository = vi.hoisted(() => ({ demo: false, load: vi.fn(), detail: vi.fn(), library: vi.fn(), thumbnail: vi.fn() }));
vi.mock('./remote', () => ({ remoteRepository: () => repository }));
import { MobileApp } from './MobileApp';
import type { Data, Post } from './types';

const post = (id: string, clientId: string, date: string, status: Post['status'] = 'in_production'): Post => ({ id, clientId, title: `Conteúdo ${id}`, caption: '', format: 'image', status, date, time: '10:00', ownerId: 'm1', folderId: '', mediaIds: [], coverId: null, revision: 1, tasks: [], comments: [] });
const dataWith = (posts: Post[]): Data => ({ version: 2, clients: [{ id: 'c1', name: 'Marca Um', handle: '' }, { id: 'c2', name: 'Marca Dois', handle: '' }], people: [{ id: 'm1', name: 'Pessoa', job: '', role: 'Dono', email: 'p@example.test', self: true, owner: true }], posts, activities: [], profile: { name: 'Pessoa', agency: 'Agência' }, permissions: ['*'], readOnly: false, assets: [], folders: [] });
const context = { type: 'agency' as const, agencyId: 'one', agencyName: 'Agência', isOwner: true, roleKey: 'owner', roleName: 'Owner' };
const csv = { text: '', name: '' };
beforeEach(() => {
  request.mockReset().mockResolvedValue({}); csv.text = ''; csv.name = '';
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  URL.createObjectURL = ((blob: Blob) => { const reader = new FileReader(); reader.onload = () => { csv.text = String(reader.result); }; reader.readAsText(blob); return 'blob:test'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { csv.name = this.download; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function openReports(posts: Post[], today: string) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${today}T15:00:00Z`));
  repository.load.mockResolvedValue(dataWith(posts));
  render(<MobileApp context={context} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Mais' }));
  fireEvent.click(await screen.findByRole('button', { name: /Relatórios/ }));
  await screen.findByText('Resumo do mês a partir do planejamento.');
}
const bar = (label: string) => screen.getByText(label).parentElement!.textContent;

it('builds the day bands from the real last day of the month', () => {
  expect(dayBands(28).map((band) => band.label)).toEqual(['1–7', '8–14', '15–21', '22–28']);
  expect(dayBands(29).map((band) => band.label)).toEqual(['1–7', '8–14', '15–21', '22–28', '29']);
  expect(dayBands(30).at(-1)).toEqual({ from: 29, to: 30, label: '29–30' });
  expect(dayBands(31).at(-1)).toEqual({ from: 29, to: 31, label: '29–31' });
});
it('shows only four bands in a 28-day February and keeps day 28 in 22–28', async () => {
  await openReports([post('a', 'c1', '2026-02-28'), post('b', 'c1', '2026-02-01')], '2026-02-15');
  expect(screen.getByText('Produção no mês')).toBeTruthy();
  expect(bar('22–28')).toBe('122–28');
  expect(bar('1–7')).toBe('11–7');
  expect(screen.queryByText(/^29/)).toBeNull();
  expect(screen.queryByText(/Sem \d/)).toBeNull();
  expect(screen.getByText('Sem métricas do Instagram')).toBeTruthy();
});
it('shows a 29th-day band in a leap-year February', async () => {
  await openReports([post('a', 'c1', '2028-02-29'), post('b', 'c1', '2028-02-28')], '2028-02-10');
  expect(bar('29')).toBe('129');
  expect(bar('22–28')).toBe('122–28');
});
it('puts days 29 and 30 in the last band of a 30-day month', async () => {
  await openReports([post('a', 'c1', '2026-04-29'), post('b', 'c1', '2026-04-30'), post('c', 'c1', '2026-04-22')], '2026-04-10');
  expect(bar('29–30')).toBe('229–30');
  expect(bar('22–28')).toBe('122–28');
});
it('puts days 29, 30 and 31 in the last band of a 31-day month', async () => {
  await openReports([post('a', 'c1', '2026-03-29'), post('b', 'c1', '2026-03-30'), post('c', 'c1', '2026-03-31')], '2026-03-10');
  expect(bar('29–31')).toBe('329–31');
  expect(bar('22–28')).toBe('022–28');
});
it('filters by client and exports exactly the same posts, named after the period month', async () => {
  const posts = [post('a', 'c1', '2026-03-05', 'published'), post('b', 'c1', '2026-03-06', 'approved'), post('c', 'c2', '2026-03-07', 'published'), post('d', 'c1', '2026-04-01')];
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-03-15T15:00:00Z'));
  repository.load.mockResolvedValue(dataWith(posts));
  render(<MobileApp context={context} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Calendário' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Filtrar Marca Um' }));
  fireEvent.click(await screen.findByRole('tab', { name: 'Mais' }));
  fireEvent.click(await screen.findByRole('button', { name: /Relatórios/ }));
  await screen.findByText('Resumo do mês a partir do planejamento.');
  expect(within(screen.getByText('Conteúdos publicados').parentElement!).getByText('1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Exportar relatório CSV' }));
  await screen.findByText('Relatório exportado com os conteúdos do período.');
  await vi.waitFor(() => expect(csv.text).toContain('Conteúdo b'));
  expect(csv.name).toBe('ageniza-2026-03.csv');
  expect(csv.text.split('\n')).toHaveLength(3);
  expect(csv.text).toContain('Conteúdo a');
  expect(csv.text).not.toContain('Conteúdo c');
  expect(csv.text).not.toContain('Conteúdo d');
});
it('counts every client when no client is selected', async () => {
  await openReports([post('a', 'c1', '2026-03-05', 'published'), post('c', 'c2', '2026-03-07', 'published')], '2026-03-15');
  expect(within(screen.getByText('Conteúdos publicados').parentElement!).getByText('2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Exportar relatório CSV' }));
  await vi.waitFor(() => expect(csv.text.split('\n')).toHaveLength(3));
});
it('shows an empty text and a disabled CSV button when the period has no content', async () => {
  await openReports([post('d', 'c1', '2026-04-01')], '2026-03-15');
  expect(screen.getByText('Nenhum conteúdo neste período')).toBeTruthy();
  expect(screen.getByText('Não há conteúdos planejados neste mês para esta seleção.')).toBeTruthy();
  expect(screen.queryByText('Produção no mês')).toBeNull();
  expect((screen.getByRole('button', { name: 'Exportar relatório CSV' }) as HTMLButtonElement).disabled || screen.getByRole('button', { name: 'Exportar relatório CSV' }).getAttribute('aria-disabled') === 'true').toBe(true);
});
