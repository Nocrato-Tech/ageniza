import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ChevronRight, CircleAlert, Download, Folder, FolderPlus, Image as ImageIcon, LoaderCircle, RotateCcw, Trash2, Upload, Video } from 'lucide-react';
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
import { Button, ButtonLink, ConfirmDialog, EmptyState, FieldMessage, Modal, Pagination, Pill, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
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

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="content-folders__error" role="alert">
    <p><Glyph><CircleAlert /></Glyph>{message}</p>
    <Button variant="secondary" leadingIcon={<RotateCcw />} onClick={onRetry}>Tentar de novo</Button>
  </div>;
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

function FolderLinks({ folders, searchParams, param, extra }: {
  folders: readonly MediaFolder[];
  searchParams: URLSearchParams;
  param: 'pasta' | 'subpasta';
  extra?: Readonly<Record<string, string | null>>;
}) {
  const location = useLocation();
  return <ul className="content-folders__list">
    {folders.map((folder) => <li key={folder.id}>
      <Link
        className="content-folder"
        to={hrefWith(searchParams, { ...extra, [param]: folder.id, pagina: null })}
        state={location.state}
      >
        <span className="content-folder__icon" aria-hidden="true"><Folder /></span>
        <span className="content-folder__name">{folder.name}</span>
        {folder.isDefault && <Pill>Padrão</Pill>}
        <span className="content-folder__chevron" aria-hidden="true"><ChevronRight /></span>
      </Link>
    </li>)}
  </ul>;
}

function MediaTile({ clientId, folderId, asset, canOperate }: { clientId: string; folderId: string; asset: MediaFolderAsset; canOperate: boolean }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const label = `${CATEGORY_LABELS[asset.category]} de ${dateFormat.format(new Date(asset.createdAt))}, ${sizeLabel(asset.sizeBytes)}`;

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

  const processing = asset.category === 'video' && (asset.videoProcessingStatus === 'pending' || asset.videoProcessingStatus === 'processing');
  const processingFailed = asset.category === 'video' && asset.videoProcessingStatus === 'failed';
  return <li className="folder-media">
    <MediaThumbnail assetId={asset.id} category={asset.category} />
    <div className="folder-media__body">
      <p className="folder-media__title"><Glyph>{CATEGORY_ICONS[asset.category]}</Glyph>{CATEGORY_LABELS[asset.category]}</p>
      <p className="folder-media__meta">{dateFormat.format(new Date(asset.createdAt))} · {sizeLabel(asset.sizeBytes)}</p>
      {processing && <Pill icon={<LoaderCircle />}>Processando vídeo</Pill>}
      {processingFailed && <p className="folder-media__failure"><Glyph><CircleAlert /></Glyph>Falha no processamento do vídeo</p>}
    </div>
    <div className="folder-media__actions">
      <Button size="sm" variant="secondary" leadingIcon={<Download />} aria-label={`Baixar ${label}`} loading={download.isPending} onClick={() => { setNotice(undefined); download.mutate(); }}>Baixar</Button>
      {canOperate && <Button size="sm" variant="ghost" leadingIcon={<Trash2 />} aria-label={`Remover ${label}`} onClick={() => { setNotice(undefined); setConfirming(true); }}>Remover</Button>}
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
  </li>;
}

const parsePage = (raw: string | null): number => {
  const page = Number(raw);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
};

function FolderMedia({ clientId, folder, canOperate }: { clientId: string; folder: MediaFolder; canOperate: boolean }) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parsePage(searchParams.get('pagina'));
  const picker = useRef<HTMLInputElement>(null);

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

  let body;
  if (assets.isPending) {
    body = <ul className="folder-media__grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_value, index) => <li key={index}><Skeleton className="folder-media__skeleton" /></li>)}
    </ul>;
  } else if (assets.isError && assets.data === undefined) {
    body = <LoadError message="Não foi possível carregar as mídias. Tente de novo." onRetry={() => { void assets.refetch(); }} />;
  } else if (assets.data.meta.totalItems === 0) {
    body = <EmptyState
      className="content-folders__empty"
      headingLevel={4}
      title="Nenhuma mídia nesta pasta ainda."
      description={canOperate ? 'Envie imagens ou vídeos para esta pasta.' : undefined}
      action={canOperate ? <Button variant="secondary" leadingIcon={<Upload />} onClick={() => picker.current?.click()}>Enviar mídia</Button> : undefined}
    />;
  } else if (assets.data.data.length === 0) {
    body = <EmptyState
      className="content-folders__empty"
      headingLevel={4}
      title="Esta página não tem mídias."
      action={<Button variant="secondary" onClick={() => goToPage(assets.data.meta.totalPages)}>Ir para a última página</Button>}
    />;
  } else {
    body = <>
      <ul className="folder-media__grid" aria-label="Mídias da pasta">
        {assets.data.data.map((asset) => <MediaTile key={asset.id} clientId={clientId} folderId={folder.id} asset={asset} canOperate={canOperate} />)}
      </ul>
      <Pagination
        page={assets.data.meta.page}
        totalPages={assets.data.meta.totalPages}
        onPageChange={goToPage}
        summary={`${assets.data.meta.totalItems} ${assets.data.meta.totalItems === 1 ? 'mídia' : 'mídias'}`}
      />
    </>;
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
  const [creating, setCreating] = useState(false);
  const folders = useClientFolders(clientId);

  if (folders.isPending) {
    return <div className="content-folders__skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /><Skeleton /></div>;
  }
  if (folders.isError && folders.data === undefined) {
    return <LoadError message="Não foi possível carregar as pastas. Tente de novo." onRetry={() => { void folders.refetch(); }} />;
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
        {canOperate && firstLevel.length > 0 && <Button variant="secondary" leadingIcon={<FolderPlus />} onClick={() => setCreating(true)}>Nova pasta</Button>}
      </div>
      {firstLevel.length === 0
        ? <EmptyState
          className="content-folders__empty"
          headingLevel={4}
          title={canOperate ? 'Nenhuma pasta ainda. Crie a primeira.' : 'Nenhuma pasta ainda.'}
          description={canOperate ? 'As pastas guardam as mídias deste cliente.' : undefined}
          action={canOperate ? <Button variant="secondary" leadingIcon={<FolderPlus />} onClick={() => setCreating(true)}>Nova pasta</Button> : undefined}
        />
        : <FolderLinks folders={firstLevel} searchParams={searchParams} param="pasta" extra={{ subpasta: null }} />}
    </>}
    {top !== undefined && sub === undefined && <>
      <div className="content-folders__heading">
        <h3>{top.name}</h3>
        {canOperate && children.length > 0 && <Button variant="secondary" leadingIcon={<FolderPlus />} onClick={() => setCreating(true)}>Nova pasta de trabalho</Button>}
      </div>
      <section className="content-folders__section" aria-labelledby={`work-${top.id}`}>
        <h4 id={`work-${top.id}`}>Pastas de trabalho</h4>
        {children.length === 0
          ? <EmptyState
            className="content-folders__empty"
            headingLevel={4}
            title="Nenhuma pasta de trabalho nesta pasta."
            description={canOperate ? 'Uma pasta de trabalho agrupa mídias dentro desta pasta.' : undefined}
            action={canOperate ? <Button variant="secondary" leadingIcon={<FolderPlus />} onClick={() => setCreating(true)}>Nova pasta de trabalho</Button> : undefined}
          />
          : <FolderLinks folders={children} searchParams={searchParams} param="subpasta" />}
      </section>
    </>}
    {sub !== undefined && <div className="content-folders__heading"><h3>{sub.name}</h3></div>}
    {truncated && <p className="content-folders__note">Mostrando {all.length} de {folders.data.total} pastas.</p>}
    {open !== undefined && <FolderMedia clientId={clientId} folder={open} canOperate={canOperate} />}
    {creating && <FolderCreateDialog clientId={clientId} parent={top ?? null} onClose={() => setCreating(false)} />}
  </section>;
}
