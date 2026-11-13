import { useEffect, useRef, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';

import {
  AGENCY_SEARCH_TERM_MIN_LENGTH,
  AgencySearchResponseSchema,
  MediaFolderSummaryListResponseSchema,
  searchedCharacters,
  type AgencySearchClient,
  type AgencySearchContent,
  type AgencySearchFile,
  type AgencySearchResponse
} from '@ageniza/contracts';

import { apiPath } from './api-path.js';
import { contentsAddress } from './content-address.js';
import { HttpClientError, useApiClient, type HttpClient } from './http.js';
import { foldersBase, foldersQueryKey, type FolderList } from './media-library-model.js';

export const SEARCH_DELAY_MS = 250;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** What goes to the API, or null while the term is below the minimum: the route would answer 400, so nothing is asked. */
export const queryableTerm = (raw: string): string | null => {
  const term = raw.replace(CONTROL_CHARACTERS, ' ').trim();
  return searchedCharacters(term).length >= AGENCY_SEARCH_TERM_MIN_LENGTH ? term : null;
};

export type SearchData = AgencySearchResponse['data'];

export type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading'; previous: SearchData | null }
  | { kind: 'ready'; term: string; data: SearchData }
  | { kind: 'error'; term: string; rateLimited: boolean };

type Settled = { term: string; data: SearchData } | { term: string; rateLimited: boolean };

/** The search of the top bar: it waits for the person to stop typing, asks for the last term only and cancels the one still in flight. */
export function useAgencySearch(agencyId: string, raw: string): { state: SearchState; retry: () => void } {
  const httpClient = useApiClient();
  const term = queryableTerm(raw);
  const [settled, setSettled] = useState<Settled | null>(null);
  const [lastData, setLastData] = useState<SearchData | null>(null);
  const [round, setRound] = useState(0);
  const immediate = useRef(false);

  useEffect(() => {
    if (term === null) return undefined;
    const controller = new AbortController();
    const delay = immediate.current ? 0 : SEARCH_DELAY_MS;
    immediate.current = false;
    const timer = setTimeout(() => {
      httpClient.request({
        path: `${apiPath('/agencies/:agencyId/search', { agencyId })}?q=${encodeURIComponent(term)}`,
        response: AgencySearchResponseSchema,
        signal: controller.signal
      }).then((answer) => {
        if (controller.signal.aborted) return;
        setSettled({ term, data: answer.data });
        setLastData(answer.data);
      }, (failure: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ term, rateLimited: failure instanceof HttpClientError && failure.status === 429 });
      });
    }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [agencyId, httpClient, term, round]);

  const state: SearchState = term === null ? { kind: 'idle' }
    : settled === null || settled.term !== term ? { kind: 'loading', previous: lastData }
      : 'data' in settled ? { kind: 'ready', term, data: settled.data }
        : { kind: 'error', term, rateLimited: settled.rateLimited };

  const retry = (): void => {
    immediate.current = true;
    setSettled(null);
    setRound((value) => value + 1);
  };
  return { state, retry };
}

export type SearchItem =
  | { kind: 'client'; id: string; entry: AgencySearchClient }
  | { kind: 'content'; id: string; entry: AgencySearchContent }
  | { kind: 'file'; id: string; entry: AgencySearchFile };

export const GROUPS = [
  { key: 'clients', label: 'Clientes' },
  { key: 'contents', label: 'Conteúdos' },
  { key: 'files', label: 'Arquivos' }
] as const;

/** The three groups in the order of the panel, flat, so the arrows walk through them as one list. */
export const flattenResults = (data: SearchData): SearchItem[] => [
  ...data.clients.map((entry): SearchItem => ({ kind: 'client', id: entry.id, entry })),
  ...data.contents.map((entry): SearchItem => ({ kind: 'content', id: entry.id, entry })),
  ...data.files.map((entry): SearchItem => ({ kind: 'file', id: entry.id, entry }))
];

const clientBase = (agencyId: string, clientId: string): string => `/agencia/${agencyId}/clientes/${clientId}`;

const mediaAddress = (agencyId: string, clientId: string, folders: readonly { id: string; parentId: string | null }[], folderId: string): string => {
  const folder = folders.find((candidate) => candidate.id === folderId);
  const media = `${clientBase(agencyId, clientId)}/midias`;
  if (folder === undefined) return media;
  return folder.parentId === null ? `${media}?pasta=${folder.id}` : `${media}?pasta=${folder.parentId}&subpasta=${folder.id}`;
};

/** A result already knows where it goes, but a file's folder may be a subfolder, which the address spells with its parent. */
export const itemPath = (agencyId: string, item: SearchItem, folders: readonly { id: string; parentId: string | null }[] = []): string => {
  switch (item.kind) {
    case 'client': return `${clientBase(agencyId, item.id)}/geral`;
    case 'content': return `${contentsAddress(agencyId, item.entry.clientId)}/${item.id}`;
    case 'file': return mediaAddress(agencyId, item.entry.clientId, folders, item.entry.folderId);
  }
};

const FOLDERS_PAGE_SIZE = 100;
const MAX_FOLDER_PAGES = 10;

/** The folders of a client, from the cache of the library when it is warm; a failure falls back to the Mídias tab at its root. */
export const loadFolders = async (queryClient: QueryClient, httpClient: HttpClient, agencyId: string, clientId: string): Promise<FolderList['folders']> => {
  try {
    const list = await queryClient.fetchQuery<FolderList>({
      queryKey: foldersQueryKey(agencyId, clientId),
      staleTime: 30_000,
      queryFn: async () => {
        const folders: FolderList['folders'][number][] = [];
        let total = 0;
        for (let page = 1; page <= MAX_FOLDER_PAGES; page += 1) {
          const answer = await httpClient.request({
            path: `${foldersBase(agencyId, clientId)}/summary?page=${page}&pageSize=${FOLDERS_PAGE_SIZE}`,
            response: MediaFolderSummaryListResponseSchema
          });
          folders.push(...answer.data);
          total = answer.meta.totalItems;
          if (page >= answer.meta.totalPages) break;
        }
        return { folders, total };
      }
    });
    return list.folders;
  } catch {
    return [];
  }
};

/** The term in the text, accents ignored, marked: the same folding the search does. */
export const markTerm = (text: string, term: string): { before: string; hit: string; after: string } | null => {
  const fold = (value: string): string => Array.from(value).map((char) => char.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()).join('');
  const needle = fold(searchedCharacters(term.trim()).replace(/^@/, ''));
  if (needle.length === 0) return null;
  const chars = Array.from(text);
  const folded = chars.map(fold);
  const haystack = folded.join('');
  const at = haystack.indexOf(needle);
  if (at < 0) return null;
  let start = 0;
  let offset = 0;
  while (start < chars.length && offset + folded[start]!.length <= at) { offset += folded[start]!.length; start += 1; }
  let end = start;
  while (end < chars.length && offset < at + needle.length) { offset += folded[end]!.length; end += 1; }
  return { before: chars.slice(0, start).join(''), hit: chars.slice(start, end).join(''), after: chars.slice(end).join('') };
};
