import { useId, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  CommentListResponseSchema,
  CommentSchema,
  CreateThreadResponseSchema,
  ThreadListResponseSchema,
  ThreadSchema,
  hasForbiddenControlCharacters,
  utf8ByteLength,
  type ConversationSide,
  type Thread,
  type ThreadComment,
  type ThreadSubject
} from '@ageniza/contracts';
import { Avatar, Button, FieldMessage, Modal, Skeleton, Textarea } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';

/**
 * The conversation about one subject (specs/clientes.md sections 4 and 7, issue #142). It knows a
 * subject only as "what is being talked about" and a side only as "who is looking", so the brand
 * study, the portal and, later, a post all use it unchanged. The side decides the routes and
 * whether Resolver exists; it never travels in a request, the server stamps it.
 */

export type ConversationScope =
  | { readonly side: 'agency'; readonly agencyId: string; readonly clientId: string }
  | { readonly side: 'client'; readonly clientId: string };

export interface ConversationProps {
  readonly scope: ConversationScope;
  readonly subject: ThreadSubject;
  /** How the subject reads to the person: "Tom de voz", "Dona Maria". */
  readonly subjectLabel: string;
  /** Opening, answering and resolving: false leaves a read-only list. */
  readonly canWrite: boolean;
  /** The subject or its client no longer accepts writes: nobody writes, everybody reads. */
  readonly readOnly: boolean;
  /** Called after a write the conversation cannot invalidate itself (client summary, roster badge). */
  readonly onWritten: () => void;
  /** Called when a write is refused because the subject changed under the person (persona archived, section emptied). */
  readonly onStale?: () => void;
  /** The heading level of "Conversas", so it nests under whatever heading holds the area. */
  readonly headingLevel?: 3 | 4;
}

const THREADS_PAGE_SIZE = 100;
const BODY_MAX_BYTES = 5000;
const COMMENTS_PAGE_SIZE = 50;
const NO_EDIT_NOTE = 'Depois de enviada, a mensagem não pode ser editada nem apagada.';
const SIDE_LABEL: Record<ConversationSide, string> = { agency: 'agência', client: 'cliente' };
const SIDE_TITLE: Record<ConversationSide, string> = { agency: 'Agência', client: 'Cliente' };

/** The wording of opening a conversation: the agency "starts a conversation", the client "suggests". */
const OPENING: Record<ConversationSide, {
  readonly buttonName: (subjectLabel: string) => string;
  readonly title: (subjectLabel: string) => string;
  readonly closeLabel: string;
  readonly composerLabel: string;
  readonly submit: string;
  readonly placeholder: string | undefined;
  readonly note: string | undefined;
}> = {
  agency: {
    buttonName: (subjectLabel) => `Nova conversa sobre ${subjectLabel}`,
    title: (subjectLabel) => `Nova conversa sobre ${subjectLabel}`,
    closeLabel: 'Fechar nova conversa',
    composerLabel: 'Escreva a primeira mensagem',
    submit: 'Iniciar conversa',
    placeholder: undefined,
    note: undefined
  },
  client: {
    buttonName: (subjectLabel) => `Sugerir sobre ${subjectLabel}`,
    title: (subjectLabel) => `Sugerir sobre "${subjectLabel}"`,
    closeLabel: 'Fechar sugestão',
    composerLabel: 'Escreva sua sugestão',
    submit: 'Enviar',
    placeholder: 'Escreva aqui',
    note: 'A agência vai ver e responder por aqui.'
  }
};

const subjectKeyOf = (subject: ThreadSubject): string => ('sectionKey' in subject ? `section:${subject.sectionKey}` : `persona:${subject.personaId}`);

const scopeKeyOf = (scope: ConversationScope) => ['conversation', scope.side, scope.clientId] as const;
const threadsQueryKey = (scope: ConversationScope, subject: ThreadSubject) => [...scopeKeyOf(scope), 'threads', subjectKeyOf(subject)] as const;
// The first page read is part of the key: a thread that grows onto a new page starts again at its end.
const commentsQueryKey = (scope: ConversationScope, threadId: string, firstPage: number) => [...scopeKeyOf(scope), 'comments', threadId, firstPage] as const;

const routesOf = (scope: ConversationScope) => {
  const values: Record<string, string> = scope.side === 'agency' ? { agencyId: scope.agencyId, clientId: scope.clientId } : { clientId: scope.clientId };
  const base = scope.side === 'agency' ? '/agencies/:agencyId/clients/:clientId' : '/clients/:clientId';
  return {
    threads: apiPath(`${base}/threads`, values),
    comments: (threadId: string) => apiPath(`${base}/threads/:threadId/comments`, { ...values, threadId }),
    resolve: (threadId: string) => apiPath(`${base}/threads/:threadId/resolve`, { ...values, threadId })
  };
};

const whenFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Sao_Paulo'
});
const dayFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });

/** "12/10 22:30" in the agency's timezone, whatever the browser's. */
const formatWhen = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const part = (type: string): string => whenFormatter.formatToParts(date).find((item) => item.type === type)?.value ?? '';
  return `${part('day')}/${part('month')} ${part('hour')}:${part('minute')}`;
};

const formatDay = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dayFormatter.format(date);
};

/** What the person must do next, from where they stand: the agency answers the client and vice versa. */
const awaitsViewer = (thread: Thread, viewer: ConversationSide): boolean =>
  thread.state === 'open' && thread.lastComment.side !== viewer;

const bodyProblem = (body: string): string | undefined => {
  if (body.trim() === '') return 'Escreva a mensagem.';
  if (hasForbiddenControlCharacters(body)) return 'O texto contém caracteres que não são aceitos.';
  if (utf8ByteLength(body.trim()) > BODY_MAX_BYTES) return 'A mensagem pode ter no máximo 5.000 bytes.';
  return undefined;
};

const isStaleSubject = (error: unknown): boolean =>
  error instanceof HttpClientError && (error.code === 'PERSONA_ARCHIVED' || error.code === 'SECTION_NOT_FILLED');

const writeError = (error: unknown, side: ConversationSide): string => {
  if (!(error instanceof HttpClientError)) return 'Não foi possível enviar. Tente de novo.';
  if (error.code === 'CLIENT_ARCHIVED') return 'Cliente arquivado: a conversa está somente leitura.';
  if (error.code === 'PERSONA_ARCHIVED') {
    return side === 'client' ? 'Esta parte não está mais disponível para conversa.' : 'Persona arquivada: a conversa está somente leitura.';
  }
  if (error.code === 'SECTION_NOT_FILLED') {
    return side === 'client' ? 'Sua agência está preparando esta parte.' : 'Esta parte ainda não foi preenchida.';
  }
  if (error.status === 403) return 'Você não tem permissão para conversar aqui.';
  if (error.status === 404) return 'Esta conversa não existe mais.';
  if (error.status === 400) return 'Revise o texto e tente de novo.';
  return 'Não foi possível enviar. Tente de novo.';
};

const authorName = (comment: ThreadComment): string => comment.author?.name ?? (comment.side === 'agency' ? 'Agência' : 'Cliente');

/** The writing box shared by the first message and the answers: the text leaves only once confirmed. */
function Composer({ label, submitLabel, placeholder, note, pending, error, onSubmit, onEdit }: {
  label: string;
  submitLabel: string;
  placeholder?: string | undefined;
  note?: string | undefined;
  pending: boolean;
  error: string | undefined;
  onSubmit: (body: string) => void;
  onEdit: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const fieldId = useId();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const found = bodyProblem(draft);
    if (found !== undefined) { setProblem(found); return; }
    onSubmit(draft.trim());
  };

  return <form className="conversation__composer" onSubmit={submit} noValidate>
    <label className="conversation__composer-label" htmlFor={fieldId}>{label}</label>
    <Textarea
      id={fieldId}
      value={draft}
      rows={4}
      placeholder={placeholder}
      readOnly={pending}
      onChange={(event) => { setDraft(event.target.value); setProblem(undefined); onEdit(); }}
    />
    {note !== undefined && <p className="conversation__note">{note}</p>}
    <p className="conversation__note">{NO_EDIT_NOTE}</p>
    {(problem ?? error) !== undefined && <FieldMessage role="alert">{problem ?? error}</FieldMessage>}
    <div className="conversation__actions">
      <Button type="submit" loading={pending}>{error === undefined ? submitLabel : 'Tentar de novo'}</Button>
    </div>
  </form>;
}

function CommentItem({ comment }: { comment: ThreadComment }) {
  return <li className={`conversation__comment conversation__comment--${comment.side}`}>
    <Avatar name={authorName(comment)} photoUrl={comment.author?.photoUrl ?? null} size="sm" />
    <div className="conversation__comment-main">
      <p className="conversation__comment-meta">
        <span className="conversation__comment-author">{authorName(comment)}</span>
        {' · '}<span>{SIDE_LABEL[comment.side]}</span>
        {' · '}<span>{formatWhen(comment.createdAt)}</span>
      </p>
      <p className="conversation__comment-body">{comment.body}</p>
    </div>
  </li>;
}

