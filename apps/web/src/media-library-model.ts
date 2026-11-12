import { useQuery } from '@tanstack/react-query';

import {
  MediaFolderSummaryListResponseSchema,
  MediaLibraryListResponseSchema,
  MediaUsageListResponseSchema,
  type MediaFolderSummary,
  type MediaLibraryAsset,
  type MediaLibraryCategory
} from '@ageniza/contracts';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';

/** The folders are read page by page until the last, so no folder is hidden behind a page. */
const FOLDERS_PAGE_SIZE = 100;
const MAX_FOLDER_PAGES = 10;
export const LIBRARY_PAGE_SIZE = 20;
export const RECENT_PAGE_SIZE = 5;

export const TYPE_LABELS: Readonly<Record<MediaLibraryCategory, string>> = { image: 'Foto', video: 'Vídeo', pdf: 'PDF', audio: 'Áudio', logo: 'Logo' };

const COUNT_LABELS: Readonly<Record<MediaLibraryCategory, readonly [string, string]>> = {
  image: ['foto', 'fotos'], video: ['vídeo', 'vídeos'], pdf: ['PDF', 'PDFs'], audio: ['áudio', 'áudios'], logo: ['logo', 'logos']
};

const sizeFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const ZONE = 'America/Sao_Paulo';
const partsFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });

