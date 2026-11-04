import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  MediaFolderAssetListResponseSchema,
  MediaFolderListResponseSchema,
  MediaFolderNameSchema,
  MediaFolderSchema,
  CONTENT_CAROUSEL_MAX_MEDIA,
  type ContentFormat,
  type CreateMediaFolderRequest,
  type MediaFolder,
  type MediaFolderAsset
} from '@ageniza/contracts';
import { ArrowLeft, ArrowRight, Plus, X } from 'lucide-react';

import { Button, Field, FieldMessage, IconButton, Select, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { formatAgencyDayMonth } from './client-detail.js';
import { apiPath } from './api-path.js';
import { ContentCover } from './content-cover.js';
import { sizeLabel } from './content-folders.js';
import { acceptedCategory } from './content-form.js';
import { FORMAT_LABELS } from './content-labels.js';
import { HttpClientError, useApiClient } from './http.js';
import { MediaUploader } from './media-uploader.js';

const FOLDERS_PATH = '/agencies/:agencyId/clients/:clientId/media-folders';
const ASSETS_PATH = `${FOLDERS_PATH}/:folderId/assets`;
const PAGE_SIZE = 100;
/** A client has a handful of folders; the cap only keeps a runaway listing from looping. */
const MAX_PAGES = 20;

const foldersKey = (agencyId: string, clientId: string) => ['agency', agencyId, 'media-folders', clientId, 'folders'] as const;

/** Every page of a listing, in the server's order: the picker never shows only the first hundred as if they were all. */
export async function readAllPages<T>(readPage: (page: number) => Promise<{ data: readonly T[]; meta: { totalPages: number } }>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await readPage(page);
    items.push(...result.data);
    if (page >= result.meta.totalPages) break;
  }
  return items;
}

export const useClientFolders = (clientId: string) => {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  return useQuery({
    queryKey: foldersKey(agency.agencyId, clientId),
    queryFn: ({ signal }) => readAllPages((page) => httpClient.request({
      path: `${apiPath(FOLDERS_PATH, { agencyId: agency.agencyId, clientId })}?page=${page}&pageSize=${PAGE_SIZE}`,
      response: MediaFolderListResponseSchema,
      signal
    }))
  });
};

const assetsKey = (agencyId: string, clientId: string, folderId: string) => ['agency', agencyId, 'media-folders', clientId, 'assets', folderId] as const;

/** Every confirmed media of a folder, in the order the folder lists it. */
const useReadFolder = (clientId: string) => {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  return (folderId: string, signal?: AbortSignal) => readAllPages((page) => httpClient.request({
    path: `${apiPath(ASSETS_PATH, { agencyId: agency.agencyId, clientId, folderId })}?page=${page}&pageSize=${PAGE_SIZE}`,
    response: MediaFolderAssetListResponseSchema,
    ...(signal === undefined ? {} : { signal })
  }));
};

export const useFolderAssets = (clientId: string, folderId: string) => {
  const agency = useAgencyContext();
  const read = useReadFolder(clientId);
  return useQuery({
    queryKey: assetsKey(agency.agencyId, clientId, folderId),
    enabled: folderId !== '',
    // The folder is read when the person looks at it: a copy from a minute ago may miss a media another operator removed.
    staleTime: 0,
    queryFn: ({ signal }) => read(folderId, signal)
  });
};

/** The folder read again, now: what the content takes from it is what it holds at this moment, never a copy from before. */
export const useFreshFolder = (clientId: string): ((folderId: string) => Promise<MediaFolderAsset[]>) => {
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const read = useReadFolder(clientId);
  return (folderId) => queryClient.fetchQuery({
    queryKey: assetsKey(agency.agencyId, clientId, folderId),
    staleTime: 0,
    queryFn: ({ signal }) => read(folderId, signal)
  });
};

/** "Vídeos / Lançamento": a working folder is named with the one it lives in. */
export const folderLabels = (folders: readonly MediaFolder[]): ReadonlyMap<string, string> => {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return new Map(folders.map((folder) => {
    const parent = folder.parentId === null ? undefined : byId.get(folder.parentId);
    return [folder.id, parent === undefined ? folder.name : `${parent.name} / ${folder.name}`];
  }));
};

const NAME_INVALID = 'O nome da pasta tem caracteres que não são aceitos, ou passa de 80 caracteres.';

const folderCreateMessage = (error: unknown): string => {
  if (error instanceof HttpClientError) {
    if (error.status === 400) return NAME_INVALID;
    if (error.status === 409 && error.code === 'CLIENT_ARCHIVED') return 'Este cliente está arquivado: não é possível criar pastas.';
    if (error.status === 403) return 'Você não tem permissão para criar pastas.';
    if (error.status === 404) return 'Este cliente não existe mais.';
  }
  return 'Não foi possível criar a pasta. Tente de novo.';
};

