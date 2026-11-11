import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronRight, CircleAlert, Download, Folder, FolderPlus, Image as ImageIcon, LoaderCircle, Plus, Trash2, Upload, Video, X } from 'lucide-react';
import type { z } from 'zod';

import {
  MEDIA_FOLDER_NAME_MAX_LENGTH,
  MediaDownloadUrlResponseSchema,
  MediaFolderAssetListResponseSchema,
  MediaFolderListResponseSchema,
  MediaFolderNameSchema,
  MediaFolderSchema,
  RemoveMediaAssetResponseSchema,
  type MediaCategory,
  type MediaFolder,
  type MediaFolderAsset
} from '@ageniza/contracts';
import { Button, ButtonLink, ConfirmDialog, EmptyState, FieldMessage, IconButton, Modal, Pagination, Pill, Skeleton, Stage3D, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';
import { isHttpUrl, MediaThumbnail } from './media-thumbnail.js';
import { MediaUploader } from './media-uploader.js';

/** The listing's own ceiling: a client's folders are read page by page until the last, so no folder is hidden behind a page. */
const FOLDERS_PAGE_SIZE = 100;
const MAX_FOLDER_PAGES = 10;
const ASSETS_PAGE_SIZE = 48;

type MediaFolderAssetListResponse = z.infer<typeof MediaFolderAssetListResponseSchema>;

const CATEGORY_LABELS: Readonly<Record<MediaCategory, string>> = { image: 'Imagem', video: 'Vídeo' };
const CATEGORY_ICONS: Readonly<Record<MediaCategory, ReactNode>> = { image: <ImageIcon />, video: <Video /> };

const NO_PERMISSION = 'Você não tem permissão para fazer isso.';
const NAME_REQUIRED = 'Informe o nome da pasta.';
const NAME_TOO_LONG = `O nome pode ter até ${MEDIA_FOLDER_NAME_MAX_LENGTH} caracteres.`;
const NAME_INVALID = 'Use um nome sem caracteres invisíveis ou de controle.';
const CREATE_FAILED = 'Não foi possível criar a pasta. Tente de novo.';

const sizeFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

export const sizeLabel = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${sizeFormat.format(bytes / (1024 * 1024))} MB`;
  return `${sizeFormat.format(bytes / (1024 * 1024 * 1024))} GB`;
};

const foldersQueryKey = (agencyId: string, clientId: string): readonly unknown[] => ['agency', agencyId, 'media-folders', clientId];
const assetsQueryKey = (agencyId: string, clientId: string, folderId: string): readonly unknown[] =>
  ['agency', agencyId, 'media-folder-assets', clientId, folderId];

const foldersBase = (agencyId: string, clientId: string): string =>
  apiPath('/agencies/:agencyId/clients/:clientId/media-folders', { agencyId, clientId });

interface FolderList {
  readonly folders: readonly MediaFolder[];
  readonly total: number;
}

const useClientFolders = (clientId: string) => {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  return useQuery<FolderList>({
    queryKey: foldersQueryKey(agency.agencyId, clientId),
    queryFn: async ({ signal }) => {
      const folders: MediaFolder[] = [];
      let total = 0;
      for (let page = 1; page <= MAX_FOLDER_PAGES; page += 1) {
        const answer = await httpClient.request({
          path: `${foldersBase(agency.agencyId, clientId)}?page=${page}&pageSize=${FOLDERS_PAGE_SIZE}`,
          response: MediaFolderListResponseSchema,
          signal
        });
        folders.push(...answer.data);
        total = answer.meta.totalItems;
        if (page >= answer.meta.totalPages) break;
      }
      return { folders, total };
    }
  });
};

/** A refusal the API words itself, in Portuguese, is shown as it is; any other text of the API is not the screen's to repeat. */
const apiReason = (error: unknown): string | undefined =>
  error instanceof HttpClientError && (error.code === 'MEDIA_IN_USE' || error.code === 'CLIENT_ARCHIVED') ? error.message : undefined;

const isForbidden = (error: unknown): boolean => error instanceof HttpClientError && (error.status === 403 || error.code === 'FORBIDDEN');

const hrefWith = (searchParams: URLSearchParams, changes: Readonly<Record<string, string | null>>): string => {
  const next = new URLSearchParams(searchParams);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) next.delete(name); else next.set(name, value);
  }
  return `?${next.toString()}`;
};

/** The icon of a line of text: it never names anything, the words beside it do. */
function Glyph({ children }: { children: ReactNode }) {
  return <span className="content-folders__glyph" aria-hidden="true">{children}</span>;
}

function LoadError({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return <EmptyState kind="failure" className="content-folders__empty" headingLevel={4} title={message} retrying={retrying} onRetry={onRetry} />;
}

function FolderCreateDialog({ clientId, parent, onClose }: { clientId: string; parent: MediaFolder | null; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const nameId = useId();
  const nameErrorId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const create = useMutation({
    mutationFn: (folderName: string) => httpClient.request({
      path: foldersBase(agency.agencyId, clientId),
      method: 'POST',
      body: parent === null ? { name: folderName } : { name: folderName, parentId: parent.id },
      response: MediaFolderSchema
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: foldersQueryKey(agency.agencyId, clientId) });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof HttpClientError && error.status === 400) { setNameError(NAME_INVALID); return; }
      if (isForbidden(error)) { setFormError(NO_PERMISSION); return; }
      setFormError(apiReason(error) ?? (error instanceof HttpClientError && error.status === 404 ? 'A pasta não existe mais.' : CREATE_FAILED));
    }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') { setNameError(NAME_REQUIRED); return; }
    if (trimmed.length > MEDIA_FOLDER_NAME_MAX_LENGTH) { setNameError(NAME_TOO_LONG); return; }
    if (!MediaFolderNameSchema.safeParse(trimmed).success) { setNameError(NAME_INVALID); return; }
    create.mutate(trimmed);
  };

  const title = parent === null ? 'Nova pasta' : 'Nova pasta de trabalho';
  return <Modal title={title} closeLabel={`Fechar ${title.toLowerCase()}`} onClose={onClose}>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <div className="form-field">
        <label htmlFor={nameId}>Nome da pasta</label>
        <TextInput
          ref={nameRef}
          id={nameId}
          name="name"
          value={name}
          onChange={(event) => { setName(event.target.value); setNameError(undefined); setFormError(undefined); }}
          aria-invalid={nameError !== undefined}
          aria-describedby={nameError === undefined ? undefined : nameErrorId}
        />
        {nameError !== undefined && <FieldMessage id={nameErrorId} role="alert">{nameError}</FieldMessage>}
      </div>
      {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
      <div className="form-actions">
        <Button type="submit" loading={create.isPending}>Criar pasta</Button>
      </div>
    </form>
  </Modal>;
}

function FolderLinks({ folders, searchParams, param, extra, newFolder }: {
  folders: readonly MediaFolder[];
  searchParams: URLSearchParams;
  param: 'pasta' | 'subpasta';
  extra?: Readonly<Record<string, string | null>>;
  /** The "Nova pasta" card that closes the grid, for whoever can create one. */
  newFolder?: ReactNode;
}) {
  const location = useLocation();
  return <ul className="content-folders__list">
    {folders.map((folder) => <li key={folder.id}>
      <Link
        className="content-folder"
        to={hrefWith(searchParams, { ...extra, [param]: folder.id, pagina: null })}
        state={location.state}
        data-stage-host
      >
        <Stage3D className="content-folder__stage" src={folder.isDefault ? '/3d/fav-folder.png' : '/3d/folder.png'} tone={folder.isDefault ? 'indigo' : 'sky'} size="sm" />
        <span className="content-folder__name">{folder.name}</span>
        {folder.isDefault && <Pill>Padrão</Pill>}
        <span className="content-folder__chevron" aria-hidden="true"><ArrowRight /></span>
      </Link>
    </li>)}
    {newFolder !== undefined && <li>{newFolder}</li>}
  </ul>;
}

/** The empty states of the library: the folder on its stage above the sentence, in one dashed block. */
function BlankStage({ src, children }: { src: string; children: ReactNode }) {
  return <div className="content-folders__blank" data-stage-host>
    <Stage3D src={src} tone="sky" size="md" />
    {children}
  </div>;
}

/** The folder that is open, as the feature block of the library: the open folder is the one in use. */
function FolderFeature({ name, action }: { name: string; action?: ReactNode }) {
  return <div className="content-folders__heading content-folders__feature" data-stage-host>
    <Stage3D src="/3d/fav-folder.png" tone="indigo" size="md" breakout />
    <div className="content-folders__feature-text">
      <p className="content-folders__eyebrow">Pasta aberta</p>
      <h3>{name}</h3>
    </div>
    {action}
  </div>;
}

const mediaLabel = (asset: MediaFolderAsset): string =>
  `${CATEGORY_LABELS[asset.category]} de ${dateFormat.format(new Date(asset.createdAt))}, ${sizeLabel(asset.sizeBytes)}`;

const VIDEO_STATUS_LABELS: Readonly<Record<MediaFolderAsset['videoProcessingStatus'], string | undefined>> = {
  not_applicable: undefined,
  pending: 'Em andamento',
  processing: 'Em andamento',
  ready: 'Pronto',
  failed: 'Falhou'
};

/** Download and removal of one media, with the notice and the confirmation: the row and the detail panel share them. */
function MediaActions({ clientId, folderId, asset, canOperate, size, className }: {
  clientId: string;
  folderId: string;
  asset: MediaFolderAsset;
  canOperate: boolean;
  size: 'sm' | 'md';
  className: string;
}) {
  const agency = useAgencyContext();
  const blocked = useWriteBlocked();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const label = mediaLabel(asset);

  const remove = useMutation({
    mutationFn: () => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets/:assetId/remove', {
        agencyId: agency.agencyId, clientId, folderId, assetId: asset.id
      }),
      method: 'POST',
      response: RemoveMediaAssetResponseSchema
    }),
    onSuccess: () => {
      setConfirming(false);
      // The tile leaves at once; the refetch then settles the page and the count.
      queryClient.setQueriesData<MediaFolderAssetListResponse>({ queryKey: assetsQueryKey(agency.agencyId, clientId, folderId) }, (current) =>
        current === undefined ? current : { ...current, data: current.data.filter((candidate) => candidate.id !== asset.id) });
      void queryClient.invalidateQueries({ queryKey: assetsQueryKey(agency.agencyId, clientId, folderId) });
    },
    onError: (error: unknown) => {
      setConfirming(false);
      if (error instanceof HttpClientError && error.status === 404) {
        setNotice('Esta mídia não está mais nesta pasta.');
        void queryClient.invalidateQueries({ queryKey: assetsQueryKey(agency.agencyId, clientId, folderId) });
        return;
      }
      setNotice(apiReason(error) ?? (isForbidden(error) ? NO_PERMISSION : 'Não foi possível remover a mídia. Tente de novo.'));
    }
  });

  const download = useMutation({
    mutationFn: () => httpClient.request({
      path: `${apiPath('/agencies/:agencyId/media/:assetId/download-url', { agencyId: agency.agencyId, assetId: asset.id })}?variant=original`,
      response: MediaDownloadUrlResponseSchema
    }),
    onSuccess: ({ url }) => {
      if (!isHttpUrl(url)) { setNotice('Não foi possível preparar o download. Tente de novo.'); return; }
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    },
    onError: () => { setNotice('Não foi possível preparar o download. Tente de novo.'); }
  });

  return <>
    <div className={className}>
      <Button size={size} variant="secondary" leadingIcon={<Download />} aria-label={`Baixar ${label}`} loading={download.isPending} onClick={() => { setNotice(undefined); download.mutate(); }}>Baixar</Button>
      {canOperate && <Button size={size} variant="ghost" leadingIcon={<Trash2 />} aria-label={`Remover ${label}`} blockedReason={blocked} onClick={() => { setNotice(undefined); setConfirming(true); }}>Remover</Button>}
    </div>
    {notice !== undefined && <FieldMessage role="alert">{notice}</FieldMessage>}
    <ConfirmDialog
      open={confirming}
      title="Remover mídia?"
      description={`Remover a mídia "${label}"? Ela deixa a pasta e não poderá mais ser baixada.`}
      confirmLabel="Remover"
      cancelLabel="Cancelar"
      busy={remove.isPending}
      onConfirm={() => remove.mutate()}
      onCancel={() => setConfirming(false)}
    />
  </>;
}

function MediaTile({ clientId, folderId, asset, canOperate, selected, onSelect }: {
  clientId: string;
  folderId: string;
  asset: MediaFolderAsset;
  canOperate: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = mediaLabel(asset);
  const processing = asset.category === 'video' && (asset.videoProcessingStatus === 'pending' || asset.videoProcessingStatus === 'processing');
  const processingFailed = asset.category === 'video' && asset.videoProcessingStatus === 'failed';
  return <li className={`folder-media${selected ? ' folder-media--selected' : ''}`}>
    <MediaThumbnail assetId={asset.id} category={asset.category} />
    <div className="folder-media__body">
      <p className="folder-media__title">
        <button type="button" className="folder-media__select" aria-pressed={selected} aria-label={`Ver detalhes de ${label}`} onClick={onSelect}>
          <Glyph>{CATEGORY_ICONS[asset.category]}</Glyph>{CATEGORY_LABELS[asset.category]}
        </button>
      </p>
      <p className="folder-media__meta">{dateFormat.format(new Date(asset.createdAt))} · {sizeLabel(asset.sizeBytes)}</p>
      {processing && <Pill icon={<LoaderCircle />}>Processando vídeo</Pill>}
      {processingFailed && <p className="folder-media__failure"><Glyph><CircleAlert /></Glyph>Falha no processamento do vídeo</p>}
    </div>
    <MediaActions clientId={clientId} folderId={folderId} asset={asset} canOperate={canOperate} size="sm" className="folder-media__actions" />
  </li>;
}

/** The panel of the media that was chosen: what the API tells about it and the actions its row has. Under the list on a phone. */
function MediaDetail({ clientId, folder, asset, canOperate, onClose }: {
  clientId: string;
  folder: MediaFolder;
  asset: MediaFolderAsset;
  canOperate: boolean;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const sentAt = new Date(asset.createdAt);
  const status = VIDEO_STATUS_LABELS[asset.videoProcessingStatus];

  useEffect(() => {
    // Side by side the panel is already in view; stacked under a long list it is not.
    let stacked = false;
    try { stacked = !window.matchMedia('(min-width: 64rem)').matches; } catch { stacked = false; }
    if (!stacked) return;
    panel.current?.scrollIntoView?.({ block: 'nearest' });
    panel.current?.focus({ preventScroll: true });
  }, [asset.id]);

  return <aside ref={panel} className="media-detail" aria-labelledby={titleId} tabIndex={-1}>
    <div className="media-detail__top">
      <h4 id={titleId} className="media-detail__name">Detalhe da mídia</h4>
      <IconButton label="Fechar detalhes" icon={<X />} size="sm" onClick={onClose} />
    </div>
    <div className="media-detail__preview"><MediaThumbnail assetId={asset.id} category={asset.category} /></div>
    <p className="media-detail__sub">{CATEGORY_LABELS[asset.category]} · {sizeLabel(asset.sizeBytes)} · enviada em {dateFormat.format(sentAt)}</p>
    <div>
      <h5 className="media-detail__heading">Informações</h5>
      <dl className="media-detail__info">
        <dt>Pasta</dt><dd>{folder.name}</dd>
        <dt>Formato</dt><dd>{asset.contentType}</dd>
        <dt>Tamanho</dt><dd>{sizeLabel(asset.sizeBytes)}</dd>
        <dt>Enviada em</dt><dd>{dateFormat.format(sentAt)}, {timeFormat.format(sentAt)}</dd>
        {status !== undefined && <><dt>Processamento</dt><dd>{status}</dd></>}
      </dl>
    </div>
    <MediaActions clientId={clientId} folderId={folder.id} asset={asset} canOperate={canOperate} size="md" className="media-detail__actions" />
  </aside>;
}

const parsePage = (raw: string | null): number => {
  const page = Number(raw);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
};

function FolderMedia({ clientId, folder, canOperate }: { clientId: string; folder: MediaFolder; canOperate: boolean }) {
  const httpClient = useApiClient();
  const blocked = useWriteBlocked();
  const agency = useAgencyContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parsePage(searchParams.get('pagina'));
  const picker = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const assets = useQuery({
    queryKey: [...assetsQueryKey(agency.agencyId, clientId, folder.id), page],
    queryFn: ({ signal }) => httpClient.request({
      path: `${foldersBase(agency.agencyId, clientId)}/${encodeURIComponent(folder.id)}/assets?page=${page}&pageSize=${ASSETS_PAGE_SIZE}`,
      response: MediaFolderAssetListResponseSchema,
      signal
    })
  });

  const goToPage = (next: number): void => {
    const params = new URLSearchParams(searchParams);
    if (next === 1) params.delete('pagina'); else params.set('pagina', String(next));
    setSearchParams(params);
  };

  // A retry keeps the failure and its busy button (and the focus) in place: only the first read is a skeleton.
  const assetsFailed = assets.isError || (assets.isPending && assets.errorUpdateCount > 0);
  let body;
  if (assets.isPending && !assetsFailed) {
    body = <ul className="folder-media__grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_value, index) => <li key={index}><Skeleton className="folder-media__skeleton" /></li>)}
    </ul>;
  } else if ((assets.isError && assets.data === undefined) || assets.isPending) {
    body = <LoadError message="Não foi possível carregar as mídias. Tente de novo." retrying={assets.isFetching} onRetry={() => { void assets.refetch(); }} />;
  } else if (assets.data.meta.totalItems === 0) {
    body = <BlankStage src="/3d/folder.png">
      <EmptyState
        className="content-folders__empty"
        headingLevel={4}
        title="Nenhuma mídia nesta pasta ainda."
        description={canOperate ? 'Envie imagens ou vídeos para esta pasta.' : undefined}
        action={canOperate ? <Button variant="secondary" leadingIcon={<Upload />} blockedReason={blocked} onClick={() => picker.current?.click()}>Enviar mídia</Button> : undefined}
      />
    </BlankStage>;
  } else if (assets.data.data.length === 0) {
    body = <EmptyState
      className="content-folders__empty"
      headingLevel={4}
      title="Esta página não tem mídias."
      action={<Button variant="secondary" onClick={() => goToPage(assets.data.meta.totalPages)}>Ir para a última página</Button>}
    />;
  } else {
    // The panel follows the media that was chosen; one that left the page (removed, another page) closes it.
    const selected = assets.data.data.find((asset) => asset.id === selectedId);
    body = <div className={`media-layout${selected === undefined ? '' : ' media-layout--detail'}`}>
      <div className="media-layout__list">
        <div className="folder-media__table">
          <div className="folder-media__head" aria-hidden="true"><span>Mídia</span><span>Enviada em · tamanho</span></div>
          <ul className="folder-media__grid" aria-label="Mídias da pasta">
            {assets.data.data.map((asset) => <MediaTile
              key={asset.id}
              clientId={clientId}
              folderId={folder.id}
              asset={asset}
              canOperate={canOperate}
              selected={asset.id === selected?.id}
              onSelect={() => setSelectedId(asset.id === selected?.id ? null : asset.id)}
            />)}
          </ul>
        </div>
        <Pagination
          page={assets.data.meta.page}
          totalPages={assets.data.meta.totalPages}
          onPageChange={goToPage}
          summary={`${assets.data.meta.totalItems} ${assets.data.meta.totalItems === 1 ? 'mídia' : 'mídias'}`}
        />
      </div>
      {selected !== undefined && <MediaDetail clientId={clientId} folder={folder} asset={selected} canOperate={canOperate} onClose={() => setSelectedId(null)} />}
    </div>;
  }

  const heading = <h3 id={`media-${folder.id}`}>Mídias</h3>;
  const empty = assets.data?.meta.totalItems === 0;
  return <section className="content-folders__section" aria-labelledby={`media-${folder.id}`}>
    {canOperate
      ? <MediaUploader
        clientId={clientId}
        folderId={folder.id}
        onUploaded={() => { goToPage(1); }}
        sizeLabel={sizeLabel}
        heading={heading}
        inputRef={picker}
        triggerHidden={empty}
      />
      : <div className="content-folders__heading">{heading}</div>}
    {body}
  </section>;
}

/**
 * The Folders view of a client's contents (`specs/conteudo.md` sections 3 and 7): the default and own folders, the work
 * folders inside one of them (two levels, never a third) and the media of the folder that is open, with direct upload and
 * removal. The folder is in the address (`pasta`, and `subpasta` one level down), so a reload lands on the same folder.
 * `canWrite` is false while the client is not known to be active: an archived client is read-only.
 */
export function ContentFolders({ clientId, canWrite }: { clientId: string; canWrite: boolean }) {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const canOperate = useCan('conteudo.operar') && canWrite;
  const blocked = useWriteBlocked();
  const [creating, setCreating] = useState(false);
  const folders = useClientFolders(clientId);

  const foldersFailed = folders.isError || (folders.isPending && folders.errorUpdateCount > 0);
  if (folders.isPending && !foldersFailed) {
    return <div className="content-folders__skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /><Skeleton /></div>;
  }
  if ((folders.isError && folders.data === undefined) || folders.isPending) {
    return <LoadError message="Não foi possível carregar as pastas. Tente de novo." retrying={folders.isFetching} onRetry={() => { void folders.refetch(); }} />;
  }

  const all = folders.data.folders;
  const pastaId = searchParams.get('pasta')?.toLowerCase() ?? null;
  const subId = searchParams.get('subpasta')?.toLowerCase() ?? null;
  const top = pastaId === null ? undefined : all.find((folder) => folder.id === pastaId && folder.parentId === null);
  const sub = subId === null || top === undefined ? undefined : all.find((folder) => folder.id === subId && folder.parentId === top.id);
  const missing = (pastaId !== null && top === undefined) || (subId !== null && sub === undefined);
  const firstLevel = all.filter((folder) => folder.parentId === null);
  const toRoot = hrefWith(searchParams, { pasta: null, subpasta: null, pagina: null });

  if (missing) {
    return <EmptyState
      className="content-folders__empty"
      headingLevel={3}
      title="Pasta não encontrada."
      action={<ButtonLink as={Link} to={toRoot} state={location.state} variant="secondary" leadingIcon={<Folder />}>Voltar às pastas</ButtonLink>}
    />;
  }

  const open = sub ?? top;
  const children = top === undefined ? [] : all.filter((folder) => folder.parentId === top.id);
  const truncated = folders.data.total > all.length;

  return <section className="content-folders" aria-label="Pastas do cliente">
    {top !== undefined && <nav aria-label="Caminho da pasta">
      <ol className="content-folders__path">
        <li><Link to={toRoot} state={location.state}>Pastas</Link></li>
        <li><Glyph><ChevronRight /></Glyph>{sub === undefined
          ? <span aria-current="page">{top.name}</span>
          : <Link to={hrefWith(searchParams, { subpasta: null, pagina: null })} state={location.state}>{top.name}</Link>}</li>
        {sub !== undefined && <li><Glyph><ChevronRight /></Glyph><span aria-current="page">{sub.name}</span></li>}
      </ol>
    </nav>}
    {open === undefined && <>
      <div className="content-folders__heading">
        <h3>Pastas</h3>
      </div>
      {firstLevel.length === 0
        ? <BlankStage src="/3d/new-folder.png">
          <EmptyState
            className="content-folders__empty"
            headingLevel={4}
            title={canOperate ? 'Nenhuma pasta ainda. Crie a primeira.' : 'Nenhuma pasta ainda.'}
            description={canOperate ? 'As pastas guardam as mídias deste cliente.' : undefined}
            action={canOperate ? <Button variant="secondary" leadingIcon={<FolderPlus />} blockedReason={blocked} onClick={() => setCreating(true)}>Nova pasta</Button> : undefined}
          />
        </BlankStage>
        : <FolderLinks
          folders={firstLevel}
          searchParams={searchParams}
          param="pasta"
          extra={{ subpasta: null }}
          newFolder={canOperate
            ? <Button className="content-folder content-folder--new" variant="ghost" leadingIcon={<Plus />} blockedReason={blocked} onClick={() => setCreating(true)}>Nova pasta</Button>
            : undefined}
        />}
    </>}
    {top !== undefined && sub === undefined && <>
      <FolderFeature
        name={top.name}
        action={canOperate && children.length > 0
          ? <Button variant="secondary" leadingIcon={<FolderPlus />} blockedReason={blocked} onClick={() => setCreating(true)}>Nova pasta de trabalho</Button>
          : undefined}
      />
      <section className="content-folders__section" aria-labelledby={`work-${top.id}`}>
        <h4 id={`work-${top.id}`}>Pastas de trabalho</h4>
        {children.length === 0
          ? <BlankStage src="/3d/new-folder.png">
            <EmptyState
              className="content-folders__empty"
              headingLevel={4}
              title="Nenhuma pasta de trabalho nesta pasta."
              description={canOperate ? 'Uma pasta de trabalho agrupa mídias dentro desta pasta.' : undefined}
              action={canOperate ? <Button variant="secondary" leadingIcon={<FolderPlus />} blockedReason={blocked} onClick={() => setCreating(true)}>Nova pasta de trabalho</Button> : undefined}
            />
          </BlankStage>
          : <FolderLinks folders={children} searchParams={searchParams} param="subpasta" />}
      </section>
    </>}
    {sub !== undefined && <FolderFeature name={sub.name} />}
    {truncated && <p className="content-folders__note">Mostrando {all.length} de {folders.data.total} pastas.</p>}
    {open !== undefined && <FolderMedia clientId={clientId} folder={open} canOperate={canOperate} />}
    {creating && <FolderCreateDialog clientId={clientId} parent={top ?? null} onClose={() => setCreating(false)} />}
  </section>;
}