export const sizeLabel = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${sizeFormat.format(bytes / (1024 * 1024))} MB`;
  return `${sizeFormat.format(bytes / (1024 * 1024 * 1024))} GB`;
};

interface Moment { readonly year: number; readonly month: string; readonly day: number; readonly hour: number; readonly minute: string }

const momentOf = (iso: string): Moment => {
  const parts = Object.fromEntries(partsFormat.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: (parts.month ?? '').replace('.', ''), day: Number(parts.day), hour: Number(parts.hour), minute: parts.minute ?? '00' };
};

const dayKey = (moment: Moment): string => `${moment.year}-${moment.month}-${moment.day}`;
const hourLabel = (moment: Moment): string => `${moment.hour}h${moment.minute}`;

/** "Hoje" and "Ontem" are read in São Paulo, where the agency lives, never in the zone of the browser. */
const relativeDay = (iso: string, now: Date): 'today' | 'yesterday' | null => {
  const moment = dayKey(momentOf(iso));
  if (moment === dayKey(momentOf(now.toISOString()))) return 'today';
  if (moment === dayKey(momentOf(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()))) return 'yesterday';
  return null;
};

const shortDay = (moment: Moment, now: Date): string =>
  `${moment.day} ${moment.month}${moment.year === momentOf(now.toISOString()).year ? '' : ` ${moment.year}`}`;

/** The column "Quando": "Hoje, 9h12", "10 nov, 16h40". */
export const whenLabel = (iso: string, now: Date = new Date()): string => {
  const moment = momentOf(iso);
  const relative = relativeDay(iso, now);
  const day = relative === 'today' ? 'Hoje' : relative === 'yesterday' ? 'Ontem' : shortDay(moment, now);
  return `${day}, ${hourLabel(moment)}`;
};

/** The row "Em" of the panel: "11 nov 2026, 9h12". */
export const fullWhenLabel = (iso: string): string => {
  const moment = momentOf(iso);
  return `${moment.day} ${moment.month} ${moment.year}, ${hourLabel(moment)}`;
};

/** "enviada hoje", "enviada ontem", "enviada em 10 nov". */
export const sentLabel = (iso: string, now: Date = new Date()): string => {
  const relative = relativeDay(iso, now);
  return relative === 'today' ? 'enviada hoje' : relative === 'yesterday' ? 'enviada ontem' : `enviada em ${shortDay(momentOf(iso), now)}`;
};

export const updatedLabel = (iso: string, now: Date = new Date()): string => {
  const relative = relativeDay(iso, now);
  return relative === 'today' ? 'atualizada hoje' : relative === 'yesterday' ? 'atualizada ontem' : `atualizada em ${shortDay(momentOf(iso), now)}`;
};

export const fileCountLabel = (count: number): string => `${count} ${count === 1 ? 'arquivo' : 'arquivos'}`;

/** What a folder holds, in the words of its type when it holds only one ("96 fotos"), and "N arquivos" when it mixes. */
export const folderCountsLabel = (folder: MediaFolderSummary): string => {
  if (folder.assetCount === 0) return 'Vazia';
  const present = (Object.keys(COUNT_LABELS) as MediaLibraryCategory[]).filter((category) => folder.counts[category] > 0);
  const only = present.length === 1 ? present[0]! : undefined;
  return only === undefined ? fileCountLabel(folder.assetCount) : `${folder.assetCount} ${COUNT_LABELS[only][folder.assetCount === 1 ? 0 : 1]}`;
};

export const usageLabel = (count: number): string => (count === 0 ? 'Ainda não usado' : `${count} ${count === 1 ? 'post' : 'posts'}`);

/** A media uploaded before names were kept shows the label of its type and its day. */
export const assetName = (asset: Pick<MediaLibraryAsset, 'name' | 'category' | 'createdAt'>): string =>
  asset.name ?? `${TYPE_LABELS[asset.category]} de ${shortDay(momentOf(asset.createdAt), new Date())}`;

export const dimensionsLabel = (asset: Pick<MediaLibraryAsset, 'width' | 'height'>): string =>
  asset.width === null || asset.height === null ? '—' : `${asset.width} × ${asset.height}`;

export const foldersQueryKey = (agencyId: string, clientId: string): readonly unknown[] => ['agency', agencyId, 'media-folders', clientId];
export const libraryQueryKey = (agencyId: string, clientId: string): readonly unknown[] => ['agency', agencyId, 'media-library', clientId];

const clientBase = (agencyId: string, clientId: string): string => apiPath('/agencies/:agencyId/clients/:clientId', { agencyId, clientId });
export const foldersBase = (agencyId: string, clientId: string): string => `${clientBase(agencyId, clientId)}/media-folders`;
export const mediaBase = (agencyId: string, clientId: string): string => `${clientBase(agencyId, clientId)}/media`;

export interface FolderList {
  readonly folders: readonly MediaFolderSummary[];
  readonly total: number;
}

export const useFolderSummaries = (clientId: string) => {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  return useQuery<FolderList>({
    queryKey: foldersQueryKey(agency.agencyId, clientId),
    queryFn: async ({ signal }) => {
      const folders: MediaFolderSummary[] = [];
      let total = 0;
      for (let page = 1; page <= MAX_FOLDER_PAGES; page += 1) {
        const answer = await httpClient.request({
          path: `${foldersBase(agency.agencyId, clientId)}/summary?page=${page}&pageSize=${FOLDERS_PAGE_SIZE}`,
          response: MediaFolderSummaryListResponseSchema,
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

export interface LibraryFilter {
  readonly page: number;
  readonly pageSize: number;
  readonly q?: string;
  readonly folderId?: string;
}

export const useLibraryAssets = (clientId: string, filter: LibraryFilter, enabled = true) => {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  return useQuery({
    queryKey: [...libraryQueryKey(agency.agencyId, clientId), filter],
    enabled,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ page: String(filter.page), pageSize: String(filter.pageSize) });
      if (filter.q !== undefined && filter.q !== '') params.set('q', filter.q);
      if (filter.folderId !== undefined) params.set('folderId', filter.folderId);
      return httpClient.request({ path: `${mediaBase(agency.agencyId, clientId)}?${params.toString()}`, response: MediaLibraryListResponseSchema, signal });
    }
  });
};

export const useAssetUsage = (clientId: string, assetId: string, enabled = true) => {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  return useQuery({
    queryKey: [...libraryQueryKey(agency.agencyId, clientId), 'usage', assetId],
    enabled,
    queryFn: ({ signal }) => httpClient.request({
      path: `${mediaBase(agency.agencyId, clientId)}/${encodeURIComponent(assetId)}/usage?page=1&pageSize=20`,
      response: MediaUsageListResponseSchema,
      signal
    })
  });
};

/** A refusal the API words itself, in Portuguese, is shown as it is; any other text of the API is not the screen's to repeat. */
export const apiReason = (error: unknown): string | undefined =>
  error instanceof HttpClientError && ['MEDIA_IN_USE', 'CLIENT_ARCHIVED', 'FOLDER_NOT_EMPTY', 'DEFAULT_FOLDER_IMMUTABLE'].includes(error.code) ? error.message : undefined;

export const isForbidden = (error: unknown): boolean => error instanceof HttpClientError && (error.status === 403 || error.code === 'FORBIDDEN');