function NewFolder({ clientId, folders, onCreated, onCancel }: {
  clientId: string;
  folders: readonly MediaFolder[];
  onCreated: (folder: MediaFolder) => void;
  onCancel: () => void;
}) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const nameId = useId();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState<string | undefined>();

  const create = useMutation({
    mutationFn: () => httpClient.request({
      path: apiPath(FOLDERS_PATH, { agencyId: agency.agencyId, clientId }),
      method: 'POST',
      body: { name, ...(parentId === '' ? {} : { parentId }) } satisfies CreateMediaFolderRequest,
      response: MediaFolderSchema
    }),
    onSuccess: (folder) => {
      void queryClient.invalidateQueries({ queryKey: foldersKey(agency.agencyId, clientId) });
      onCreated(folder);
    },
    onError: (failure) => setError(folderCreateMessage(failure))
  });

  const submit = (): void => {
    setError(undefined);
    if (!MediaFolderNameSchema.safeParse(name).success) { setError(name.trim() === '' ? 'Informe o nome da pasta.' : NAME_INVALID); return; }
    create.mutate();
  };

  return <fieldset className="content-media__new-folder" disabled={create.isPending}>
    <legend>Nova pasta</legend>
    <Field label="Nome da pasta" id={nameId}>
      {(control) => <TextInput
        {...control}
        value={name}
        onChange={(event) => { setName(event.target.value); setError(undefined); }}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `${nameId}-error`}
      />}
    </Field>
    <Select
      label="Dentro de"
      value={parentId}
      placeholder="Primeiro nível"
      options={folders.filter((folder) => folder.parentId === null).map((folder) => ({ value: folder.id, label: folder.name }))}
      onChange={setParentId}
    />
    {error !== undefined && <FieldMessage id={`${nameId}-error`} role="alert">{error}</FieldMessage>}
    <div className="form-actions">
      <Button variant="secondary" loading={create.isPending} onClick={submit}>Criar pasta</Button>
      <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
    </div>
  </fieldset>;
}

/**
 * The folder of the content, to choose or to create. The content takes what the folder holds; changing it is always allowed, and
 * when that takes something out of the content (`warning`), the person is told the effect first and confirms.
 */
export function FolderField({ clientId, value, onChange, disabled, canCreate, error, hint, warning }: {
  clientId: string;
  value: string;
  onChange: (folderId: string) => void;
  disabled: boolean;
  canCreate: boolean;
  error?: string | undefined;
  hint?: string | undefined;
  /** What the change takes away or moves, or `undefined` when nothing is lost and no confirmation is asked. */
  warning?: string | undefined;
}) {
  const folders = useClientFolders(clientId);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const errorId = useId();
  const hintId = useId();

  if (folders.isPending) return <Skeleton aria-hidden="true" />;
  if (folders.isError) {
    return <div role="alert" className="form-field">
      <p>Não foi possível carregar as pastas. Tente de novo.</p>
      <Button variant="secondary" onClick={() => { void folders.refetch(); }}>Tentar de novo</Button>
    </div>;
  }
  const labels = folderLabels(folders.data);
  const choose = (folderId: string): void => {
    if (folderId === value) return;
    if (warning === undefined) onChange(folderId);
    else setPending(folderId);
  };
  const describedBy = [hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId].filter((id) => id !== undefined).join(' ');
  return <div className="form-field">
    <Select
      label="Pasta"
      value={value}
      placeholder="Escolha a pasta"
      options={folders.data.map((folder) => ({ value: folder.id, label: labels.get(folder.id) ?? folder.name }))}
      disabled={disabled}
      aria-invalid={error !== undefined}
      aria-describedby={describedBy === '' ? undefined : describedBy}
      onChange={choose}
    />
    {hint !== undefined && <p id={hintId} className="form-hint">{hint}</p>}
    {error !== undefined && <FieldMessage id={errorId} role="alert">{error}</FieldMessage>}
    {pending !== null && warning !== undefined && <div className="content-media__confirm" role="group" aria-label="Trocar a pasta">
      <p className="content-media__confirm-title">Trocar para {labels.get(pending) ?? 'a pasta escolhida'}?</p>
      <p>{warning}</p>
      <div className="form-actions">
        <Button variant="secondary" onClick={() => { onChange(pending); setPending(null); }}>Trocar a pasta</Button>
        <Button variant="ghost" onClick={() => setPending(null)}>Manter a pasta atual</Button>
      </div>
    </div>}
    {canCreate && !disabled && !creating && <Button variant="secondary" onClick={() => setCreating(true)}>Nova pasta</Button>}
    {creating && <NewFolder
      clientId={clientId}
      folders={folders.data}
      onCreated={(folder) => { setCreating(false); choose(folder.id); }}
      onCancel={() => setCreating(false)}
    />}
  </div>;
}

