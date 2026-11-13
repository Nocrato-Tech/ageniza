import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Clapperboard, FileText, Image, LayoutGrid, Music, Search, Shapes, Video, type LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import type { ContentFormat, MediaLibraryCategory } from '@ageniza/contracts';
import { Avatar, Button, Dialog, EmptyState, IconButton, Kbd, SearchField, Skeleton } from '@ageniza/ui';

import {
  flattenResults,
  GROUPS,
  itemPath,
  loadFolders,
  markTerm,
  useAgencySearch,
  type SearchData,
  type SearchItem,
  type SearchState
} from './agency-search-model.js';
import { CARD_FORMAT_LABELS, STATUS_LABELS } from './content-labels.js';
import { useApiClient } from './http.js';
import { TYPE_LABELS } from './media-library-model.js';

const PLACEHOLDER = 'Buscar cliente, conteúdo ou arquivo';
const FORMAT_ICONS: Readonly<Record<ContentFormat, LucideIcon>> = { image: Image, carousel: LayoutGrid, reels: Clapperboard, long_video: Video, vsl: Video };
const CATEGORY_ICONS: Readonly<Record<MediaLibraryCategory, LucideIcon>> = { image: Image, video: Video, pdf: FileText, audio: Music, logo: Shapes };

function Marked({ text, term }: { text: string; term: string }) {
  const parts = markTerm(text, term);
  return parts === null ? <>{text}</> : <>{parts.before}<mark>{parts.hit}</mark>{parts.after}</>;
}

const handleOf = (value: string): string => `@${value.replace(/^@/, '')}`;

function Row({ item, term, id, active, href, onOpen, onHover }: {
  item: SearchItem; term: string; id: string; active: boolean; href: string; onOpen: () => void; onHover: () => void;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen();
  };
  let icon: ReactNode;
  let name: string;
  let meta: string;
  if (item.kind === 'client') {
    const { entry } = item;
    icon = <Avatar name={entry.name} photoUrl={entry.photoUrl} size="sm" />;
    name = entry.name;
    meta = [entry.instagramHandle === null ? null : handleOf(entry.instagramHandle), entry.archived ? 'Arquivado' : null].filter(Boolean).join(' · ');
  } else if (item.kind === 'content') {
    const { entry } = item;
    const Icon = FORMAT_ICONS[entry.format];
    icon = <span className="agency-search__icon agency-search__icon--content" aria-hidden="true"><Icon /></span>;
    name = entry.title;
    meta = `${entry.clientName} · ${CARD_FORMAT_LABELS[entry.format]} · ${entry.overdue ? 'Atrasado' : entry.scheduled ? 'Agendado' : STATUS_LABELS[entry.status]}`;
  } else {
    const { entry } = item;
    const Icon = CATEGORY_ICONS[entry.category];
    icon = <span className="agency-search__icon agency-search__icon--file" aria-hidden="true"><Icon /></span>;
    name = entry.name;
    meta = `${entry.clientName} · ${TYPE_LABELS[entry.category]}`;
  }
  return <a
    id={id}
    role="option"
    aria-selected={active}
    className="agency-search__row"
    href={href}
    tabIndex={-1}
    onClick={onClick}
    onMouseMove={onHover}
    // The field keeps the focus: the row is picked, not tabbed to.
    onMouseDown={(event) => { event.preventDefault(); }}
  >
    {icon}
    <span className="agency-search__main">
      <span className="agency-search__name"><Marked text={name} term={term} /></span>
      {meta !== '' && <span className="agency-search__meta">{meta}</span>}
    </span>
  </a>;
}

function Results({ state, items, data, term, listId, active, agencyId, onOpen, onHover, onClear, onRetry }: {
  state: SearchState; items: SearchItem[]; data: SearchData | null; term: string; listId: string; active: number; agencyId: string;
  onOpen: (item: SearchItem) => void; onHover: (index: number) => void; onClear: () => void; onRetry: () => void;
}) {
  if (state.kind === 'idle') {
    return <div className="agency-search__tips">
      <p className="agency-search__tips-title">Comece a digitar</p>
      <p>Digite o nome de um cliente, de um conteúdo ou de um arquivo.</p>
      <p>Atalho: <Kbd>Ctrl K</Kbd>, de qualquer tela.</p>
    </div>;
  }
  if (state.kind === 'error') {
    return <EmptyState
      kind="failure"
      className="agency-search__state"
      headingLevel={3}
      title="Não foi possível buscar"
      description={state.rateLimited ? 'Foram muitas buscas seguidas. Espere um instante e tente de novo.' : 'Tente de novo em instantes.'}
      onRetry={onRetry}
    />;
  }
  if (data === null) {
    return <div className="agency-search__skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>;
  }
  if (items.length === 0 && state.kind === 'ready') {
    return <EmptyState
      className="agency-search__state"
      headingLevel={3}
      title={`Nada encontrado para «${state.term}»`}
      description="Confira a grafia ou tente outro termo. A busca olha nomes de clientes, títulos de conteúdos e nomes de arquivos."
      action={<Button variant="secondary" onClick={onClear}>Limpar a busca</Button>}
    />;
  }
  let index = 0;
  return <div id={listId} role="listbox" aria-label="Resultados" aria-busy={state.kind === 'loading'}>
    {GROUPS.map(({ key, label }) => {
      const group = data[key];
      if (group.length === 0) return null;
      return <div key={key} className="agency-search__group" role="group" aria-label={label}>
        <p className="agency-search__group-title" aria-hidden="true"><span>{label}</span><span>{group.length}</span></p>
        {group.map((entry) => {
          const position = index;
          index += 1;
          const item = items[position]!;
          return <Row
            key={entry.id}
            item={item}
            term={term}
            id={`${listId}-${position}`}
            active={position === active}
            href={itemPath(agencyId, item)}
            onOpen={() => { onOpen(item); }}
            onHover={() => { onHover(position); }}
          />;
        })}
      </div>;
    })}
  </div>;
}

