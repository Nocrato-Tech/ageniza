import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Pencil } from 'lucide-react';

import {
  CalendarDaySchema,
  PORTAL_APPROVAL_TOKEN_PATTERN,
  PortalApprovalBatchSchema,
  PortalApprovalContentSchema,
  PortalApprovalExchangeResponseSchema,
  PortalApprovalMediaUrlResponseSchema,
  type ContentFormat,
  type PortalApprovalApproveRequest,
  type PortalApprovalBatch,
  type PortalApprovalContent,
  type PortalContentMediaUrlResponse,
  type PortalApprovalRequestChangesRequest
} from '@ageniza/contracts';
import { Avatar, Button, ButtonLink, FieldMessage, FormatTag, LiveStatus, Logo, Skeleton, StatusTag } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { Phone } from './content-feed.js';
import { FormatShape, isHttpUrl } from './content-cover.js';
import { fullDayLabel } from './content-dates.js';
import { FORMAT_LABELS, FORMAT_TONES } from './content-labels.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { PORTAL_STATUS_LABELS, PORTAL_STATUS_TAGS } from './portal-status.js';
import { COMMENT_MESSAGES, RequestChangesDialog, type RequestError } from './request-changes-dialog.js';
import { signUpEmailState } from './sign-up.js';
import { signedUrlStaleTime, URL_MARGIN_MS } from './signed-url.js';
import { StatusPanel } from './status-panel.js';

/**
 * `/aprovar#<token>`, the page of the link in the e-mail "conteúdos para aprovar" (issue #717, decision 2026-10-26): no login and no
 * account, only the contents of one batch, each on a phone, with Aprovar and Pedir ajuste. The token is in the fragment, which the
 * browser never sends: the page reads it, erases it from the address bar before anything else, and exchanges it, in the body of one
 * POST, for the cookie of the approval session. Opening the link decides nothing; the two decisions are clicks.
 */

const SESSION_PATH = '/portal-approval/session';
const BATCH_PATH = '/portal-approval/batch';
const CONTENT_PATH = '/portal-approval/contents/:contentId';
const MEDIA_URL_PATH = '/portal-approval/contents/:contentId/media/:assetId/url';

/** A refresh of a signed URL is never closer than this to the last one: a refused refresh must not become a loop. */
const MIN_MEDIA_REFRESH_MS = 1_000;

const MESSAGES = {
  loading: 'Carregando os conteúdos…',
  invalidTitle: 'Este link não vale mais',
  invalid: 'Abra o e-mail mais recente ou peça um novo link à agência.',
  expiredTitle: 'Sua sessão venceu',
  expired: 'Abra o link do e-mail de novo para continuar. Se o link ainda valer, ele abre uma sessão nova.',
  limited: 'Muitas tentativas agora. Espere alguns minutos e tente de novo.',
  loadFailed: 'Não foi possível carregar os conteúdos. Confira a conexão e tente de novo.',
  refreshFailed: 'Não foi possível atualizar a lista. Recarregue a página.',
  revisionChanged: 'A agência alterou este conteúdo depois que você o abriu. Mostramos a versão atual: leia de novo antes de aprovar.',
  stateChanged: 'A situação deste conteúdo mudou enquanto você o via. Mostramos a situação atual.',
  tryAgain: 'Não foi possível agora. Tente de novo em instantes.',
  approveFailed: 'Não foi possível aprovar. Tente de novo.',
  requestFailed: 'Não foi possível enviar o pedido. Tente de novo.',
  approved: 'Conteúdo aprovado. Obrigado!',
  requested: 'Pedido de ajuste enviado. A agência vai ver a sua mensagem.',
  nothingToApprove: 'Nada para aprovar agora',
  nothingLead: 'Os conteúdos deste e-mail já foram decididos.',
  emptyBatch: 'Não há conteúdos neste e-mail no momento.',
  inProduction: 'Este conteúdo ainda está em produção. Quando estiver pronto, ele chega aqui para você aprovar.',
  noCaption: 'Este post não tem legenda.',
  noMedia: 'Este conteúdo ainda não tem mídia.',
  mediaFailed: 'Não foi possível carregar esta mídia.',
  ...COMMENT_MESSAGES
} as const;

