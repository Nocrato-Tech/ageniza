import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, EllipsisVertical, FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';

import type { MediaFolderSummary } from '@ageniza/contracts';
import { AvatarGroup, Menu, MenuItem, MenuSeparator, Pill, Stage3D } from '@ageniza/ui';

import { useWriteBlocked } from './agency.js';
import type { FolderOps } from './media-library-actions.js';
import { fileCountLabel, folderCountsLabel, sizeLabel, updatedLabel } from './media-library-model.js';

export const hrefWith = (searchParams: URLSearchParams, changes: Readonly<Record<string, string | null>>): string => {
  const next = new URLSearchParams(searchParams);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) next.delete(name); else next.set(name, value);
  }
  return `?${next.toString()}`;
};

/** Where a folder opens: a first-level folder is `pasta`, a work folder is `subpasta` inside its parent. Search and page do not follow. */
export const folderHref = (searchParams: URLSearchParams, folder: MediaFolderSummary): string =>
  hrefWith(searchParams, folder.parentId === null
    ? { pasta: folder.id, subpasta: null, busca: null, pagina: null, todos: null }
    : { pasta: folder.parentId, subpasta: folder.id, busca: null, pagina: null, todos: null });

export function FolderMenu({ folder, canOperate, ops, to }: { folder: MediaFolderSummary; canOperate: boolean; ops: FolderOps; to?: string }) {
  const blocked = useWriteBlocked();
  const navigate = useNavigate();
  const location = useLocation();
  const label = `Ações da pasta ${folder.name}`;
  const editable = canOperate && !folder.isDefault;
  if (to === undefined && !editable) return null;
  return <Menu label={label} triggerLabel={label} trigger={<EllipsisVertical aria-hidden="true" />}>
    {to !== undefined && <MenuItem icon={<FolderOpen />} onClick={() => navigate(to, { state: location.state })}>Abrir</MenuItem>}
    {editable && <>
      <MenuItem icon={<Pencil />} disabled={blocked !== undefined} onClick={() => ops.rename(folder)}>Renomear</MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Trash2 />} variant="destructive" disabled={blocked !== undefined} onClick={() => ops.remove(folder)}>Excluir</MenuItem>
    </>}
  </Menu>;
}

function FolderCard({ folder, searchParams, canOperate, ops }: { folder: MediaFolderSummary; searchParams: URLSearchParams; canOperate: boolean; ops: FolderOps }) {
  const location = useLocation();
  const to = folderHref(searchParams, folder);
  return <li className="folder" data-stage-host>
    <div className="folder__top">
      <Stage3D className="folder__stage" src={folder.isDefault ? '/3d/fav-folder.png' : '/3d/folder.png'} tone={folder.isDefault ? 'indigo' : 'sky'} size="sm" />
      <FolderMenu folder={folder} canOperate={canOperate} ops={ops} to={to} />
    </div>
    <Link className="folder__link" to={to} state={location.state}>
      <span className="folder__head"><span className="folder__name">{folder.name}</span>{folder.isDefault && <> <Pill>Padrão</Pill></>}</span>{' '}
      <span className="folder__meta"><span>{folderCountsLabel(folder)}</span>{folder.assetCount > 0 && <> <span>{sizeLabel(folder.totalSizeBytes)}</span></>}</span>
    </Link>
  </li>;
}

/** The folder cards of a level, with "Nova pasta" as the dashed card that closes the grid for whoever can create one. */
export function FolderGrid({ folders, searchParams, canOperate, ops, onCreate }: {
  folders: readonly MediaFolderSummary[];
  searchParams: URLSearchParams;
  canOperate: boolean;
  ops: FolderOps;
  onCreate?: (() => void) | undefined;
}) {
  const blocked = useWriteBlocked();
  return <ul className="folders">
    {folders.map((folder) => <FolderCard key={folder.id} folder={folder} searchParams={searchParams} canOperate={canOperate} ops={ops} />)}
    {onCreate !== undefined && <li className="folders__new">
      <button type="button" className="folder folder--new" disabled={blocked !== undefined} title={blocked} onClick={onCreate}>
        <span className="plus" aria-hidden="true"><Plus /></span>
        <span className="folder__new-label">Nova pasta</span>
      </button>
    </li>}
  </ul>;
}

/** "Pasta em uso agora": the folder the API says was written most recently, as the feature block of the quick access. */
export function InUseFolder({ folder, searchParams }: { folder: MediaFolderSummary; searchParams: URLSearchParams }) {
  const location = useLocation();
  return <Link className="quick__feature" to={folderHref(searchParams, folder)} state={location.state} data-stage-host>
    <Stage3D className="quick__stage" src="/3d/fav-folder.png" tone="indigo" size="md" breakout />
    <span className="quick__feature-text">
      <span className="quick__eyebrow">Pasta em uso agora</span>{' '}
      <span className="quick__feature-name">{folder.name}</span>{' '}
      <span className="quick__feature-meta">{fileCountLabel(folder.assetCount)} · {sizeLabel(folder.totalSizeBytes)} · {updatedLabel(folder.lastChangedAt)}</span>
    </span>
    <span className="quick__feature-foot">
      {folder.lastUploadedBy !== null && <AvatarGroup people={[{ name: folder.lastUploadedBy.name }]} label="Enviado por" />}
      <span className="quick__cta">Abrir a pasta<ArrowRight aria-hidden="true" /></span>
    </span>
  </Link>;
}

/** The empty states of the library: the folder on its stage above the sentence, in one dashed block. */
export function BlankStage({ src, children }: { src: string; children: ReactNode }) {
  return <div className="content-folders__blank" data-stage-host>
    <Stage3D src={src} tone="sky" size="md" />
    {children}
  </div>;
}
