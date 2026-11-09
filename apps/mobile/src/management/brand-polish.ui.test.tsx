// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
const mode = vi.hoisted(() => ({ demo: false }));
vi.mock('../demo/config', () => ({ get demoWorkspaceEnabled() { return mode.demo; } }));
const approvalRequest = vi.hoisted(() => vi.fn());
vi.mock('../api/approval', () => ({ createApprovalClient: () => ({ request: approvalRequest, clear: async () => {} }) }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
vi.mock('../product/StateSwap', () => import('../product/StateSwap.web'));
vi.mock('../product/Disclosure', () => import('../product/Disclosure.web'));
import { BrandStudy } from './BrandStudy';

const animations = vi.fn(() => ({ cancel: vi.fn(), playState: 'finished' }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  request.mockReset(); animations.mockClear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animations });
});


it('previews colors, validates exact hex and persists the server palette without changing other sections',async()=>{
 const study={filled:1,sections:[{key:'colors',body:null,archetype:null,colors:[{name:'Primária',hex:'#4F46E5'}]}],personas:[]};
 request.mockResolvedValue(study);
 render(<BrandStudy root="/agencies/one/clients/two" canEdit />);
 expect(await screen.findByLabelText('Amostra Primária: #4F46E5')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Editar Cores'}));
 fireEvent.click(screen.getByRole('button',{name:'Escolher amostras da cor 1'}));
 fireEvent.click(screen.getByRole('radio',{name:'Selecionar #14B8A6 na cor 1'}));
 expect((screen.getByRole('textbox',{name:'Hexadecimal da cor 1'}) as HTMLInputElement).value).toBe('#14B8A6');
 expect(screen.getByLabelText('Amostra Primária: #14B8A6')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Salvar seção'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith('/agencies/one/clients/two/brand-study/sections/colors',{method:'PUT',body:{colors:[{name:'Primária',hex:'#14B8A6'}]}}));
});
it('retains old prose, offers structured guidance and cancels without a write',async()=>{
 request.mockResolvedValue({filled:1,sections:[{key:'tone_of_voice',body:'Texto existente',archetype:null,colors:null}],personas:[]});
 render(<BrandStudy root="/clients/two" canEdit />);
 fireEvent.click(await screen.findByRole('button',{name:'Editar Tom de voz'}));
 expect((screen.getByRole('textbox',{name:'Tom de voz'}) as HTMLTextAreaElement).value).toBe('Texto existente');
 fireEvent.change(screen.getByRole('textbox',{name:'O que evitar'}),{target:{value:'Promessas sem comprovação'}});
 fireEvent.click(screen.getByRole('button',{name:'Cancelar edição'}));
 expect(request.mock.calls.every(([,options])=>!options.method)).toBe(true);
});
it('shows the portal palette without editing controls',async()=>{
 request.mockResolvedValue({filled:1,sections:[{key:'colors',body:null,archetype:null,colors:[{name:'Fundo',hex:'#FFFFFF'}]}],personas:[]});
 render(<BrandStudy root="/clients/two" canEdit={false} agency={false} />);
 expect(await screen.findByLabelText('Amostra Fundo: #FFFFFF')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Editar Cores'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Adicionar cor'})).toBeNull();
});
