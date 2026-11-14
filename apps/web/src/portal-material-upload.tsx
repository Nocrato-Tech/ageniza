import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Mic } from 'lucide-react';

import type { MaterialRequest, PortalMaterialUpload, PortalMaterialUploadCategory } from '@ageniza/contracts';
import { Button, LiveStatus, Modal, ProgressBar } from '@ageniza/ui';

import { MATERIAL_REQUEST_LABEL } from './conversation.js';
import { useApiClient } from './http.js';
import { PORTAL_PAUSED_REASON } from './plan-notice.js';
import { portalMaterialRequestsKey } from './portal-material-requests.js';
import { TestimonyRecorder } from './portal-material-upload-recorder.js';
import {
  IMAGE_ACCEPT,
  PortalUploadError,
  announceUploads,
  listUploads,
  portalUploadsKey,
  uploadErrorOf,
  uploadPortalFile
} from './portal-material-upload-model.js';
import { usePortalClient } from './portal.js';

export type UploadMode = 'photos' | 'testimony';

interface Item {
  readonly key: number;
  readonly name: string;
  readonly size: number;
  readonly state: 'sending' | 'done' | 'failed';
  readonly sent: number;
  readonly assetId?: string;
  readonly message?: string;
}

const CATEGORY: Record<UploadMode, PortalMaterialUploadCategory> = { photos: 'image', testimony: 'audio' };

const kib = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const countText = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The files the person already sent to this request, newest first as the API gives them: the photo as a thumbnail, the audio as a player. */
function SentFiles({ clientId, threadId }: { clientId: string; threadId: string }) {
  const httpClient = useApiClient();
  const files = useInfiniteQuery({
    queryKey: portalUploadsKey(clientId, threadId),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => listUploads(httpClient, clientId, threadId, pageParam, signal),
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined)
  });
  const items: PortalMaterialUpload[] = files.data?.pages.flatMap((page) => page.data) ?? [];
  const total = files.data?.pages[0]?.meta.totalItems ?? 0;
  if (files.isPending && files.errorUpdateCount === 0) return null;
  if (files.data === undefined) {
    return <p className="portal-upload__error" role="alert">Não foi possível carregar os arquivos enviados. <Button variant="ghost" size="sm" loading={files.isFetching} onClick={() => { void files.refetch(); }}>Tentar de novo</Button></p>;
  }
  if (items.length === 0) return null;
  return <section className="portal-upload__sent" aria-labelledby={`sent-${threadId}`}>
    <h3 id={`sent-${threadId}`} className="portal-upload__subtitle">Arquivos já enviados ({total})</h3>
    <ul className="portal-upload__grid">
      {items.map((file) => <li key={file.id} className={file.category === 'audio' ? 'portal-upload__file portal-upload__file--audio' : 'portal-upload__file'}>
        {file.status === 'pending' || file.url === null
          ? <span className="portal-upload__wait">{file.name ?? 'Arquivo'}: envio em andamento</span>
          : file.category === 'image'
            ? <img className="portal-upload__thumb" src={file.url} alt={file.name ?? 'Foto enviada'} width={file.width ?? undefined} height={file.height ?? undefined} loading="lazy" />
            : <div className="portal-upload__audio"><span>{file.name ?? 'Depoimento'}</span><audio controls src={file.url} aria-label={`Ouvir ${file.name ?? 'o depoimento'}`} /></div>}
      </li>)}
    </ul>
    {files.hasNextPage && <Button variant="secondary" loading={files.isFetchingNextPage} onClick={() => { void files.fetchNextPage(); }}>Ver mais arquivos</Button>}
  </section>;
}

function ItemRow({ item }: { item: Item }) {
  const percent = item.size > 0 ? Math.round((item.sent / item.size) * 100) : 0;
  return <li className="portal-upload__item" data-state={item.state}>
    <span className="portal-upload__item-name">{item.name}</span>
    {item.state === 'sending' && <>
      <ProgressBar label={`Enviando ${item.name}`} value={percent} />
      <span className="portal-upload__item-status">Enviando, {percent}%</span>
    </>}
    {item.state === 'done' && <span className="portal-upload__item-status">Enviado ({kib(item.size)})</span>}
    {item.state === 'failed' && <span className="portal-upload__item-status portal-upload__item-status--failed">{item.message}</span>}
  </li>;
}

/**
 * The upload of the client to one open request: the files go one by one (reserve, PUT, confirm), and when the batch ends with at least one
 * confirmed file the request is told once ("enviou N fotos"). The answer of the API for a request that was resolved meanwhile closes the offer.
 */