const isCode = (error: unknown, code: string): boolean => error instanceof HttpClientError && error.code === code;
const isStatus = (error: unknown, status: number): boolean => error instanceof HttpClientError && error.status === status;

/** The one answer for a dead link: unknown, expired, revoked, archived client or suspended agency are the same 404 and the same screen. */
const isDeadLink = (error: unknown): boolean => isCode(error, 'APPROVAL_LINK_INVALID');

type Fragment = { readonly kind: 'none' } | { readonly kind: 'malformed' } | { readonly kind: 'token'; readonly value: string };

/**
 * Reads the token out of the address and erases it from the address bar in the same step, before any request: the entry of the
 * history is replaced, so neither the bar nor the back button holds it. Anything after `#` that is not a token is a wrong link.
 */
const takeFragment = (): Fragment => {
  const { hash, pathname, search } = window.location;
  if (hash === '') return { kind: 'none' };
  window.history.replaceState(window.history.state, '', `${pathname}${search}`);
  const value = hash.slice(1);
  return PORTAL_APPROVAL_TOKEN_PATTERN.test(value) ? { kind: 'token', value } : { kind: 'malformed' };
};

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly batch: PortalApprovalBatch }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'limited' }
  | { readonly kind: 'failed' };

const failurePhase = (error: unknown, hadBatch: boolean): Phase => {
  if (isDeadLink(error) || isStatus(error, 400)) return hadBatch ? { kind: 'expired' } : { kind: 'invalid' };
  if (isCode(error, 'RATE_LIMITED') || isStatus(error, 429)) return { kind: 'limited' };
  return { kind: 'failed' };
};

interface ApprovalLink {
  readonly phase: Phase;
  /** The lot is being read again after a conflict: a click in the meantime would carry a revision about to be replaced. */
  readonly reloading: boolean;
  readonly retry: () => void;
  readonly reload: () => Promise<boolean>;
  readonly replace: (content: PortalApprovalContent) => void;
  readonly expire: () => void;
}

/** The state of the page: exchange of the token, the lot, and what a decision or a new reading does to it. */
function useApprovalLink(): ApprovalLink {
  const httpClient = useApiClient();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [reloading, setReloading] = useState(false);
  const fragment = useRef<Fragment | undefined>(undefined);
  const everReady = useRef(false);
  const opening = useRef<Promise<void> | null>(null);
  // The newest reading wins: an answer that arrives after a newer one was asked for is dropped.
  const newest = useRef(0);

  const readBatch = (): Promise<PortalApprovalBatch> => httpClient.request({ path: BATCH_PATH, response: PortalApprovalBatchSchema });

  const open = (): Promise<void> => {
    if (opening.current !== null) return opening.current;
    const run = (async () => {
      const mine = ++newest.current;
      try {
        const found = fragment.current;
        if (found?.kind === 'malformed') { setPhase({ kind: 'invalid' }); return; }
        if (found?.kind === 'token') {
          await httpClient.request({ path: SESSION_PATH, method: 'POST', body: { token: found.value }, response: PortalApprovalExchangeResponseSchema });
          // The session cookie holds the access from here on: the page keeps no copy of the token.
          fragment.current = { kind: 'none' };
        }
        const batch = await readBatch();
        if (mine !== newest.current) return;
        everReady.current = true;
        setPhase({ kind: 'ready', batch });
      } catch (error: unknown) {
        if (mine === newest.current) setPhase(failurePhase(error, everReady.current));
      }
    })();
    opening.current = run;
    void run.finally(() => { if (opening.current === run) opening.current = null; });
    return run;
  };

  useEffect(() => {
    // Strict Mode runs this twice; the fragment is read once and the exchange is one promise both runs share.
    if (fragment.current === undefined) fragment.current = takeFragment();
    void open();
  }, []);

  const retry = (): void => {
    setPhase({ kind: 'loading' });
    void open();
  };

  const reload = async (): Promise<boolean> => {
    const mine = ++newest.current;
    setReloading(true);
    try {
      const batch = await readBatch();
      if (mine !== newest.current) return false;
      setPhase({ kind: 'ready', batch });
      return true;
    } catch (error: unknown) {
      if (mine === newest.current && isDeadLink(error)) setPhase({ kind: 'expired' });
      return false;
    } finally {
      if (mine === newest.current) setReloading(false);
    }
  };

  const replace = (content: PortalApprovalContent): void => {
    setPhase((current) => current.kind === 'ready'
      ? { kind: 'ready', batch: { ...current.batch, contents: current.batch.contents.map((entry) => entry.id === content.id ? content : entry) } }
      : current);
  };

  const expire = (): void => { setPhase({ kind: 'expired' }); };

  return { phase, reloading, retry, reload, replace, expire };
}

