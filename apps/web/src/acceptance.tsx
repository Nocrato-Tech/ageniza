import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { LegalAcceptancesResponseSchema, type LegalDocumentKind } from '@ageniza/contracts';
import { Button, LiveStatus } from '@ageniza/ui';

import { AuthMessage } from './auth-layout.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient, type HttpClient } from './http.js';
import { LEGAL_KEY } from './legal-notice.js';
import { ownPathOrNull } from './own-path.js';
import { StatusPanel } from './status-panel.js';
import { LoadingPage } from './status-pages.js';

const ACCEPT_FAILED = 'Não foi possível registrar o aceite. Tente de novo.';
const READ_FAILED = 'Não foi possível carregar os documentos. Tente de novo.';

const DOCUMENTS: Record<LegalDocumentKind, { readonly name: string; readonly to: string }> = {
  terms: { name: 'Termos de Uso', to: '/termos' },
  privacy: { name: 'Política de Privacidade', to: '/privacidade' }
};

const readStatus = (httpClient: HttpClient) =>
  httpClient.request({ path: '/me/legal-acceptances', response: LegalAcceptancesResponseSchema });

/** The answer of an agency or portal route to an account that has not accepted the Terms and the Privacy Policy (`TERMS_NOT_ACCEPTED`). */
export const isTermsNotAccepted = (error: unknown): boolean =>
  error instanceof HttpClientError && error.status === 403 && error.code === 'TERMS_NOT_ACCEPTED';

/** To `/aceite` from a screen the account cannot open yet, carrying the address to come back to once it has accepted. */
export function TermsRedirect() {
  const location = useLocation();
  return <Navigate to="/aceite" replace state={{ returnTo: `${location.pathname}${location.search}` }} />;
}

/**
 * The block before the first use (specs/auth.md section 13): an account that has Google and has not accepted the Terms and the
 * Privacy Policy, or that Google took over, has no context until it does, so the resolve answers `none` and the person lands on
 * `/comecar`, which sends it to `/aceite` instead. The server decides (`required`); this only follows it. While the answer is on
 * its way the page waits, so the "Sua conta está pronta" screen is never drawn first, and when it cannot be read the page opens:
 * the server refuses what needs the acceptance.
 */
export function AcceptanceGate({ children }: { children: ReactNode }) {
  const httpClient = useApiClient();
  // No retries: a read that fails opens the screen at once instead of holding it behind the backoff.
  const status = useQuery({ queryKey: LEGAL_KEY, queryFn: () => readStatus(httpClient), retry: false });
  if (status.isPending) return <LoadingPage />;
  if (status.data?.required === true) return <Navigate to="/aceite" replace />;
  return <>{children}</>;
}

/**
 * `/aceite`: reading and accepting the Terms of Use and the Privacy Policy before the first use. One box for what is pending,
 * and each document is recorded on its own, as the API takes it: a failure in the second leaves the first recorded and the
 * retry sends only what is left. Once nothing is required the person goes on through the sign-in screen, which resolves where.
 */
export function AcceptancePage() {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // Where an agency or portal screen that was refused for the acceptance asked to come back to (`TermsRedirect`); only an
  // address of this app is followed, and without one the person goes on through the sign-in screen, which resolves where.
  const returnTo = ownPathOrNull((location.state as { returnTo?: unknown } | null)?.returnTo);
  const status = useQuery({ queryKey: LEGAL_KEY, queryFn: () => readStatus(httpClient) });
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  // State only changes on the next render: two clicks in one task both see `submitting` false.
  const sending = useRef(false);
  useDocumentTitle('Antes de começar — Ageniza');

  if (status.isPending) return <section className="page-status"><LiveStatus>Carregando…</LiveStatus></section>;
  if (status.isError) {
    return <StatusPanel as="section" alert titleId="accept-title" title="Antes de começar"
      action={<Button loading={status.isFetching} onClick={() => { void status.refetch(); }}>Tentar de novo</Button>}>
      {READ_FAILED}
    </StatusPanel>;
  }
  if (!status.data.required) return <Navigate to={returnTo ?? '/entrar'} replace />;

  const pending = status.data.documents.filter((entry) => entry.pending).map((entry) => entry.document);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!checked || sending.current) return;
    sending.current = true;
    setError(undefined);
    setSubmitting(true);
    try {
      for (const document of pending) {
        const response = await httpClient.request({ path: '/me/legal-acceptances', method: 'POST', body: { document }, response: LegalAcceptancesResponseSchema });
        queryClient.setQueryData(LEGAL_KEY, response);
      }
      navigate(returnTo ?? '/entrar', { replace: true });
    } catch (caught: unknown) {
      setError(caught instanceof HttpClientError && caught.status === 429 ? 'Muitas tentativas. Tente novamente mais tarde.' : ACCEPT_FAILED);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  };

  const links = pending.flatMap((document, index) => [
    ...(index === 0 ? [] : [index === pending.length - 1 ? ' e a ' : ', ']),
    <Link key={document} to={DOCUMENTS[document].to} target="_blank" rel="noopener noreferrer">{DOCUMENTS[document].name}</Link>
  ]);

  return <StatusPanel as="section" titleId="accept-title" title="Antes de começar"
    action={<form className="accept-form" onSubmit={onSubmit} noValidate>
      <label className="auth-check">
        <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        <span>Li e aceito {pending[0] === 'terms' ? 'os ' : 'a '}{links}</span>
      </label>
      {error !== undefined && <AuthMessage tone="danger" role="alert">{error}</AuthMessage>}
      <Button type="submit" className="auth-submit" size="lg" loading={submitting} disabled={!checked}>Continuar</Button>
    </form>}>
    Para usar o Ageniza, leia e aceite os documentos abaixo. Sem o aceite, a sua conta fica sem acesso.
  </StatusPanel>;
}