export function PortalUploadDialog({ clientId, request, mode, onClose }: { clientId: string; request: MaterialRequest; mode: UploadMode; onClose: () => void }) {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [locked, setLocked] = useState<string | undefined>();
  const [announceFailure, setAnnounceFailure] = useState<readonly string[] | undefined>();
  const counter = useRef(0);
  const batching = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const category = CATEGORY[mode];

  useEffect(() => () => { controller.current?.abort(); }, []);

  const patch = (key: number, change: Partial<Item>): void => { setItems((current) => current.map((item) => item.key === key ? { ...item, ...change } : item)); };

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: portalMaterialRequestsKey(clientId) });
    void queryClient.invalidateQueries({ queryKey: ['conversation'] });
  };

  const announce = async (ids: readonly string[]): Promise<void> => {
    try {
      await announceUploads(httpClient, clientId, request.threadId, ids);
      setAnnounceFailure(undefined);
    } catch (error: unknown) {
      const failure = uploadErrorOf(error);
      if (failure.fatal) setLocked(failure.userMessage);
      else setAnnounceFailure(ids);
    }
  };

  const send = async (files: File[]): Promise<void> => {
    if (files.length === 0 || batching.current) return;
    batching.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setAnnounceFailure(undefined);
    const batch: Item[] = files.map((file) => ({ key: ++counter.current, name: file.name, size: file.size, state: 'sending', sent: 0 }));
    setItems(batch);
    const confirmed: string[] = [];
    for (const [index, file] of files.entries()) {
      const item = batch[index];
      if (item === undefined) continue;
      try {
        const assetId = await uploadPortalFile({
          httpClient, clientId, threadId: request.threadId, file, category,
          onProgress: (sent) => { patch(item.key, { sent }); },
          signal: abort.signal
        });
        confirmed.push(assetId);
        patch(item.key, { state: 'done', sent: file.size, assetId });
      } catch (error: unknown) {
        const failure = error instanceof PortalUploadError ? error : uploadErrorOf(error);
        patch(item.key, { state: 'failed', message: failure.userMessage });
        if (failure.fatal) {
          setLocked(failure.userMessage);
          // What is left of the batch is not tried: the request no longer takes files.
          for (const rest of batch.slice(index + 1)) patch(rest.key, { state: 'failed', message: 'Não enviado.' });
          break;
        }
      }
    }
    // One announcement per batch, only for what the server confirmed.
    if (confirmed.length > 0) await announce(confirmed);
    batching.current = false;
    setRunning(false);
    refresh();
  };

  const choose = (list: FileList | null): void => {
    const files = list === null ? [] : Array.from(list);
    if (picker.current !== null) picker.current.value = '';
    void send(files);
  };

  const confirmedCount = items.filter((item) => item.state === 'done').length;
  const summary = !running && items.length > 0
    ? `${countText(confirmedCount, 'arquivo enviado', 'arquivos enviados')}${items.length > confirmedCount ? `, ${countText(items.length - confirmedCount, 'não foi enviado', 'não foram enviados')}` : ''}.`
    : running ? 'Enviando os arquivos…' : '';

  return <Modal
    title={mode === 'photos' ? 'Enviar fotos' : 'Gravar depoimento'}
    description={request.title ?? MATERIAL_REQUEST_LABEL}
    closeLabel="Fechar envio"
    size="lg"
    onClose={onClose}
  >
    <div className="portal-upload">
      {locked !== undefined
        ? <p className="portal-upload__error" role="alert">{locked}</p>
        : mode === 'photos'
          ? <div className="portal-upload__pick">
            <input ref={picker} type="file" multiple accept={IMAGE_ACCEPT} hidden aria-label="Escolher fotos" onChange={(event) => { choose(event.target.files); }} />
            <Button leadingIcon={<Camera />} loading={running} onClick={() => picker.current?.click()}>Escolher fotos</Button>
            <p className="portal-upload__note">PNG, JPEG, WebP ou GIF, de até 25 MB cada, até 20 arquivos por pedido.</p>
          </div>
          : <TestimonyRecorder busy={running} onSend={(files) => { void send(files); }} />}
      {items.length > 0 && <ul className="portal-upload__items" aria-label="Envio em andamento">
        {items.map((item) => <ItemRow key={item.key} item={item} />)}
      </ul>}
      <LiveStatus className="portal-upload__live">{summary}</LiveStatus>
      {announceFailure !== undefined && <div className="portal-upload__error" role="alert">
        <span>Os arquivos foram enviados, mas não conseguimos avisar a agência.</span>
        <Button variant="secondary" size="sm" onClick={() => { void announce(announceFailure).then(refresh); }}>Avisar de novo</Button>
      </div>}
      <SentFiles clientId={clientId} threadId={request.threadId} />
    </div>
  </Modal>;
}

/** "Enviar fotos" and "Gravar depoimento" of one request that is open; a request that is not open has no such offer (the list only holds open ones). */
export function PortalUploadActions({ clientId, request, variant = 'secondary' }: { clientId: string; request: MaterialRequest; variant?: 'secondary' | 'ghost' }) {
  const client = usePortalClient();
  const [mode, setMode] = useState<UploadMode | null>(null);
  if (request.state !== 'open') return null;
  const blockedReason = client.agencyReadOnly ? PORTAL_PAUSED_REASON : undefined;
  return <>
    <Button variant={variant} leadingIcon={<Camera />} blockedReason={blockedReason} onClick={() => setMode('photos')}>Enviar fotos</Button>
    <Button variant={variant} leadingIcon={<Mic />} blockedReason={blockedReason} onClick={() => setMode('testimony')}>Gravar depoimento</Button>
    {mode !== null && <PortalUploadDialog clientId={clientId} request={request} mode={mode} onClose={() => setMode(null)} />}
  </>;
}