/** The field and its results. On a wide screen the results float under the field; on a phone the surface is the whole dialog. */
function SearchSurface({ agencyId, phone, onDone }: { agencyId: string; phone: boolean; onDone?: () => void }) {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const { state, retry } = useAgencySearch(agencyId, text);

  const data = state.kind === 'ready' ? state.data : state.kind === 'loading' ? state.previous : null;
  const items = data === null ? [] : flattenResults(data);
  const shown = phone || open;
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const term = state.kind === 'ready' || state.kind === 'error' ? state.term : text.trim();

  useEffect(() => {
    if (phone) return undefined;
    const opens = (event: globalThis.KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') setOpen(true);
    };
    document.addEventListener('keydown', opens);
    return () => { document.removeEventListener('keydown', opens); };
  }, [phone]);

  useEffect(() => {
    if (phone) { input.current?.focus(); return undefined; }
    if (!open) return undefined;
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('pointerdown', outside); };
  }, [open, phone]);

  const choose = (item: SearchItem): void => {
    setOpen(false);
    setText('');
    onDone?.();
    if (item.kind !== 'file') { void navigate(itemPath(agencyId, item)); return; }
    void loadFolders(queryClient, httpClient, agencyId, item.entry.clientId).then((folders) => { void navigate(itemPath(agencyId, item, folders)); });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (items.length > 0) setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (event.key === 'Enter' && shown && items[current] !== undefined) {
      event.preventDefault();
      choose(items[current]);
    } else if (event.key === 'Escape' && open && !phone) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const clear = (): void => { setText(''); input.current?.focus(); };
  const summary = state.kind === 'ready' && items.length > 0 ? `${items.length} ${items.length === 1 ? 'resultado' : 'resultados'} para «${state.term}»` : '';

  return <div
    ref={root}
    className={phone ? 'agency-search agency-search--sheet' : 'agency-search'}
    onBlur={(event) => { if (!phone && !(event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget))) setOpen(false); }}
  >
    <SearchField
      ref={input}
      label="Buscar"
      placeholder={PLACEHOLDER}
      shortcut={!phone}
      value={text}
      maxLength={80}
      autoComplete="off"
      role="combobox"
      aria-expanded={shown}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={shown && items[current] !== undefined ? `${listId}-${current}` : undefined}
      onChange={(value) => { setText(value); setActive(0); setOpen(true); }}
      onFocus={() => { setOpen(true); }}
      onClick={() => { setOpen(true); }}
      onKeyDown={onKeyDown}
    />
    {shown && <section className="agency-search__panel" aria-label="Resultados da busca">
      {!phone && <div className="agency-search__head"><span aria-live="polite">{summary}</span><Kbd>Esc</Kbd></div>}
      {phone && <p className="visually-hidden" aria-live="polite">{summary}</p>}
      <div className="agency-search__body">
        <Results state={state} items={items} data={data} term={term} listId={listId} active={current} agencyId={agencyId} onOpen={choose} onHover={setActive} onClear={clear} onRetry={retry} />
      </div>
      {!phone && <div className="agency-search__foot"><span><Kbd>↑</Kbd><Kbd>↓</Kbd> navegar</span><span><Kbd>Enter</Kbd> abrir</span><span><Kbd>Esc</Kbd> fechar</span></div>}
    </section>}
  </div>;
}

/** The search of the top bar of the agency: a pill with Ctrl K and the results in groups under it. */
export function AgencySearch({ agencyId }: { agencyId: string }) {
  return <SearchSurface agencyId={agencyId} phone={false} />;
}

/** On a phone the search is an icon in the top bar that opens a sheet. */
export function AgencySearchPhone({ agencyId }: { agencyId: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <IconButton label="Buscar" icon={<Search />} aria-haspopup="dialog" className="agency-search__trigger" onClick={() => { setOpen(true); }} />
    {open && <Dialog title="Busca" closeLabel="Fechar a busca" size="lg" onClose={() => { setOpen(false); }}>
      <SearchSurface agencyId={agencyId} phone onDone={() => { setOpen(false); }} />
    </Dialog>}
  </>;
}