const assetLabel = (asset: MediaFolderAsset): string =>
  `${asset.category === 'video' ? 'Vídeo' : 'Imagem'} de ${formatAgencyDayMonth(asset.createdAt)}`;

function AssetThumb({ asset }: { asset: Pick<MediaFolderAsset, 'category'> & { id: string } }) {
  return <ContentCover assetId={asset.id} format={asset.category === 'video' ? 'reels' : 'image'} className="content-media__thumb" />;
}

/**
 * The media of the content, in order, and what its folder holds to adjust it from. A format that takes one media replaces it; a
 * carousel appends and the list is ordered by hand, because the order is the carousel's. A file sent from here lands in the folder
 * and enters the content, the same as one sent from the Pastas view.
 */
export function MediaField({ clientId, folderId, format, selected, onChange, onSendingChange, disabled, canSend, error }: {
  clientId: string;
  folderId: string;
  format: ContentFormat;
  selected: readonly string[];
  onChange: (assetIds: readonly string[]) => void;
  /** True while a file goes up or is being put in the list: the form must not be saved with half of it. */
  onSendingChange?: ((sending: boolean) => void) | undefined;
  disabled: boolean;
  /** The person may send a file (`conteudo.operar`, and nothing blocks a write): the folder is what receives it. */
  canSend: boolean;
  error?: string | undefined;
}) {
  const assets = useFolderAssets(clientId, folderId);
  const freshFolder = useFreshFolder(clientId);
  const errorId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | undefined>();
  const accepted = acceptedCategory(format);
  const single = format !== 'carousel';
  // A file takes time to go up and the person keeps working: what the list and the format are when it ends is what counts, not
  // what they were when it started.
  const live = useRef({ selected, format });
  live.current = { selected, format };
  const [uploading, setUploading] = useState(false);
  const [placing, setPlacing] = useState(false);
  const sending = uploading || placing;
  useEffect(() => { onSendingChange?.(sending); }, [sending, onSendingChange]);
  useEffect(() => () => { onSendingChange?.(false); }, [onSendingChange]);
  const move = (index: number, direction: -1 | 1): void => {
    const next = [...selected];
    const target = index + direction;
    const moved = next[index];
    const other = next[target];
    if (moved === undefined || other === undefined) return;
    next[index] = other;
    next[target] = moved;
    onChange(next);
  };

  // The file is read back from the folder: the category of what was sent decides whether this format takes it.
  const sent = async (assetId: string): Promise<void> => {
    setNotice(undefined);
    setPlacing(true);
    try {
      let current: MediaFolderAsset[];
      try {
        current = await freshFolder(folderId);
      } catch {
        setNotice('A mídia foi enviada para a pasta, mas não deu para ler a pasta agora. Escolha a mídia na lista quando ela aparecer.');
        return;
      }
      const added = current.find((asset) => asset.id === assetId);
      if (added === undefined) return;
      const { selected: now, format: nowFormat } = live.current;
      const nowAccepted = acceptedCategory(nowFormat);
      if (nowAccepted !== null && added.category !== nowAccepted) {
        setNotice(`A mídia foi para a pasta, mas o formato ${FORMAT_LABELS[nowFormat]} não usa ${added.category === 'video' ? 'vídeo' : 'imagem'}.`);
        return;
      }
      if (nowFormat === 'carousel' && now.length >= CONTENT_CAROUSEL_MAX_MEDIA) {
        setNotice(`A mídia foi para a pasta, mas um carrossel leva até ${CONTENT_CAROUSEL_MAX_MEDIA} mídias.`);
        return;
      }
      onChange(nowFormat === 'carousel' ? [...now, assetId] : [assetId]);
    } finally {
      setPlacing(false);
    }
  };

  return <div className="form-field content-media" role="group" aria-label="Mídias">
    <p className="content-media__title">Mídias do conteúdo · {FORMAT_LABELS[format]}</p>
    {selected.length === 0
      ? <p className="form-hint">{folderId === '' ? 'Escolha a pasta: o conteúdo usa a mídia que estiver nela.' : 'Nenhuma mídia no conteúdo.'}</p>
      : <ol className="content-media__selected">
        {selected.map((id, index) => <li key={id} className="content-media__tile">
          <div className="content-media__frame">
            <AssetThumb asset={{ id, category: accepted ?? 'image' }} />
            <span className="content-media__number" aria-hidden="true">{index + 1}</span>
            <span className="visually-hidden">Mídia {index + 1}</span>
          </div>
          <div className="content-media__tools">
            {!single && <>
              <IconButton size="sm" label={`Mover mídia ${index + 1} para antes`} icon={<ArrowLeft />} disabled={disabled || index === 0} onClick={() => move(index, -1)} />
              <IconButton size="sm" label={`Mover mídia ${index + 1} para depois`} icon={<ArrowRight />} disabled={disabled || index === selected.length - 1} onClick={() => move(index, 1)} />
            </>}
            <IconButton size="sm" label={`Tirar mídia ${index + 1}`} icon={<X />} disabled={disabled} onClick={() => onChange(selected.filter((other) => other !== id))} />
          </div>
        </li>)}
      </ol>}
    {error !== undefined && <FieldMessage id={errorId} role="alert">{error}</FieldMessage>}
    {!disabled && folderId !== '' && <>
      {canSend
        ? <MediaUploader
          clientId={clientId}
          folderId={folderId}
          onUploaded={(assetId) => { void sent(assetId); }}
          onSendingChange={setUploading}
          sizeLabel={sizeLabel}
          heading={<p className="content-media__title">Mídias da pasta</p>}
          inputRef={picker}
        />
        : <p className="content-media__title">Mídias da pasta</p>}
      {notice !== undefined && <p className="form-hint" role="status">{notice}</p>}
      {assets.isPending && <Skeleton aria-hidden="true" />}
      {assets.isError && <div role="alert">
        <p>Não foi possível carregar as mídias da pasta. Tente de novo.</p>
        <Button variant="secondary" onClick={() => { void assets.refetch(); }}>Tentar de novo</Button>
      </div>}
      {assets.data !== undefined && (() => {
        if (assets.data.length === 0) return <p className="form-hint">Esta pasta está vazia. Envie a primeira mídia por aqui.</p>;
        const fitting = assets.data.filter((asset) => accepted === null || asset.category === accepted);
        if (fitting.length === 0) return <p className="form-hint">Esta pasta não tem {accepted === 'video' ? 'vídeos' : 'imagens'} para este formato.</p>;
        return <ul className="content-media__folder">
          {fitting.map((asset) => <li key={asset.id} className="content-media__tile">
            <div className="content-media__frame"><AssetThumb asset={asset} /></div>
            <span className="content-media__caption">{assetLabel(asset)}</span>
            <IconButton
              size="sm"
              variant="secondary"
              label={`Adicionar ${assetLabel(asset)}`}
              icon={<Plus />}
              disabled={selected.includes(asset.id)}
              onClick={() => onChange(single ? [asset.id] : [...selected, asset.id])}
            />
          </li>)}
        </ul>;
      })()}
    </>}
  </div>;
}

