import { useId, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  CalendarDaySchema,
  CommentBodySchema,
  PortalContentDetailSchema,
  type ContentFormat,
  type PortalApproveContentRequest,
  type PortalContentDetail,
  type PortalRequestContentChangesRequest
} from '@ageniza/contracts';
import { Button, FieldMessage, LiveStatus, Modal, Skeleton, Textarea } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { Conversation } from './conversation.js';
import { fullDayLabel } from './content-dates.js';
import { FORMAT_LABELS } from './content-labels.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { portalClientQueryKey, usePortalClient, uuidPattern } from './portal.js';
import { PortalMediaCarousel } from './portal-content-media.js';
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

/** In the portal "aprovado" reads "Aprovado" (the agency's "Pronto para publicar" is its own word). */
const STATUS_LABELS: Readonly<Record<PortalContent['status'], string>> = {
  in_production: 'Em produção',
  awaiting_approval: 'Aguardando aprovação',
  adjusting: 'Em ajuste',
  approved: 'Aprovado',
  published: 'Publicado'
};

const STATE_NOTES: Readonly<Partial<Record<PortalContent['status'], string>>> = {
  adjusting: 'Foi pedido um ajuste. A agência vai revisar e enviar de novo para a sua aprovação.',
  approved: 'Este conteúdo está aprovado. A agência cuida da publicação.',
  published: 'Este conteúdo já foi publicado.'
};

const MESSAGES = {
  loadError: 'Não foi possível carregar o conteúdo.',
  revisionChanged: 'A agência alterou este conteúdo depois que você o abriu. Mostramos a versão atual: leia de novo antes de aprovar.',
  stateChanged: 'A situação deste conteúdo mudou enquanto você o via. Mostramos a situação atual.',
  tryAgain: 'Não foi possível agora. Tente de novo em instantes.',
  approveFailed: 'Não foi possível aprovar. Tente de novo.',
  requestFailed: 'Não foi possível enviar o pedido. Tente de novo.',
  approved: 'Conteúdo aprovado. Obrigado!',
  requested: 'Pedido de ajuste enviado. A agência vai ver a sua mensagem na conversa abaixo.',
  empty: 'Escreva o que precisa mudar.',
  tooLong: 'O pedido pode ter no máximo 5.000 bytes.',
  invalidCharacters: 'O texto contém caracteres que não são aceitos.'
} as const;

const isStatus = (error: unknown, status: number): boolean => error instanceof HttpClientError && error.status === status;
const isCode = (error: unknown, code: string): boolean => error instanceof HttpClientError && error.code === code;

/** The rule of the API, not a copy of it: the screen asks the contract's own schema and only words the answer. */
const commentProblem = (comment: string): string | undefined => {
  const parsed = CommentBodySchema.safeParse(comment);
  if (parsed.success) return undefined;
  const message = parsed.error.issues[0]?.message;
  if (message === 'must not be empty') return MESSAGES.empty;
  if (message === 'must be at most 5000 bytes') return MESSAGES.tooLong;
  return MESSAGES.invalidCharacters;
};

/** A day is read as text and never through a `Date`: the planned day is São Paulo's, whatever the browser's zone. */
const dayText = (day: string): string => CalendarDaySchema.safeParse(day).success ? fullDayLabel(day) : day;

function PostMeta({ content }: { content: PortalContent }) {
  const format: ContentFormat = content.format;
  return <ul className="portal-post__meta" aria-label="Dados do conteúdo">
    <li><span className={`portal-post__status portal-post__status--${content.status}`}>{STATUS_LABELS[content.status]}</span></li>
    <li>{FORMAT_LABELS[format]}</li>
    <li>
      <time dateTime={content.publishOn}>{dayText(content.publishOn)}</time>
      {'publishAtTime' in content && content.publishAtTime !== null && <> · {content.publishAtTime}</>}
    </li>
    {'publishedOn' in content && content.publishedOn !== null && <li>Publicado em <time dateTime={content.publishedOn}>{dayText(content.publishedOn)}</time></li>}
  </ul>;
}

function RequestChangesDialog({ draft, onDraft, pending, error, onSubmit, onClose }: {
  draft: string;
  onDraft: (value: string) => void;
  pending: boolean;
  error: string | undefined;
  onSubmit: (comment: string) => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [problem, setProblem] = useState<string | undefined>();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const found = commentProblem(draft);
    if (found !== undefined) { setProblem(found); return; }
    onSubmit(draft.trim());
  };

  return <Modal title="Pedir ajuste" closeLabel="Fechar pedido de ajuste" onClose={onClose}>
    <form className="portal-post__request" onSubmit={submit} noValidate>
      <label className="portal-post__request-label" htmlFor={fieldId}>O que precisa mudar?</label>
      <Textarea
        id={fieldId}
        value={draft}
        rows={5}
        placeholder="Escreva aqui"
        readOnly={pending}
        onChange={(event) => { onDraft(event.target.value); setProblem(undefined); }}
      />
      <p className="portal-post__hint">A agência vai ver a sua mensagem e responder na conversa deste conteúdo.</p>
      {(problem ?? error) !== undefined && <FieldMessage role="alert">{problem ?? error}</FieldMessage>}
      <div className="portal-post__actions">
        <Button type="submit" loading={pending}>Enviar pedido</Button>
      </div>
    </form>
  </Modal>;
}

