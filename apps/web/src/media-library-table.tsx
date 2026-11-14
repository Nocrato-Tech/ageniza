import { Download, EllipsisVertical, FolderInput, PanelRight, Pencil, Trash2 } from 'lucide-react';

import type { MediaLibraryAsset } from '@ageniza/contracts';
import { Menu, MenuItem, MenuSeparator, Table } from '@ageniza/ui';

import { useWriteBlocked } from './agency.js';
import type { AssetOps } from './media-library-actions.js';
import { assetName, TYPE_LABELS, usageLabel, whenLabel } from './media-library-model.js';
import { MediaThumbnail } from './media-thumbnail.js';

const PROCESSING_NOTES: Readonly<Record<MediaLibraryAsset['videoProcessingStatus'], string | undefined>> = {
  not_applicable: undefined, pending: 'Processando', processing: 'Processando', ready: undefined, failed: 'Falhou'
};

function AssetMenu({ asset, canOperate, ops, onOpen }: { asset: MediaLibraryAsset; canOperate: boolean; ops: AssetOps; onOpen: (asset: MediaLibraryAsset) => void }) {
  const blocked = useWriteBlocked();
  const label = `Ações de ${assetName(asset)}`;
  return <Menu label={label} triggerLabel={label} trigger={<EllipsisVertical aria-hidden="true" />}>
    <MenuItem icon={<PanelRight />} onClick={() => onOpen(asset)}>Abrir</MenuItem>
    <MenuItem icon={<Download />} onClick={() => ops.download(asset)}>Baixar</MenuItem>
    {canOperate && <>
      <MenuItem icon={<FolderInput />} disabled={blocked !== undefined} onClick={() => ops.move(asset)}>Mover para</MenuItem>
      <MenuItem icon={<Pencil />} disabled={blocked !== undefined} onClick={() => ops.rename(asset)}>Renomear</MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Trash2 />} variant="destructive" disabled={blocked !== undefined} onClick={() => ops.remove(asset)}>Excluir</MenuItem>
    </>}
  </Menu>;
}

/** The files of the library as a table: the name chooses the row, and the menu of the last cell holds what a row can do. */
export function MediaTable({ label, assets, selectedId, canOperate, ops, onSelect }: {
  label: string;
  assets: readonly MediaLibraryAsset[];
  selectedId: string | null;
  canOperate: boolean;
  ops: AssetOps;
  onSelect: (asset: MediaLibraryAsset) => void;
}) {
  return <Table<MediaLibraryAsset>
    label={label}
    className="media-table"
    rows={assets}
    rowKey={(asset) => asset.id}
    selectedKey={selectedId}
    onSelect={onSelect}
    columns={[
      {
        key: 'name',
        header: 'Nome',
        width: 'minmax(0, 2.6fr)',
        render: (asset) => <span className="media-table__name">
          <span className={`media-table__thumb media-table__thumb--${asset.category}`}><MediaThumbnail assetId={asset.id} category={asset.category} /></span>
          <span className="media-table__label">{assetName(asset)}</span>
        </span>
      },
      {
        key: 'type',
        header: 'Tipo',
        width: '5.5rem',
        render: (asset) => {
          const note = asset.category === 'video' ? PROCESSING_NOTES[asset.videoProcessingStatus] : undefined;
          return <span className="media-table__type">{TYPE_LABELS[asset.category]}{note !== undefined && <span className="media-table__note">{note}</span>}</span>;
        }
      },
      { key: 'usage', header: 'Usado em', width: 'minmax(0, 1.4fr)', render: (asset) => usageLabel(asset.usageCount) },
      { key: 'when', header: 'Quando', width: '8rem', keepOnPhone: true, render: (asset) => whenLabel(asset.createdAt) }
    ]}
    actionsLabel="Ações do arquivo"
    actions={(asset) => <AssetMenu asset={asset} canOperate={canOperate} ops={ops} onOpen={onSelect} />}
  />;
}