/** The cover of a video: one confirmed image of the folder, or none (the worker's own frame then stands in). */
export function CoverField({ clientId, folderId, value, onChange, disabled, error }: {
  clientId: string;
  folderId: string;
  value: string | null;
  onChange: (assetId: string | null) => void;
  disabled: boolean;
  error?: string | undefined;
}) {
  const assets = useFolderAssets(clientId, folderId);
  const errorId = useId();
  const images = (assets.data ?? []).filter((asset) => asset.category === 'image');
  return <div className="form-field content-media" role="group" aria-label="Capa">
    <p className="content-media__title">Capa</p>
    {value === null ? <p className="form-hint">Sem capa: vale o quadro automático do vídeo.</p> : <AssetThumb asset={{ id: value, category: 'image' }} />}
    {error !== undefined && <FieldMessage id={errorId} role="alert">{error}</FieldMessage>}
    {!disabled && <>
      {value !== null && <Button variant="ghost" onClick={() => onChange(null)}>Tirar a capa</Button>}
      {images.length > 0 && <ul className="content-media__folder">
        {images.map((asset) => <li key={asset.id} className="content-media__tile">
          <div className="content-media__frame"><AssetThumb asset={asset} /></div>
          <span className="content-media__caption">{assetLabel(asset)}</span>
          <Button size="sm" variant="secondary" aria-pressed={value === asset.id} aria-label={`Usar ${assetLabel(asset)} como capa`} disabled={value === asset.id} onClick={() => onChange(asset.id)}>Usar</Button>
        </li>)}
      </ul>}
    </>}
  </div>;
}
