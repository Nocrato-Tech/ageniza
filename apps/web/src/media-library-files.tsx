import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

import type { MediaLibraryAsset } from '@ageniza/contracts';
import { Button, EmptyState, Pagination, Skeleton, StatusTag } from '@ageniza/ui';

import { STATUS_LABELS, STATUS_TAGS } from './content-labels.js';
import type { AssetOps } from './media-library-actions.js';
import { assetName, sizeLabel, usageLabel, useAssetUsage } from './media-library-model.js';
import { MediaTable } from './media-library-table.js';
import { MediaThumbnail } from './media-thumbnail.js';

type LibraryList = { data: readonly MediaLibraryAsset[]; meta: { page: number; totalPages: number; totalItems: number } };

/** The failure of a read: the serious owl, what did not load, and the way out. */
export function LoadError({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return <EmptyState kind="failure" mascot className="content-folders__empty" headingLevel={4} title={message} retrying={retrying} onRetry={onRetry} />;
}

/** One of the files in use, in the quick access: where it is used and the state of the content that holds it. */
export function QuickFile({ clientId, asset, onSelect }: { clientId: string; asset: MediaLibraryAsset; onSelect: (asset: MediaLibraryAsset) => void }) {
  const usage = useAssetUsage(clientId, asset.id);
  const first = usage.data?.data[0];
  return <button type="button" className="quick__file" onClick={() => onSelect(asset)}>
    <span className={`quick__thumb media-table__thumb--${asset.category}`}><MediaThumbnail assetId={asset.id} category={asset.category} /></span>
    <span className="quick__file-text">
      <span className="quick__file-name">{assetName(asset)}</span>{' '}
      <span className="quick__file-size">{sizeLabel(asset.sizeBytes)}</span>
    </span>{' '}
    <span className="quick__file-meta">
      <span className="quick__file-usage">Usado em {usageLabel(asset.usageCount)}</span>{' '}
      {first !== undefined && <StatusTag status={STATUS_TAGS[first.status]}>{STATUS_LABELS[first.status]}</StatusTag>}
    </span>
  </button>;
}

/**
 * The files of one view (the recent ones, a folder, a search) as a table in its states: a skeleton on the first read, a failure that
 * retries, the empty state the view brings, a page past the end, and the table with its pagination when the view pages.
 */
export function FilesSection({ query, empty, tableLabel, selectedId, canOperate, ops, onSelect, paging }: {
  query: UseQueryResult<LibraryList>;
  empty: ReactNode;
  tableLabel: string;
  selectedId: string | null;
  canOperate: boolean;
  ops: AssetOps;
  onSelect: (asset: MediaLibraryAsset) => void;
  paging?: { onPageChange: (page: number) => void };
}) {
  // A retry keeps the failure and its busy button (and the focus) in place: only the first read is a skeleton.
  const failed = query.isError || (query.isPending && query.errorUpdateCount > 0);
  if (query.isPending && !failed) {
    return <div className="media-files__skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>;
  }
  if ((query.isError && query.data === undefined) || query.isPending) {
    return <LoadError message="Não foi possível carregar os arquivos. Tente de novo." retrying={query.isFetching} onRetry={() => { void query.refetch(); }} />;
  }
  const { data: rows, meta } = query.data;
  if (meta.totalItems === 0) return <>{empty}</>;
  if (rows.length === 0 && paging !== undefined) {
    return <EmptyState
      className="content-folders__empty"
      headingLevel={4}
      title="Esta página não tem arquivos."
      action={<Button variant="secondary" onClick={() => paging.onPageChange(meta.totalPages)}>Ir para a última página</Button>}
    />;
  }
  return <div className="media-files">
    <MediaTable label={tableLabel} assets={rows} selectedId={selectedId} canOperate={canOperate} ops={ops} onSelect={onSelect} />
    {paging !== undefined && <Pagination
      page={meta.page}
      totalPages={meta.totalPages}
      onPageChange={paging.onPageChange}
      summary={`${meta.totalItems} ${meta.totalItems === 1 ? 'arquivo' : 'arquivos'}`}
    />}
  </div>;
}