/** `reloading` holds the buttons while the post is read again, so a click never carries a revision already replaced. */
function OpenPost({ content, reloading }: { content: OpenContent; reloading: boolean }) {
  const client = usePortalClient();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const key = portalContentQueryKey(client.id, content.id);
  const [notice, setNotice] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [requestError, setRequestError] = useState<string | undefined>();
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState('');
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
    return undefined;
  };

  const approve = useMutation({
    mutationFn: () => httpClient.request({
      path: apiPath(`${DETAIL_PATH}/approve`, { clientId: client.id, contentId: content.id }),
      method: 'POST',
      body: { revision: content.revision } satisfies PortalApproveContentRequest,
      response: PortalContentDetailSchema
    }),
    onSuccess: (updated) => {
      setActionError(undefined);
      setNotice(MESSAGES.approved);
      queryClient.setQueryData(key, updated);
      refresh();
    },
    onError: (error: unknown) => {
      setNotice(undefined);
      setActionError(stale(error) ?? MESSAGES.approveFailed);
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
      if (isCode(error, 'CONTENT_NOT_AWAITING_APPROVAL')) { setAsking(false); setActionError(MESSAGES.stateChanged); }
      else if (isCode(error, 'CONTENT_COMMENT_INVALID')) setRequestError(MESSAGES.invalidCharacters);
      else setRequestError(stale(error) ?? MESSAGES.requestFailed);
      refresh();
    },
    onSettled: () => { sending.current = false; }
  });

  const send = (action: () => void): void => {
    if (sending.current) return;
    sending.current = true;
    action();
  };

  const awaiting = content.status === 'awaiting_approval';
  const stateNote = STATE_NOTES[content.status];

  return <>
    <PortalMediaCarousel
      key={content.id}
      ids={{ clientId: client.id, contentId: content.id }}
      format={content.format}
      coverAssetId={content.coverAssetId}
      media={content.media}
      title={content.title}
    />
    <section className="portal-post__section" aria-labelledby="portal-post-caption">
      <h2 id="portal-post-caption">Legenda</h2>
      {content.caption === null || content.caption === ''
        ? <p className="portal-post__hint">Este post não tem legenda.</p>
        : <p className="portal-post__caption">{content.caption}</p>}
    </section>
    {awaiting && <section className="portal-post__section" aria-labelledby="portal-post-decision">
      <h2 id="portal-post-decision">Sua decisão</h2>
      <div className="portal-post__actions">
        <Button loading={approve.isPending} disabled={reloading || requestChanges.isPending} onClick={() => { setActionError(undefined); setNotice(undefined); send(() => { approve.mutate(); }); }}>Aprovar</Button>
        <Button variant="secondary" disabled={reloading || approve.isPending} onClick={() => { setRequestError(undefined); setAsking(true); }}>Pedir ajuste</Button>
      </div>
    </section>}
    {actionError !== undefined && <FieldMessage role="alert">{actionError}</FieldMessage>}
    {notice !== undefined && <LiveStatus>{notice}</LiveStatus>}
    {stateNote !== undefined && <p className="portal-post__hint">{stateNote}</p>}
    <section className="portal-post__section" aria-labelledby="portal-post-conversation">
      <h2 id="portal-post-conversation">Conversa com a agência</h2>
      <Conversation
        scope={{ side: 'client', clientId: client.id }}
        subject={{ contentId: content.id }}
        subjectLabel={content.title}
        canWrite
        readOnly={false}
        onWritten={refresh}
        headingLevel={3}
      />
    </section>
    {asking && <RequestChangesDialog
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
    <Skeleton className="portal-post__title-skeleton" />
    <Skeleton className="portal-post__media-skeleton" />
    <Skeleton />
  </section>;
}

function PostFailure({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return <section className="portal-post">
    <div role="alert">
      <p>{MESSAGES.loadError}</p>
      <Button variant="secondary" loading={retrying} onClick={onRetry}>Tentar de novo</Button>
    </div>
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
    <Link className="portal-post__back" to={`/portal/${client.id}/conteudos`}><span aria-hidden="true">‹ </span>Conteúdos</Link>
    <h1 id="portal-post-title">{content.title}</h1>
    <PostMeta content={content} />
    {query.isError && <div role="alert">
      <p>{MESSAGES.loadError}</p>
      <Button variant="secondary" loading={query.isFetching} onClick={() => { void query.refetch(); }}>Tentar de novo</Button>
    </div>}
    {content.status === 'in_production'
      ? <p className="portal-post__hint">Este conteúdo ainda está em produção. Quando estiver pronto, ele aparece aqui para você aprovar.</p>
      : <OpenPost content={content} reloading={query.isFetching} />}
  </article>;
}

export function PortalContentPage() {
  const { conteudoId = '' } = useParams();
  // A malformed id is a bad address, not a request: the API would answer 404 anyway.
  if (!uuidPattern.test(conteudoId)) return <NotFoundPage as="section" />;
  return <Post key={conteudoId} contentId={conteudoId} />;
}
