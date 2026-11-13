import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, MessagesSquare, MessageSquarePlus } from 'lucide-react';

import {
  APPROVAL_NOTE_MAX_CHARACTERS,
  ApprovalNoteSchema,
  CalendarDaySchema,
  PortalContentDetailSchema,
  type ContentFormat,
  type PortalApproveContentWithNoteRequest,
  type PortalContentDetail,
  type PortalContentInProduction,
  type PortalContentOpenListItem,
  type PortalRequestContentChangesRequest
} from '@ageniza/contracts';
import { Button, EmptyState, Field, FieldMessage, FormatTag, LiveStatus, Skeleton, StatusTag, Textarea } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { ApprovalDeadline, ApprovalSenderNote, hourLabel, spokenDayLabel, weekdayArticle } from './approval-deadline.js';
import { Conversation } from './conversation.js';
import { fullDayLabel } from './content-dates.js';
import { CARD_FORMAT_LABELS, FORMAT_LABELS, FORMAT_TONES } from './content-labels.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { portalClientQueryKey, usePortalClient, uuidPattern } from './portal.js';
import { PortalMediaCarousel } from './portal-content-media.js';
import { PORTAL_STATUS_LABELS, PORTAL_STATUS_TAGS } from './portal-status.js';
import { PORTAL_PAUSED_REASON } from './plan-notice.js';
import { COMMENT_MESSAGES, RequestChangesDialog, type RequestError } from './request-changes-dialog.js';
import { NotFoundPage } from './status-pages.js';

/**
 * The post of the portal, whole (specs/conteudo.md sections 6 and 7, issue #270): the caption and the media from "aguardando
 * aprovação" on, Aprovar and Pedir ajuste while it waits, and the conversation of the content. In production the API answers only
 * the title, the day and the format, and so does the screen. The client is the one the portal shell proved for the address.
 */

type PortalContent = PortalContentDetail;
type OpenContent = Exclude<PortalContent, { status: 'in_production' }>;

const DETAIL_PATH = '/clients/:clientId/contents/:contentId';

export const portalContentQueryKey = (clientId: string, contentId: string) => ['portal', clientId, 'content', contentId] as const;

/** What the state of a content says to the client; the agency's "Como o cliente vê" reads the same words. */
export const STATE_NOTES: Readonly<Partial<Record<PortalContent['status'], string>>> = {
  adjusting: 'Foi pedido um ajuste. A agência vai revisar e enviar de novo para a sua aprovação.',
  approved: 'Este conteúdo está aprovado. A agência cuida da publicação.',
  published: 'Este conteúdo já foi publicado.'
};

/** The two sentences of a post that the agency's "Como o cliente vê" says too: one copy, so the preview cannot drift from the portal. */
export const NO_CAPTION_NOTE = 'Este post não tem legenda.';
export const IN_PRODUCTION_NOTE = 'Este conteúdo ainda está em produção. Quando estiver pronto, ele aparece aqui para você aprovar.';

const MESSAGES = {
  loadError: 'Não foi possível carregar o conteúdo.',
  revisionChanged: 'A agência alterou este conteúdo depois que você o abriu. Mostramos a versão atual: leia de novo antes de aprovar.',
  stateChanged: 'A situação deste conteúdo mudou enquanto você o via. Mostramos a situação atual.',
  tryAgain: 'Não foi possível agora. Tente de novo em instantes.',
  approveFailed: 'Não foi possível aprovar. Tente de novo.',
  alreadyApproved: 'Este conteúdo já foi aprovado. Seu recado não foi enviado.',
  noteTooLong: `O recado pode ter no máximo ${APPROVAL_NOTE_MAX_CHARACTERS} caracteres.`,
  noteInvalid: 'O recado contém caracteres que não são aceitos.',
  requestFailed: 'Não foi possível enviar o pedido. Tente de novo.',
  approved: 'Conteúdo aprovado. Obrigado!',
  requested: 'Pedido de ajuste enviado. A agência vai ver a sua mensagem na conversa abaixo.',
  ...COMMENT_MESSAGES
} as const;

