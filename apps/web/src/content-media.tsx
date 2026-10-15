import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  MediaFolderAssetListResponseSchema,
  MediaFolderListResponseSchema,
  MediaFolderNameSchema,
  MediaFolderSchema,
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
import { FORMAT_LABELS } from './content-labels.js';
import { HttpClientError, useApiClient } from './http.js';

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

export const useFolderAssets = (clientId: string, folderId: string) => {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  return useQuery({
    queryKey: ['agency', agency.agencyId, 'media-folders', clientId, 'assets', folderId],
    enabled: folderId !== '',
    // The folder is read when the person looks at it: a copy from a minute ago may miss a media another operator removed.
    staleTime: 0,
    queryFn: ({ signal }) => readAllPages((page) => httpClient.request({
      path: `${apiPath(ASSETS_PATH, { agencyId: agency.agencyId, clientId, folderId })}?page=${page}&pageSize=${PAGE_SIZE}`,
      response: MediaFolderAssetListResponseSchema,
      signal
    }))
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

/** The folder of the content, to choose or to create. Locked (but shown) while the content holds media or a cover. */
export function FolderField({ clientId, value, onChange, locked, disabled, canCreate, error }: {
  clientId: string;
  value: string;
  onChange: (folderId: string) => void;
  /** The content already has media or a cover: the folder stays until both are taken off. */
  locked: boolean;
  disabled: boolean;
  canCreate: boolean;
  error?: string | undefined;
}) {
  const folders = useClientFolders(clientId);
  const [creating, setCreating] = useState(false);
  const errorId = useId();

  if (folders.isPending) return <Skeleton aria-hidden="true" />;
  if (folders.isError) {
    return <div role="alert" className="form-field">
      <p>Não foi possível carregar as pastas. Tente de novo.</p>
      <Button variant="secondary" onClick={() => { void folders.refetch(); }}>Tentar de novo</Button>
    </div>;
  }
  const labels = folderLabels(folders.data);
  return <div className="form-field">
    <Select
      label="Pasta"
      value={value}
      placeholder="Escolha a pasta"
      options={folders.data.map((folder) => ({ value: folder.id, label: labels.get(folder.id) ?? folder.name }))}
      disabled={disabled || locked}
      aria-invalid={error !== undefined}
      aria-describedby={error === undefined ? undefined : errorId}
      onChange={onChange}
    />
    {locked && <p className="form-hint">A pasta não muda enquanto o conteúdo tem mídia ou capa.</p>}
    {error !== undefined && <FieldMessage id={errorId} role="alert">{error}</FieldMessage>}
    {canCreate && !disabled && !locked && !creating && <Button variant="secondary" onClick={() => setCreating(true)}>Nova pasta</Button>}
    {creating && <NewFolder
      clientId={clientId}
      folders={folders.data}
      onCreated={(folder) => { setCreating(false); onChange(folder.id); }}
      onCancel={() => setCreating(false)}
    />}
  </div>;
}

const assetLabel = (asset: MediaFolderAsset): string =>
  `${asset.category === 'video' ? 'Vídeo' : 'Imagem'} de ${formatAgencyDayMonth(asset.createdAt)}`;

/** What a format accepts: one image, one video, or up to 20 of either (`app_private.content_media_is_complete`). */
const acceptedCategory = (format: ContentFormat): MediaFolderAsset['category'] | null => {
  if (format === 'carousel') return null;
  return format === 'image' ? 'image' : 'video';
};

function AssetThumb({ asset }: { asset: Pick<MediaFolderAsset, 'category'> & { id: string } }) {
  return <ContentCover assetId={asset.id} format={asset.category === 'video' ? 'reels' : 'image'} className="content-media__thumb" />;
}

/**
 * The media of the content, in order, and the confirmed media of its folder to add from. A format that takes one
 * media replaces it; a carousel appends and the list is ordered by hand, because the order is the carousel's.
 */
export function MediaField({ clientId, folderId, format, selected, onChange, disabled, error }: {
  clientId: string;
  folderId: string;
  format: ContentFormat;
  selected: readonly string[];
  onChange: (assetIds: readonly string[]) => void;
  disabled: boolean;
  error?: string | undefined;
}) {
  const assets = useFolderAssets(clientId, folderId);
  const errorId = useId();
  const accepted = acceptedCategory(format);
  const single = format !== 'carousel';
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

  return <div className="form-field content-media" role="group" aria-label="Mídias">
    <p className="content-media__title">Mídias · {FORMAT_LABELS[format]}</p>
    {selected.length === 0
      ? <p className="form-hint">Nenhuma mídia escolhida.</p>
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
      <p className="content-media__title">Mídias da pasta</p>
      {assets.isPending && <Skeleton aria-hidden="true" />}
      {assets.isError && <div role="alert">
        <p>Não foi possível carregar as mídias da pasta. Tente de novo.</p>
        <Button variant="secondary" onClick={() => { void assets.refetch(); }}>Tentar de novo</Button>
      </div>}
      {assets.data !== undefined && (() => {
        const fitting = assets.data.filter((asset) => accepted === null || asset.category === accepted);
        if (fitting.length === 0) return <p className="form-hint">Esta pasta não tem {accepted === 'video' ? 'vídeos' : accepted === 'image' ? 'imagens' : 'mídias'} para este formato.</p>;
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