function OpenThread({ props, thread, onClose }: { props: ConversationProps; thread: Thread; onClose: () => void }) {
  const { scope, subjectLabel, canWrite, readOnly, onWritten, onStale } = props;
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const routes = routesOf(scope);
  const [sendError, setSendError] = useState<string | undefined>();
  const [resolveError, setResolveError] = useState<string | undefined>();
  const [sent, setSent] = useState(0);

  // The API pages oldest first: a conversation opens on its last page, the newest messages.
  const lastPage = Math.max(1, Math.ceil(thread.commentCount / COMMENTS_PAGE_SIZE));
  const comments = useInfiniteQuery({
    queryKey: commentsQueryKey(scope, thread.id, lastPage),
    initialPageParam: lastPage,
    queryFn: ({ pageParam, signal }) => httpClient.request({
      path: `${routes.comments(thread.id)}?page=${pageParam}`,
      response: CommentListResponseSchema,
      signal
    }),
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
    getPreviousPageParam: (first) => (first.meta.page > 1 ? first.meta.page - 1 : undefined)
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: scopeKeyOf(scope) });
    onWritten();
  };

  const answer = useMutation({
    mutationFn: (body: string) => httpClient.request({
      path: routes.comments(thread.id),
      method: 'POST',
      body: { body },
      response: CommentSchema
    }),
    onSuccess: () => { setSendError(undefined); setSent((count) => count + 1); refresh(); },
    onError: (error: unknown) => { setSendError(writeError(error, scope.side)); if (isStaleSubject(error)) onStale?.(); }
  });

  const resolve = useMutation({
    mutationFn: () => httpClient.request({ path: routes.resolve(thread.id), method: 'POST', response: ThreadSchema }),
    onSuccess: () => { setResolveError(undefined); refresh(); },
    onError: (error: unknown) => { setResolveError(writeError(error, scope.side)); if (isStaleSubject(error)) onStale?.(); }
  });

  const items = comments.data?.pages.flatMap((page) => page.data) ?? [];
  const writable = canWrite && !readOnly;
  const canResolve = writable && scope.side === 'agency' && thread.state === 'open';

  return <Modal title={subjectLabel} closeLabel="Fechar conversa" onClose={onClose}>
    <div className="conversation__thread-view">
      {comments.isPending && <div className="conversation__comments-skeleton" aria-busy="true">
        <Skeleton /><Skeleton /><Skeleton />
      </div>}
      {comments.isError && comments.data === undefined && <div role="alert">
        <p>Não foi possível carregar a conversa.</p>
        <Button variant="secondary" onClick={() => { void comments.refetch(); }}>Tentar de novo</Button>
      </div>}
      {comments.hasPreviousPage && <Button variant="secondary" loading={comments.isFetchingPreviousPage} onClick={() => { void comments.fetchPreviousPage(); }}>Ver mensagens anteriores</Button>}
      {items.length > 0 && <ol className="conversation__comments">
        {items.map((comment) => <CommentItem key={comment.id} comment={comment} />)}
      </ol>}
      {comments.hasNextPage && <Button variant="secondary" loading={comments.isFetchingNextPage} onClick={() => { void comments.fetchNextPage(); }}>Ver mensagens mais novas</Button>}
      {thread.state === 'resolved' && thread.resolvedAt !== null && <p className="conversation__resolved">
        {scope.side === 'client'
          ? `A agência concluiu esta conversa em ${formatDay(thread.resolvedAt)}`
          : `Resolvida ${thread.resolvedBy?.name ? `por ${thread.resolvedBy.name}` : 'pela agência'} em ${formatDay(thread.resolvedAt)}`}
      </p>}
      {writable
        ? <Composer
          key={`${thread.id}-${sent}`}
          label="Escrever resposta"
          submitLabel="Responder"
          pending={answer.isPending}
          error={sendError}
          onEdit={() => setSendError(undefined)}
          onSubmit={(body) => { setSendError(undefined); answer.mutate(body); }}
        />
        : <p className="conversation__note">Esta conversa é somente leitura.</p>}
      {canResolve && <div className="conversation__actions">
        <Button variant="secondary" loading={resolve.isPending} onClick={() => { setResolveError(undefined); resolve.mutate(); }}>Resolver</Button>
      </div>}
      {resolveError !== undefined && <FieldMessage role="alert">{resolveError}</FieldMessage>}
    </div>
  </Modal>;
}

function NewConversationDialog({ props, onClose }: { props: ConversationProps; onClose: () => void }) {
  const { scope, subject, subjectLabel, onWritten, onStale } = props;
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();
  const wording = OPENING[scope.side];

  const open = useMutation({
    mutationFn: (body: string) => httpClient.request({
      path: routesOf(scope).threads,
      method: 'POST',
      body: { subject, body },
      response: CreateThreadResponseSchema
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scopeKeyOf(scope) });
      onWritten();
      onClose();
    },
    onError: (failure: unknown) => { setError(writeError(failure, scope.side)); if (isStaleSubject(failure)) onStale?.(); }
  });

  return <Modal title={wording.title(subjectLabel)} closeLabel={wording.closeLabel} onClose={onClose}>
    <Composer
      label={wording.composerLabel}
      submitLabel={wording.submit}
      placeholder={wording.placeholder}
      note={wording.note}
      pending={open.isPending}
      error={error}
      onEdit={() => setError(undefined)}
      onSubmit={(body) => { setError(undefined); open.mutate(body); }}
    />
  </Modal>;
}