const isStatus = (error: unknown, status: number): boolean => error instanceof HttpClientError && error.status === status;
const isCode = (error: unknown, code: string): boolean => error instanceof HttpClientError && error.code === code;

/** A day is read as text and never through a `Date`: the planned day is São Paulo's, whatever the browser's zone. */
const dayText = (day: string): string => CalendarDaySchema.safeParse(day).success ? fullDayLabel(day) : day;

/** The way back on every state of the screen, and the only one on a phone, where the bottom bar of the shell steps aside while a post is open (issue #687). */
function PostCrumbs({ title }: { title?: string }) {
  const client = usePortalClient();
  return <nav className="portal-post__crumbs" aria-label="Você está em">
    <Link to={`/portal/${client.id}/inicio`}>Início</Link>
    <ChevronRight aria-hidden="true" />
    {title === undefined ? <Link to={`/portal/${client.id}/conteudos`}>Conteúdos</Link> : <>
      <Link to={`/portal/${client.id}/conteudos`}>Conteúdos</Link>
      <ChevronRight aria-hidden="true" />
      <span aria-current="page">{title}</span>
    </>}
  </nav>;
}

const countOf = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** "5 imagens", "1 vídeo" or "3 imagens e 1 vídeo": what the post carries, from the media the API listed. */
const mediaSummary = (media: readonly { kind: 'image' | 'video' }[]): string | undefined => {
  const images = media.filter((item) => item.kind === 'image').length;
  const videos = media.length - images;
  const parts = [images > 0 && countOf(images, 'imagem', 'imagens'), videos > 0 && countOf(videos, 'vídeo', 'vídeos')].filter(Boolean);
  return parts.length === 0 ? undefined : parts.join(' e ');
};

/** The line under the title: the format, what it carries and, from the state, the day (and hour) it goes out or went out. */
function PostSummary({ content }: { content: PortalContent }) {
  const day = CalendarDaySchema.safeParse(content.publishOn).success ? content.publishOn : undefined;
  const open = content.status === 'in_production' ? undefined : content;
  const media = open === undefined ? undefined : mediaSummary(open.media);
  const publishedOn = open?.publishedOn ?? null;
  return <p className="portal-post__summary">
    {CARD_FORMAT_LABELS[content.format]}
    {media !== undefined && ` · ${media}`}
    {' · '}
    {content.status === 'published' && publishedOn !== null && CalendarDaySchema.safeParse(publishedOn).success
      ? <>publicado em <time dateTime={publishedOn}>{spokenDayLabel(publishedOn)}</time></>
      : day === undefined
        ? content.publishOn
        : <>publica {weekdayArticle(day)} <time dateTime={day}>{spokenDayLabel(day)}</time>{open?.publishAtTime != null && `, às ${hourLabel(open.publishAtTime)}`}</>}
  </p>;
}

const STATE_TAG_LABELS: Partial<Record<PortalContent['status'], string>> = { awaiting_approval: 'Aguardando sua aprovação' };

/** The part of a post that the meta line reads: the agency's preview has no media or revision to hand it, and needs none. */
export type PostMetaContent = PortalContentInProduction | Pick<PortalContentOpenListItem, 'status' | 'format' | 'publishOn' | 'publishAtTime' | 'publishedOn'>;

export function PostMeta({ content }: { content: PostMetaContent }) {
  const format: ContentFormat = content.format;
  return <ul className="portal-post__meta" aria-label="Dados do conteúdo">
    <li><StatusTag status={PORTAL_STATUS_TAGS[content.status]}>{PORTAL_STATUS_LABELS[content.status]}</StatusTag></li>
    <li><FormatTag format={FORMAT_TONES[format]}>{FORMAT_LABELS[format]}</FormatTag></li>
    <li>
      <time dateTime={content.publishOn}>{dayText(content.publishOn)}</time>
      {'publishAtTime' in content && content.publishAtTime !== null && <> · {content.publishAtTime}</>}
    </li>
    {'publishedOn' in content && content.publishedOn !== null && <li>Publicado em <time dateTime={content.publishedOn}>{dayText(content.publishedOn)}</time></li>}
  </ul>;
}

