import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronRight, Folder, FolderPlus, Upload } from 'lucide-react';

import {
  MEDIA_FOLDER_NAME_MAX_LENGTH,
  MediaFolderNameSchema,
  MediaFolderSchema,
  type MediaFolderSummary,
  type MediaLibraryAsset
} from '@ageniza/contracts';
import { Button, ButtonLink, EmptyState, FieldMessage, Modal, SearchField, Select, Skeleton, Stage3D, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { HttpClientError, useApiClient } from './http.js';
import { LoadError, FilesSection, QuickFile } from './media-library-files.js';
import { BlankStage, FolderGrid, FolderMenu, hrefWith, InUseFolder } from './media-library-folders.js';
import { MediaDetail } from './media-library-detail.js';
import { useLibraryOps } from './media-library-actions.js';
import {
  apiReason, foldersBase, foldersQueryKey, isForbidden, LIBRARY_PAGE_SIZE, RECENT_PAGE_SIZE, sizeLabel, useFolderSummaries, useLibraryAssets
} from './media-library-model.js';
import { MediaUploader } from './media-uploader.js';

export { sizeLabel };

/** The first row of folders: the rest is behind "Ver todas". */
const FOLDERS_PREVIEW = 5;

const NO_PERMISSION = 'Você não tem permissão para fazer isso.';
const NAME_REQUIRED = 'Informe o nome da pasta.';
const NAME_TOO_LONG = `O nome pode ter até ${MEDIA_FOLDER_NAME_MAX_LENGTH} caracteres.`;
const NAME_INVALID = 'Use um nome sem caracteres invisíveis ou de controle.';
const CREATE_FAILED = 'Não foi possível criar a pasta. Tente de novo.';
const SEARCH_DELAY_MS = 300;

/** The icon of a line of text: it never names anything, the words beside it do. */
function Glyph({ children }: { children: ReactNode }) {
  return <span className="content-folders__glyph" aria-hidden="true">{children}</span>;
}

function FolderCreateDialog({ clientId, parent, onClose }: { clientId: string; parent: MediaFolderSummary | null; onClose: () => void }) {
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

/** The upload from the library's root, where no folder is open: the person says which folder first, and the dialog closes on the confirmed file. */
function UploadDialog({ clientId, folders, initialFolderId, onClose }: {
  clientId: string;
  folders: readonly MediaFolderSummary[];
  initialFolderId: string;
  onClose: () => void;
}) {
  const [folderId, setFolderId] = useState(initialFolderId);
  const picker = useRef<HTMLInputElement>(null);
  const options = folders.map((folder) => {
    const parent = folder.parentId === null ? undefined : folders.find((candidate) => candidate.id === folder.parentId);
    return { value: folder.id, label: parent === undefined ? folder.name : `${parent.name} / ${folder.name}` };
  });
  return <Modal title="Enviar arquivos" closeLabel="Fechar enviar arquivos" onClose={onClose}>
    <div className="form-stack">
      <Select label="Enviar para a pasta" value={folderId} options={options} onChange={setFolderId} />
      <MediaUploader clientId={clientId} folderId={folderId} onUploaded={onClose} sizeLabel={sizeLabel} inputRef={picker} library />
    </div>
  </Modal>;
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

const parsePage = (raw: string | null): number => {
  const page = Number(raw);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
};

/**
 * The media library of a client (`specs/conteudo.md` sections 3 and 7), as the board draws it: the quick access, the folders with what
 * they hold and the files sent recently, and the panel of the file that was chosen. A folder is in the address (`pasta`, and `subpasta`
 * one level down), and so are the search (`busca`), the page (`pagina`) and the full list (`todos`), so a reload lands on the same view.
 * `canWrite` is false while the client is not known to be active: an archived client is read-only.
 */
export function ContentFolders({ clientId, canWrite }: { clientId: string; canWrite: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const canOperate = useCan('conteudo.operar') && canWrite;
  const blocked = useWriteBlocked();
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | undefined>();
  const picker = useRef<HTMLInputElement>(null);
  const folders = useFolderSummaries(clientId);

  const all = folders.data?.folders ?? [];
  const pastaId = searchParams.get('pasta')?.toLowerCase() ?? null;
  const subId = searchParams.get('subpasta')?.toLowerCase() ?? null;
  const term = (searchParams.get('busca') ?? '').trim();
  const everything = searchParams.get('todos') === '1';
  const page = parsePage(searchParams.get('pagina'));
  const top = pastaId === null ? undefined : all.find((folder) => folder.id === pastaId && folder.parentId === null);
  const sub = subId === null || top === undefined ? undefined : all.find((folder) => folder.id === subId && folder.parentId === top.id);
  const missing = term === '' && ((pastaId !== null && top === undefined) || (subId !== null && sub === undefined));
  const open = term === '' ? sub ?? top : undefined;
  const mode = term !== '' ? 'search' : open !== undefined ? 'folder' : everything ? 'all' : 'recent';

  const [typed, setTyped] = useState(searchParams.get('busca') ?? '');
  const commitSearch = (value: string): void => {
    const next = value.trim();
    if (next === (searchParams.get('busca') ?? '').trim()) return;
    setSearchParams(new URLSearchParams(hrefWith(searchParams, { busca: next === '' ? null : next, pagina: null }).slice(1)), { replace: true });
  };
  useEffect(() => {
    const timer = setTimeout(() => commitSearch(typed), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const filter = mode === 'recent'
    ? { page: 1, pageSize: RECENT_PAGE_SIZE }
    : { page, pageSize: LIBRARY_PAGE_SIZE, ...(mode === 'search' ? { q: term } : {}), ...(open === undefined ? {} : { folderId: open.id }) };
  const assets = useLibraryAssets(clientId, filter, folders.isSuccess && !missing);

  const toRoot = hrefWith(searchParams, { pasta: null, subpasta: null, busca: null, pagina: null, todos: null });
  const goToPage = (next: number): void => {
    const params = new URLSearchParams(searchParams);
    if (next === 1) params.delete('pagina'); else params.set('pagina', String(next));
    setSearchParams(params);
  };

  const { assetOps, folderOps, dialogs } = useLibraryOps({
    clientId,
    folders: all,
    notify: setNotice,
    onAssetRemoved: (assetId) => { setSelectedId((current) => (current === assetId ? null : current)); },
    onFolderRemoved: (folderId) => {
      if (folderId === sub?.id) navigate(hrefWith(searchParams, { subpasta: null, pagina: null }), { state: location.state });
      else if (folderId === top?.id) navigate(toRoot, { state: location.state });
    }
  });

  const foldersFailed = folders.isError || (folders.isPending && folders.errorUpdateCount > 0);
  if (folders.isPending && !foldersFailed) {
    return <div className="content-folders__skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /><Skeleton /></div>;
  }
  if ((folders.isError && folders.data === undefined) || folders.isPending) {
    return <LoadError message="Não foi possível carregar as pastas. Tente de novo." retrying={folders.isFetching} onRetry={() => { void folders.refetch(); }} />;
  }

  const firstLevel = all.filter((folder) => folder.parentId === null);
  const children = top === undefined ? [] : all.filter((folder) => folder.parentId === top.id);
  const truncated = folders.data.total > all.length;
  const inUse = all.find((folder) => folder.inUseNow);
  const rows: readonly MediaLibraryAsset[] = assets.data?.data ?? [];
  const selected = selectedId === null ? undefined : rows.find((asset) => asset.id === selectedId);
  const select = (asset: MediaLibraryAsset): void => setSelectedId(asset.id);
  const quickFiles = mode === 'recent' ? rows.filter((asset) => asset.usageCount > 0).slice(0, 2) : [];

  const startUpload = (): void => {
    if (open !== undefined) picker.current?.click(); else setUploading(true);
  };

  if (missing) {
    return <EmptyState
      className="content-folders__empty"
      headingLevel={3}
      title="Pasta não encontrada."
      action={<ButtonLink as={Link} to={toRoot} state={location.state} variant="secondary" leadingIcon={<Folder />}>Voltar às pastas</ButtonLink>}
    />;
  }

  const fileEmpty = mode === 'search'
    ? <EmptyState
      className="content-folders__empty"
      headingLevel={4}
      title={`Nenhum arquivo encontrado para “${term}”.`}
      action={<Button variant="secondary" onClick={() => { setTyped(''); commitSearch(''); }}>Limpar busca</Button>}
    />
    : <BlankStage src="/3d/folder.png">
      <EmptyState
        className="content-folders__empty"
        headingLevel={4}
        title={mode === 'folder' ? 'Nenhum arquivo nesta pasta ainda.' : 'Nenhum arquivo enviado ainda.'}
        description={canOperate ? 'Envie fotos, vídeos, PDFs, áudios ou a logo do cliente.' : undefined}
        action={canOperate ? <Button variant="secondary" leadingIcon={<Upload />} blockedReason={blocked} onClick={startUpload}>Escolher arquivo</Button> : undefined}
      />
    </BlankStage>;

  const filesSection = (title: string, id: string, action?: ReactNode) => <section className="content-folders__section" aria-labelledby={id}>
    <div className="content-folders__heading">
      <h2 id={id}>{title}</h2>
      {action}
    </div>
    {mode === 'folder' && open !== undefined && canOperate && <MediaUploader clientId={clientId} folderId={open.id} onUploaded={() => { goToPage(1); }} sizeLabel={sizeLabel} inputRef={picker} triggerHidden library />}
    <FilesSection
      query={assets}
      empty={fileEmpty}
      tableLabel={title}
      selectedId={selected?.id ?? null}
      canOperate={canOperate}
      ops={assetOps}
      onSelect={select}
      {...(mode === 'recent' ? {} : { paging: { onPageChange: goToPage } })}
    />
  </section>;

  const path = (parts: { label: string; to?: string }[]) => <nav aria-label="Caminho da pasta">
    <ol className="content-folders__path">
      {parts.map((part, index) => <li key={part.label}>
        {index > 0 && <Glyph><ChevronRight /></Glyph>}
        {part.to === undefined ? <span aria-current="page">{part.label}</span> : <Link to={part.to} state={location.state}>{part.label}</Link>}
      </li>)}
    </ol>
  </nav>;

  let main;
  if (mode === 'search') {
    main = <>
      {path([{ label: 'Pastas', to: toRoot }, { label: `Resultados para “${term}”` }])}
      {filesSection('Resultados da busca', 'media-files')}
    </>;
  } else if (mode === 'all') {
    main = <>
      {path([{ label: 'Pastas', to: toRoot }, { label: 'Todos os arquivos' }])}
      {filesSection('Todos os arquivos', 'media-files')}
    </>;
  } else if (open !== undefined) {
    const parts = [{ label: 'Pastas', to: toRoot }, ...(sub === undefined || top === undefined
      ? [{ label: open.name }]
      : [{ label: top.name, to: hrefWith(searchParams, { subpasta: null, pagina: null }) }, { label: sub.name }])];
    main = <>
      {path(parts)}
      <FolderFeature
        name={open.name}
        action={<div className="content-folders__feature-actions">
          {top !== undefined && sub === undefined && canOperate && children.length > 0 && <Button variant="secondary" leadingIcon={<FolderPlus />} blockedReason={blocked} onClick={() => setCreating(true)}>Nova pasta de trabalho</Button>}
          <FolderMenu folder={open} canOperate={canOperate} ops={folderOps} />
        </div>}
      />
      {top !== undefined && sub === undefined && <section className="content-folders__section" aria-labelledby={`work-${top.id}`}>
        <h2 id={`work-${top.id}`}>Pastas de trabalho</h2>
        {children.length === 0
          ? <BlankStage src="/3d/new-folder.png">
            <EmptyState
              className="content-folders__empty"
              headingLevel={4}
              title="Nenhuma pasta de trabalho nesta pasta."
              description={canOperate ? 'Uma pasta de trabalho agrupa arquivos dentro desta pasta.' : undefined}
              action={canOperate ? <Button variant="secondary" leadingIcon={<FolderPlus />} blockedReason={blocked} onClick={() => setCreating(true)}>Nova pasta de trabalho</Button> : undefined}
            />
          </BlankStage>
          : <FolderGrid folders={children} searchParams={searchParams} canOperate={canOperate} ops={folderOps} />}
      </section>}
      {filesSection('Arquivos', 'media-files')}
    </>;
  } else {
    const shown = showAllFolders ? firstLevel : firstLevel.slice(0, FOLDERS_PREVIEW);
    const hasMoreFolders = firstLevel.length > FOLDERS_PREVIEW;
    main = <>
      {(inUse !== undefined || quickFiles.length > 0) && <section className="content-folders__section" aria-labelledby="media-quick">
        <div className="content-folders__heading"><h2 id="media-quick">Acesso rápido</h2></div>
        <div className="quick">
          {inUse !== undefined && <InUseFolder folder={inUse} searchParams={searchParams} />}
          {quickFiles.map((asset) => <QuickFile key={asset.id} clientId={clientId} asset={asset} onSelect={select} />)}
        </div>
      </section>}
      <section className="content-folders__section" aria-labelledby="media-folders">
        <div className="content-folders__heading">
          <div>
            <h2 id="media-folders">Pastas</h2>
            <p className="content-folders__sub">Cada pasta diz o que guarda.</p>
          </div>
          {hasMoreFolders && <Button variant="ghost" size="sm" trailingIcon={<ArrowRight />} aria-expanded={showAllFolders} onClick={() => setShowAllFolders((current) => !current)}>{showAllFolders ? 'Ver menos' : 'Ver todas'}</Button>}
        </div>
        {firstLevel.length === 0
          ? <BlankStage src="/3d/new-folder.png">
            <EmptyState
              className="content-folders__empty"
              headingLevel={4}
              title={canOperate ? 'Nenhuma pasta ainda. Crie a primeira.' : 'Nenhuma pasta ainda.'}
              description={canOperate ? 'As pastas guardam os arquivos deste cliente.' : undefined}
              action={canOperate ? <Button variant="secondary" leadingIcon={<FolderPlus />} blockedReason={blocked} onClick={() => setCreating(true)}>Nova pasta</Button> : undefined}
            />
          </BlankStage>
          : <FolderGrid folders={shown} searchParams={searchParams} canOperate={canOperate} ops={folderOps} onCreate={canOperate ? () => setCreating(true) : undefined} />}
      </section>
      {filesSection('Enviados recentemente', 'media-files', assets.data !== undefined && assets.data.meta.totalItems > RECENT_PAGE_SIZE
        ? <ButtonLink as={Link} variant="ghost" size="sm" trailingIcon={<ArrowRight />} to={hrefWith(searchParams, { todos: '1', pagina: null })} state={location.state}>Ver todos</ButtonLink>
        : undefined)}
    </>;
  }

  return <section className="content-folders" aria-label="Biblioteca de mídia">
    <div className="media-toolbar">
      <SearchField label="Buscar nesta biblioteca" placeholder="Buscar nesta biblioteca" value={typed} onChange={setTyped} onSearch={commitSearch} className="media-toolbar__search" />
      {canOperate && all.length > 0 && <Button leadingIcon={<Upload />} blockedReason={blocked} onClick={startUpload}>Enviar arquivos</Button>}
    </div>
    {notice !== undefined && <FieldMessage role="alert">{notice}</FieldMessage>}
    <div className={`media-layout${selected === undefined ? '' : ' media-layout--detail'}`}>
      <div className="media-layout__main">
        {main}
        {truncated && <p className="content-folders__note">Mostrando {all.length} de {folders.data.total} pastas.</p>}
      </div>
      {selected !== undefined && <MediaDetail clientId={clientId} asset={selected} canOperate={canOperate} ops={assetOps} onClose={() => setSelectedId(null)} />}
    </div>
    {creating && <FolderCreateDialog clientId={clientId} parent={top ?? null} onClose={() => setCreating(false)} />}
    {uploading && <UploadDialog clientId={clientId} folders={all} initialFolderId={(inUse ?? firstLevel[0] ?? all[0])!.id} onClose={() => setUploading(false)} />}
    {dialogs}
  </section>;
}