/**
 * The referrer policy of this page is its own, whatever the document says: a `meta` that is already there is set for as long as the
 * page is open and put back after, and one that is not there is added and removed. The static document carries the same value.
 */
function useNoReferrer(): void {
  useEffect(() => {
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    const created = meta === null;
    const before = meta?.content ?? '';
    if (meta === null) {
      meta = document.createElement('meta');
      meta.name = 'referrer';
      document.head.append(meta);
    }
    meta.content = 'no-referrer';
    const kept = meta;
    return () => {
      if (created) kept.remove();
      else kept.content = before;
    };
  }, []);
}

/** A day is read as text and never through a `Date`: the planned day is São Paulo's, whatever the browser's zone. */
const dayText = (day: string): string => CalendarDaySchema.safeParse(day).success ? fullDayLabel(day) : day;

/** The instant the link stops working, as a day of São Paulo. */
const linkExpiryText = (iso: string): string => new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));

const isVideoFormat = (format: ContentFormat): boolean => format !== 'image' && format !== 'carousel';

/**
 * The signed address of a media. It lasts minutes, so it is asked for again shortly before it expires (while the page is open),
 * when the tab comes back to the front with a stale one, and by the control of the media when the browser refused it.
 */
function useApprovalMediaUrl(contentId: string, assetId: string, variant: 'original' | 'thumbnail', enabled = true) {
  const httpClient = useApiClient();
  return useQuery<PortalContentMediaUrlResponse>({
    queryKey: ['approval', 'media', contentId, assetId, variant],
    enabled,
    staleTime: signedUrlStaleTime,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.data === undefined || query.state.status === 'error'
      ? false
      : Math.max(MIN_MEDIA_REFRESH_MS, Date.parse(query.state.data.expiresAt) - URL_MARGIN_MS - Date.now()),
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath(MEDIA_URL_PATH, { contentId, assetId })}?variant=${variant}`,
      response: PortalApprovalMediaUrlResponseSchema,
      signal
    })
  });
}

const usableUrl = (data: PortalContentMediaUrlResponse | undefined): string | undefined =>
  data !== undefined && isHttpUrl(data.url) ? data.url : undefined;

type OpenContent = Exclude<PortalApprovalContent, { status: 'in_production' }>;

/** The media of the current slide: the original, and for a video its frame as the poster. */
function Slide({ content, item, position, total }: {
  content: OpenContent;
  item: OpenContent['media'][number];
  position: number;
  total: number;
}) {
  const [failed, setFailed] = useState(false);
  const asVideo = item.kind === 'video';
  const original = useApprovalMediaUrl(content.id, item.id, 'original');
  const poster = useApprovalMediaUrl(content.id, isVideoFormat(content.format) ? (content.coverAssetId ?? item.id) : item.id, 'thumbnail', asVideo);
  const url = usableUrl(original.data);
  const posterUrl = usableUrl(poster.data);

  if (original.isPending) return <Skeleton className="approval-post__skeleton" aria-busy="true" />;
  if (url === undefined || failed) {
    return <div className="approval-post__problem" role="alert">
      <p>{MESSAGES.mediaFailed}</p>
      <Button variant="secondary" loading={original.isFetching} onClick={() => { void original.refetch().then(() => { setFailed(false); }); }}>Tentar de novo</Button>
    </div>;
  }
  const label = `${content.title}: mídia ${position} de ${total}`;
  return asVideo
    ? <video className="approval-post__item" src={url} poster={posterUrl} controls playsInline preload="metadata" aria-label={label} onError={() => { setFailed(true); }} />
    : <img className="approval-post__item" src={url} alt={label} onError={() => { setFailed(true); }} />;
}

/** The media of the post, one at a time as on the profile: Anterior and Próxima move it and the counter says where it is. */
function ApprovalMedia({ content }: { content: OpenContent }) {
  const items = [...content.media].sort((left, right) => left.position - right.position);
  const [index, setIndex] = useState(0);
  const total = items.length;
  const current = Math.min(index, total - 1);
  const item = items[current];
  if (item === undefined) {
    return <div className="approval-post__stage approval-post__stage--empty">
      <FormatShape format={content.format} />
      <p>{MESSAGES.noMedia}</p>
    </div>;
  }
  return <div className="approval-post__media">
    <div className="approval-post__stage">
      <Slide key={item.id} content={content} item={item} position={current + 1} total={total} />
    </div>
    {total > 1 && <div className="approval-post__controls">
      <Button variant="secondary" disabled={current === 0} onClick={() => { setIndex(current - 1); }}><span aria-hidden="true">‹ </span>Anterior</Button>
      <p className="approval-post__counter" aria-live="polite">{current + 1} de {total}</p>
      <Button variant="secondary" disabled={current === total - 1} onClick={() => { setIndex(current + 1); }}>Próxima<span aria-hidden="true"> ›</span></Button>
    </div>}
  </div>;
}

/** The post as the client's profile will show it, on the phone of the feed. Every text from the server is a React text child. */
function PostOnPhone({ content, clientName }: { content: OpenContent; clientName: string }) {
  return <div className="approval-card__preview" role="group" aria-label={`Prévia de ${content.title} no celular`}>
    <Phone>
      <div className="approval-post">
        <div className="approval-post__author">
          <Avatar name={clientName} size="sm" />
          <span>{clientName}</span>
        </div>
        <ApprovalMedia content={content} />
        {content.caption === null || content.caption === ''
          ? <p className="approval-post__hint">{MESSAGES.noCaption}</p>
          : <p className="approval-post__caption">{content.caption}</p>}
      </div>
    </Phone>
  </div>;
}

interface Decisions {
  readonly busy: { readonly contentId: string; readonly action: 'approve' | 'request' } | null;
  readonly reloading: boolean;
  readonly cardError: { readonly contentId: string; readonly message: string } | undefined;
  readonly onApprove: (content: OpenContent) => void;
  readonly onAsk: (content: OpenContent) => void;
}

function ContentCard({ content, clientName, decisions }: { content: PortalApprovalContent; clientName: string; decisions: Decisions }) {
  const titleId = `approval-title-${content.id}`;
  const open = content.status === 'in_production' ? null : content;
  const mine = decisions.busy?.contentId === content.id;
  const anyBusy = decisions.busy !== null || decisions.reloading;
  const error = decisions.cardError?.contentId === content.id ? decisions.cardError.message : undefined;
  return <article className="approval-card" aria-labelledby={titleId}>
    <div className="approval-card__heading">
      <h3 id={titleId} className="approval-card__title">{content.title}</h3>
      <ul className="approval-card__meta" aria-label="Dados do conteúdo">
        <li><StatusTag status={PORTAL_STATUS_TAGS[content.status]}>{PORTAL_STATUS_LABELS[content.status]}</StatusTag></li>
        <li><FormatTag format={FORMAT_TONES[content.format]}>{FORMAT_LABELS[content.format]}</FormatTag></li>
        <li>
          <time dateTime={content.publishOn}>{dayText(content.publishOn)}</time>
          {'publishAtTime' in content && content.publishAtTime !== null && <> · {content.publishAtTime}</>}
        </li>
      </ul>
    </div>
    {open === null
      ? <p className="approval-card__hint">{MESSAGES.inProduction}</p>
      : <PostOnPhone content={open} clientName={clientName} />}
    {open !== null && content.canDecide && <div className="approval-card__actions">
      <Button variant="secondary" size="lg" leadingIcon={<Pencil />} disabled={anyBusy} onClick={() => { decisions.onAsk(open); }}>Pedir ajuste</Button>
      <Button size="lg" leadingIcon={<Check />} loading={mine && decisions.busy?.action === 'approve'} disabled={anyBusy && !mine} onClick={() => { decisions.onApprove(open); }}>Aprovar</Button>
    </div>}
    {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
  </article>;
}

interface Notice {
  readonly tone: 'success' | 'problem';
  readonly text: string;
}

function ReadyView({ batch, link }: { batch: PortalApprovalBatch; link: ApprovalLink }) {
  const httpClient = useApiClient();
  const [busy, setBusy] = useState<Decisions['busy']>(null);
  const [cardError, setCardError] = useState<Decisions['cardError']>();
  const [notice, setNotice] = useState<Notice | undefined>();
  const [asking, setAsking] = useState<OpenContent | null>(null);
  const [draft, setDraft] = useState('');
  const [requestError, setRequestError] = useState<RequestError | undefined>();
  const noticeRef = useRef<HTMLDivElement>(null);
  // The state of the mutation reaches the button a tick late: a second tap in between must not send a second request.
  const sending = useRef(false);

  // The button the person pressed leaves with the card: what the page answers takes the focus, where the person is.
  useEffect(() => {
    if (notice !== undefined) noticeRef.current?.focus();
  }, [notice]);

  const pending = batch.contents.filter((content) => content.canDecide);
  const others = batch.contents.filter((content) => !content.canDecide);

  /** A conflict means the lot on screen is old: it is read again and the page says why, in the place the person is looking. */
  const stale = async (text: string): Promise<void> => {
    setNotice({ tone: 'problem', text });
    const read = await link.reload();
    if (!read) setNotice((current) => current?.text === text ? { tone: 'problem', text: `${text} ${MESSAGES.refreshFailed}` } : current);
  };

  const send = async (content: OpenContent, action: 'approve' | 'request', path: string, body: PortalApprovalApproveRequest | PortalApprovalRequestChangesRequest): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    setBusy({ contentId: content.id, action });
    setCardError(undefined);
    setNotice(undefined);
    try {
      const updated = await httpClient.request({ path: apiPath(`${CONTENT_PATH}/${path}`, { contentId: content.id }), method: 'POST', body, response: PortalApprovalContentSchema });
      link.replace(updated);
      setRequestError(undefined);
      setDraft('');
      setAsking(null);
      setNotice({ tone: 'success', text: action === 'approve' ? MESSAGES.approved : MESSAGES.requested });
    } catch (error: unknown) {
      if (isDeadLink(error)) { link.expire(); return; }
      if (isCode(error, 'CONTENT_REVISION_CHANGED')) { setAsking(null); void stale(MESSAGES.revisionChanged); return; }
      if (isCode(error, 'CONTENT_NOT_AWAITING_APPROVAL') || isCode(error, 'NOT_FOUND')) { setAsking(null); void stale(MESSAGES.stateChanged); return; }
      if (action === 'request') {
        if (isCode(error, 'CONTENT_COMMENT_INVALID')) setRequestError({ message: MESSAGES.invalidCharacters, field: true });
        else setRequestError({ message: failureText(error, MESSAGES.requestFailed), field: false });
      } else {
        setCardError({ contentId: content.id, message: failureText(error, MESSAGES.approveFailed) });
      }
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const decisions: Decisions = {
    busy,
    reloading: link.reloading,
    cardError,
    onApprove: (content) => { void send(content, 'approve', 'approve', { revision: content.revision }); },
    onAsk: (content) => { setRequestError(undefined); setDraft(''); setAsking(content); }
  };

  return <>
    <div className="approval__intro">
      <h1 className="approval__title">Conteúdos para aprovar</h1>
      <p className="approval__lead">{batch.agencyName} enviou conteúdos de {batch.clientName} para a sua aprovação. Este link vale até {linkExpiryText(batch.linkExpiresAt)}.</p>
    </div>
    {notice !== undefined && <div ref={noticeRef} className="approval__notice" tabIndex={-1}>
      {notice.tone === 'success' ? <LiveStatus>{notice.text}</LiveStatus> : <FieldMessage role="alert">{notice.text}</FieldMessage>}
    </div>}
    <section className="approval__section" aria-labelledby="approval-pending-title">
      <h2 id="approval-pending-title" className="approval__heading">Para aprovar{pending.length > 0 && ` (${pending.length})`}</h2>
      {pending.length === 0
        ? <div className="approval__empty">
          <p className="approval__empty-title">{batch.contents.length === 0 ? MESSAGES.emptyBatch : MESSAGES.nothingToApprove}</p>
          {batch.contents.length > 0 && <p>{MESSAGES.nothingLead}</p>}
        </div>
        : <div className="approval__list">
          {pending.map((content) => <ContentCard key={content.id} content={content} clientName={batch.clientName} decisions={decisions} />)}
        </div>}
    </section>
    {others.length > 0 && <section className="approval__section" aria-labelledby="approval-others-title">
      <h2 id="approval-others-title" className="approval__heading">Outros conteúdos deste e-mail</h2>
      <div className="approval__list">
        {others.map((content) => <ContentCard key={content.id} content={content} clientName={batch.clientName} decisions={decisions} />)}
      </div>
    </section>}
    <section className="approval__section approval__account" aria-labelledby="approval-account-title">
      <h2 id="approval-account-title" className="approval__heading">Quer ver o portal?</h2>
      <p>Com uma conta você acompanha os conteúdos de {batch.clientName} sem precisar deste link.</p>
      <ButtonLink as={Link} to="/criar-conta" state={signUpEmailState(batch.personEmail)} variant="secondary" size="lg">Criar conta para ver o portal</ButtonLink>
    </section>
    {asking !== null && <RequestChangesDialog
      hint="A agência vai ver a sua mensagem."
      draft={draft}
      onDraft={(value) => { setDraft(value); setRequestError(undefined); }}
      pending={busy?.action === 'request'}
      error={requestError}
      onSubmit={(comment) => { void send(asking, 'request', 'request-changes', { revision: asking.revision, comment }); }}
      onClose={() => { if (!sending.current) { setAsking(null); setRequestError(undefined); } }}
    />}
  </>;
}

/** What went wrong with a decision that is not a conflict: a limit has its own words, anything else is the screen's. */
const failureText = (error: unknown, fallback: string): string => {
  if (isCode(error, 'RATE_LIMITED') || isStatus(error, 429)) return MESSAGES.limited;
  if (isCode(error, 'TRY_AGAIN')) return MESSAGES.tryAgain;
  return fallback;
};

function LoadingView() {
  return <section className="approval__loading" aria-busy="true" aria-label="Carregando os conteúdos">
    <h1 className="visually-hidden">Conteúdos para aprovar</h1>
    <LiveStatus>{MESSAGES.loading}</LiveStatus>
    <Skeleton className="approval__skeleton-title" />
    <Skeleton className="approval__skeleton-phone" />
  </section>;
}

function RetryView({ text, onRetry }: { text: string; onRetry: () => void }) {
  return <div className="approval__retry" role="alert">
    <p>{text}</p>
    <Button variant="secondary" size="lg" onClick={onRetry}>Tentar de novo</Button>
  </div>;
}

const HOME_ACTION = <ButtonLink as={Link} size="lg" to="/">Ir para o início</ButtonLink>;

export function ApprovalLinkPage() {
  const link = useApprovalLink();
  useDocumentTitle('Conteúdos para aprovar — Ageniza');
  useNoReferrer();
  const { phase } = link;

  return <div className="approval">
    <header className="approval__header"><Logo variant="on-light" height={28} /></header>
    <main id="main-content" className="approval__main">
      {phase.kind === 'loading' && <LoadingView />}
      {phase.kind === 'ready' && <ReadyView batch={phase.batch} link={link} />}
      {phase.kind === 'invalid' && <StatusPanel as="section" titleId="approval-invalid-title" title={MESSAGES.invalidTitle} action={HOME_ACTION}>{MESSAGES.invalid}</StatusPanel>}
      {phase.kind === 'expired' && <StatusPanel as="section" titleId="approval-expired-title" title={MESSAGES.expiredTitle} action={HOME_ACTION}>{MESSAGES.expired}</StatusPanel>}
      {phase.kind === 'limited' && <RetryView text={MESSAGES.limited} onRetry={link.retry} />}
      {phase.kind === 'failed' && <RetryView text={MESSAGES.loadFailed} onRetry={link.retry} />}
    </main>
    <footer className="approval__legal">
      <Link to="/termos" target="_blank" rel="noreferrer">Termos de uso</Link>
      <Link to="/privacidade" target="_blank" rel="noreferrer">Privacidade</Link>
    </footer>
  </div>;
}