/** `reloading` holds the buttons while the post is read again, so a click never carries a revision already replaced. */
function OpenPost({ content, reloading }: { content: OpenContent; reloading: boolean }) {
  const client = usePortalClient();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const key = portalContentQueryKey(client.id, content.id);
  const [notice, setNotice] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  // Said outside the bar: the state it tells about takes the bar away, and the message must outlive it.
  const [stateChanged, setStateChanged] = useState<string | undefined>();
  const [requestError, setRequestError] = useState<RequestError | undefined>();
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [noteProblem, setNoteProblem] = useState<string | undefined>();
  // Once opened the conversation stays mounted, so a draft in it survives the panel being closed.
  const [conversationOpened, setConversationOpened] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  // The mutation's own pending state reaches the button a tick late: a second tap in between must not send a second request.
  const sending = useRef(false);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: portalClientQueryKey(client.id) });
    void queryClient.invalidateQueries({ queryKey: ['portal', client.id, 'contents'] });
  };

  const stale = (error: unknown): string | undefined => {
    if (isCode(error, 'CONTENT_REVISION_CHANGED')) return MESSAGES.revisionChanged;
    if (isCode(error, 'CONTENT_NOT_AWAITING_APPROVAL')) return MESSAGES.stateChanged;
    if (isCode(error, 'TRY_AGAIN')) return MESSAGES.tryAgain;
    if (isCode(error, 'AGENCY_READ_ONLY')) return PORTAL_PAUSED_REASON;
    return undefined;
  };

  const approve = useMutation({
    mutationFn: (note: string | undefined) => httpClient.request({
      path: apiPath(`${DETAIL_PATH}/approve`, { clientId: client.id, contentId: content.id }),
      method: 'POST',
      body: (note === undefined ? { revision: content.revision } : { revision: content.revision, note }) satisfies PortalApproveContentWithNoteRequest,
      response: PortalContentDetailSchema
    }),
    onSuccess: (updated) => {
      setActionError(undefined);
      setNoteProblem(undefined);
      setNotice(MESSAGES.approved);
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({ queryKey: ['conversation', 'client', client.id] });
      refresh();
    },
    onError: (error: unknown) => {
      setNotice(undefined);
      if (isCode(error, 'CONTENT_NOT_AWAITING_APPROVAL')) setStateChanged(MESSAGES.stateChanged);
      else if (isCode(error, 'CONTENT_ALREADY_APPROVED')) setStateChanged(MESSAGES.alreadyApproved);
      else if (isCode(error, 'CONTENT_APPROVAL_NOTE_INVALID')) setNoteProblem(MESSAGES.noteInvalid);
      else setActionError(stale(error) ?? MESSAGES.approveFailed);
      refresh();
    },
    onSettled: () => { sending.current = false; }
  });

  const requestChanges = useMutation({
    mutationFn: (comment: string) => httpClient.request({
      path: apiPath(`${DETAIL_PATH}/request-changes`, { clientId: client.id, contentId: content.id }),
      method: 'POST',
      body: { revision: content.revision, comment } satisfies PortalRequestContentChangesRequest,
      response: PortalContentDetailSchema
    }),
    onSuccess: (updated) => {
      setRequestError(undefined);
      setActionError(undefined);
      setNotice(MESSAGES.requested);
      setDraft('');
      setAsking(false);
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({ queryKey: ['conversation', 'client', client.id] });
      refresh();
    },
    onError: (error: unknown) => {
      if (isCode(error, 'CONTENT_NOT_AWAITING_APPROVAL')) { setAsking(false); setStateChanged(MESSAGES.stateChanged); }
      else if (isCode(error, 'CONTENT_COMMENT_INVALID')) setRequestError({ message: MESSAGES.invalidCharacters, field: true });
      else setRequestError({ message: stale(error) ?? MESSAGES.requestFailed, field: false });
      refresh();
    },
    onSettled: () => { sending.current = false; }
  });

  const send = (action: () => void): void => {
    if (sending.current) return;
    sending.current = true;
    action();
  };

  const approveWithNote = (): void => {
    const trimmed = note.trim();
    if (trimmed !== '' && !ApprovalNoteSchema.safeParse(note).success) {
      setNoteProblem(Array.from(trimmed).length > APPROVAL_NOTE_MAX_CHARACTERS ? MESSAGES.noteTooLong : MESSAGES.noteInvalid);
      return;
    }
    setActionError(undefined); setStateChanged(undefined); setNotice(undefined); setNoteProblem(undefined);
    send(() => { approve.mutate(trimmed === '' ? undefined : trimmed); });
  };

  const awaiting = content.status === 'awaiting_approval';
  const stateNote = STATE_NOTES[content.status];

  // The button the person pressed leaves with the bar: what the screen answers takes the focus, so it is read and seen where the person is.
  useEffect(() => {
    if (notice !== undefined || stateChanged !== undefined) noticeRef.current?.focus();
  }, [notice, stateChanged]);

  return <>
    {(notice !== undefined || stateChanged !== undefined || stateNote !== undefined) && <div ref={noticeRef} className="portal-post__notes" tabIndex={-1}>
      {notice !== undefined && <LiveStatus>{notice}</LiveStatus>}
      {stateChanged !== undefined && <FieldMessage role="alert">{stateChanged}</FieldMessage>}
      {stateNote !== undefined && <p className="portal-post__hint">{stateNote}</p>}
    </div>}
    <div className="portal-post__layout">
      <section className="portal-post__card" aria-label="Prévia do post">
        <PortalMediaCarousel
          key={content.id}
          ids={{ clientId: client.id, contentId: content.id }}
          format={content.format}
          coverAssetId={content.coverAssetId}
          media={content.media}
          title={content.title}
        />
        <section className="portal-post__section" aria-labelledby="portal-post-caption">
          <h2 id="portal-post-caption" className="portal-post__eyebrow">Legenda</h2>
          {content.caption === null || content.caption === ''
            ? <p className="portal-post__hint">{NO_CAPTION_NOTE}</p>
            : <p className="portal-post__caption">{content.caption}</p>}
        </section>
        <details className="portal-post__convo" onToggle={(event) => { if (event.currentTarget.open) setConversationOpened(true); }}>
          <summary>
            <MessagesSquare aria-hidden="true" />
            <span className="portal-post__convo-title">Conversa sobre este post</span>
            <ChevronDown className="portal-post__convo-chevron" aria-hidden="true" />
          </summary>
          {conversationOpened && <Conversation
            scope={{ side: 'client', clientId: client.id }}
            subject={{ contentId: content.id }}
            subjectLabel={content.title}
            canWrite
            readOnly={false}
            planBlockedReason={client.agencyReadOnly ? PORTAL_PAUSED_REASON : undefined}
            onWritten={refresh}
            headingLevel={3}
          />}
        </details>
      </section>
      {awaiting && <aside className="portal-post__decide" aria-labelledby="portal-post-decision">
        <h2 id="portal-post-decision">Sua resposta</h2>
        <ApprovalDeadline approval={content.approval} />
        <ApprovalSenderNote approval={content.approval} agencyName={client.agencyName} />
        <Field
          label="Seu recado para a agência"
          hint="Opcional ao aprovar"
          error={noteProblem}
          counter={{ count: Array.from(note).length, max: APPROVAL_NOTE_MAX_CHARACTERS }}
        >
          {(control) => <Textarea
            {...control}
            value={note}
            rows={4}
            placeholder="Ex.: trocar a foto da capa por uma com o panetone inteiro"
            readOnly={approve.isPending}
            onChange={(event) => { setNote(event.target.value); setNoteProblem(undefined); }}
          />}
        </Field>
        <div className="portal-post__bar">
          {actionError !== undefined && <FieldMessage role="alert">{actionError}</FieldMessage>}
          <div className="portal-post__actions">
            <Button size="lg" leadingIcon={<Check />} loading={approve.isPending} disabled={reloading || requestChanges.isPending} blockedReason={client.agencyReadOnly ? PORTAL_PAUSED_REASON : undefined} onClick={approveWithNote}>Aprovar o post</Button>
            <Button variant="secondary" size="lg" leadingIcon={<MessageSquarePlus />} disabled={reloading || approve.isPending} blockedReason={client.agencyReadOnly ? PORTAL_PAUSED_REASON : undefined} onClick={() => { setRequestError(undefined); setStateChanged(undefined); setAsking(true); }}>Pedir ajuste</Button>
          </div>
        </div>
        <p className="portal-post__hint">Ao aprovar, a agência cuida da publicação na data marcada.</p>
      </aside>}
    </div>
    {asking && <RequestChangesDialog
      hint="A agência vai ver a sua mensagem e responder na conversa deste conteúdo."
      draft={draft}
      onDraft={(value) => { setDraft(value); setRequestError(undefined); }}
      pending={requestChanges.isPending}
      error={requestError}
      onSubmit={(comment) => { setRequestError(undefined); send(() => { requestChanges.mutate(comment); }); }}
      onClose={() => { setAsking(false); setRequestError(undefined); }}
    />}
  </>;
}

