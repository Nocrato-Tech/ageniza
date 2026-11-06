// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
const pick = vi.hoisted(() => vi.fn());
const videoSource = vi.hoisted(() => vi.fn());
vi.mock('expo-document-picker', () => ({ getDocumentAsync: pick }));
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: (uri: string) => { videoSource(uri); return { addListener: () => ({ remove() {} }) }; } }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
import { ContentEditor } from './ContentEditor';
import type { Data, Repository } from './types';
afterEach(cleanup);
it('keeps the editor in its upload scope and prevents switching steps until upload settles', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  const clientId='c1'; const folderId='f1'; const data: Data={version:2,clients:[{id:clientId,name:'Marca',handle:''}],people:[],posts:[],activities:[],profile:{name:'P',agency:'A'},permissions:[],readOnly:false,assets:[],folders:[{id:folderId,clientId,name:'Pasta'}]};
  let finish: (value: unknown) => void = () => {}; const pending=new Promise((resolve)=>{finish=resolve;});
  const upload=vi.fn(async()=>await pending);const repository={library:async()=>({folders:data.folders,assets:[]}),upload} as unknown as Repository;
  pick.mockResolvedValue({canceled:false,assets:[{uri:'blob:chosen',name:'chosen.png',mimeType:'image/png',size:3}]});
  const view=render(<ContentEditor data={data} repository={repository} clientId={clientId} busy={false} onSave={async()=>{}} onError={()=>{}} onRefresh={async()=>{}}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Título interno *'}),{target:{value:'Upload scope test'}});
  await waitFor(()=>expect(screen.queryByText('Carregando biblioteca…')).toBeNull());
  await waitFor(()=>expect(screen.getByRole('button',{name:'Continuar para conteúdo'}).getAttribute('aria-busy')).toBe('false'));
  fireEvent.click(screen.getByRole('button',{name:'Continuar para conteúdo'}));
  fireEvent.click(await screen.findByRole('button',{name:'Enviar imagem ou vídeo'}));
  await waitFor(()=>expect(upload).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button',{name:'Voltar uma etapa'}).getAttribute('aria-disabled')).toBe('true');
  view.unmount();
  render(<ContentEditor data={{...data,clients:[{id:'c2',name:'Outra marca',handle:''}],folders:[{id:'f2',clientId:'c2',name:'Outra pasta'}]}} repository={repository} clientId="c2" busy={false} onSave={async()=>{}} onError={()=>{}} onRefresh={async()=>{}}/>);
  finish({id:'old',clientId,folderId,name:'chosen.png',kind:'image',size:3});
  await waitFor(()=>expect(screen.queryByText('chosen.png')).toBeNull());
});