/** Open threads first, then the resolved; the API already orders by latest activity inside each. */
const openFirst = (threads: readonly Thread[]): Thread[] => [
  ...threads.filter((thread) => thread.state === 'open'),
  ...threads.filter((thread) => thread.state === 'resolved')
];

function ThreadRow({ thread, viewer, onOpen }: { thread: Thread; viewer: ConversationSide; onOpen: () => void }) {
  const awaiting = awaitsViewer(thread, viewer);
  const status = thread.state === 'resolved'
    ? (viewer === 'client' ? 'concluída' : 'resolvida')
    : awaiting ? (viewer === 'agency' ? 'aguardando você' : 'a agência respondeu') : 'aberta';
  return <li>
    <button type="button" className="conversation__thread" onClick={onOpen}>
      <span className="conversation__thread-meta">
        {thread.openedBy.name === null
          ? `Aberta ${thread.openedBy.side === 'agency' ? 'pela agência' : 'pelo cliente'}`
          : `Aberta por ${thread.openedBy.name} (${SIDE_LABEL[thread.openedBy.side]})`}
      </span>
      <span className="conversation__thread-last">{SIDE_TITLE[thread.lastComment.side]} · {formatDay(thread.lastComment.at)}</span>
      <span className="conversation__thread-excerpt">{thread.lastComment.excerpt}</span>
      <span className={awaiting ? 'conversation__status conversation__status--awaiting' : 'conversation__status'}>{status}</span>
    </button>
  </li>;
}

export function Conversation(props: ConversationProps) {
  const { scope, subject, subjectLabel, canWrite, readOnly, headingLevel = 4 } = props;
  const Heading = `h${headingLevel}` as const;
  const opening = OPENING[scope.side];
  const httpClient = useApiClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const subjectQuery = 'sectionKey' in subject ? `sectionKey=${subject.sectionKey}` : `personaId=${subject.personaId}`;

  const threads = useQuery({
    queryKey: threadsQueryKey(scope, subject),
    queryFn: ({ signal }) => httpClient.request({
      path: `${routesOf(scope).threads}?${subjectQuery}&pageSize=${THREADS_PAGE_SIZE}`,
      response: ThreadListResponseSchema,
      signal
    })
  });

  const writable = canWrite && !readOnly;
  const list = threads.data === undefined ? [] : openFirst(threads.data.data);
  const awaiting = list.filter((thread) => awaitsViewer(thread, scope.side)).length;
  const current = openId === null ? undefined : list.find((thread) => thread.id === openId);

  return <section className="conversation" aria-label={`Conversas sobre ${subjectLabel}`}>
    <header className="conversation__header">
      <Heading className="conversation__title">
        Conversas{threads.data === undefined ? '' : ` (${threads.data.meta.totalItems})`}
      </Heading>
      {awaiting > 0 && <span className="conversation__status conversation__status--awaiting">
        {scope.side === 'agency' ? `${awaiting} aguardando` : `${awaiting} com resposta da agência`}
      </span>}
      {writable && (scope.side === 'client'
        ? <Button variant="secondary" aria-label={opening.buttonName(subjectLabel)} onClick={() => setCreating(true)}>Sugerir</Button>
        : <Button size="sm" variant="secondary" aria-label={opening.buttonName(subjectLabel)} onClick={() => setCreating(true)}><span aria-hidden="true">+</span> conversa</Button>)}
    </header>

    {threads.isPending && <div className="conversation__threads-skeleton" aria-busy="true"><Skeleton /><Skeleton /></div>}
    {threads.isError && threads.data === undefined && <div role="alert">
      <p>Não foi possível carregar as conversas.</p>
      <Button size="sm" variant="secondary" loading={threads.isFetching} onClick={() => { void threads.refetch(); }}>Tentar de novo</Button>
    </div>}
    {threads.data !== undefined && list.length === 0 && <p className="conversation__empty">Nenhuma conversa sobre esta parte</p>}
    {list.length > 0 && <ul className="conversation__threads">
      {list.map((thread) => <ThreadRow key={thread.id} thread={thread} viewer={scope.side} onOpen={() => setOpenId(thread.id)} />)}
    </ul>}
    {threads.data !== undefined && threads.data.meta.totalItems > THREADS_PAGE_SIZE && <p className="conversation__note">
      Mostrando as {THREADS_PAGE_SIZE} conversas mais recentes.
    </p>}

    {current !== undefined && <OpenThread props={props} thread={current} onClose={() => setOpenId(null)} />}
    {creating && <NewConversationDialog props={props} onClose={() => setCreating(false)} />}
  </section>;
}