function PostSkeleton() {
  return <section className="portal-post" aria-busy="true" aria-label="Carregando o conteúdo">
    <PostCrumbs />
    <Skeleton className="portal-post__title-skeleton" />
    <Skeleton className="portal-post__media-skeleton" />
    <Skeleton />
  </section>;
}

function PostFailure({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return <section className="portal-post">
    <PostCrumbs />
    <EmptyState kind="failure" mascot className="portal-empty" title={MESSAGES.loadError} retrying={retrying} onRetry={onRetry} />
  </section>;
}

function Post({ contentId }: { contentId: string }) {
  const client = usePortalClient();
  const httpClient = useApiClient();
  const query = useQuery({
    queryKey: portalContentQueryKey(client.id, contentId),
    // A post is read when it is opened: a copy from a minute ago may carry a revision the agency already replaced.
    staleTime: 0,
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath(DETAIL_PATH, { clientId: client.id, contentId }),
      response: PortalContentDetailSchema,
      signal
    })
  });
  const content = query.data;
  useDocumentTitle(content === undefined ? 'Conteúdo — Portal do cliente — Ageniza' : `${content.title} — Portal do cliente — Ageniza`);

  // Another client's content, a cancelled one and one that does not exist are the same 404 of the API, and the same "não encontrado".
  if (isStatus(query.error, 404)) return <NotFoundPage as="section" />;
  if (content === undefined) {
    return query.isError
      ? <PostFailure onRetry={() => { void query.refetch(); }} retrying={query.isFetching} />
      : <PostSkeleton />;
  }
  // Defense in depth: the answer must be the content in the address, or it is not shown.
  if (content.id !== contentId) return <NotFoundPage as="section" />;

  return <article className="portal-post" aria-labelledby="portal-post-title">
    <header className="portal-post__heading">
      <PostCrumbs title={content.title} />
      <h1 id="portal-post-title" className="portal-headline">{content.title}</h1>
      <div className="portal-post__state">
        <StatusTag size="lg" status={PORTAL_STATUS_TAGS[content.status]}>{STATE_TAG_LABELS[content.status] ?? PORTAL_STATUS_LABELS[content.status]}</StatusTag>
        <PostSummary content={content} />
      </div>
    </header>
    {query.isError && <div className="portal-error" role="alert">
      <p>{MESSAGES.loadError}</p>
      <Button variant="secondary" loading={query.isFetching} onClick={() => { void query.refetch(); }}>Tentar de novo</Button>
    </div>}
    {content.status === 'in_production'
      ? <p className="portal-block portal-post__hint">{IN_PRODUCTION_NOTE}</p>
      : <OpenPost content={content} reloading={query.isFetching} />}
  </article>;
}

export function PortalContentPage() {
  const { conteudoId = '' } = useParams();
  // A malformed id is a bad address, not a request: the API would answer 404 anyway.
  if (!uuidPattern.test(conteudoId)) return <NotFoundPage as="section" />;
  return <Post key={conteudoId} contentId={conteudoId} />;
}
