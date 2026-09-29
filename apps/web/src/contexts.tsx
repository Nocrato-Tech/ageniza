import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AuthLogoutResponseSchema,
  ContextResolveResponseSchema,
  PutLastContextResponseSchema,
  type Context
} from '@ageniza/contracts';
import { Button, ChoiceCard, LiveStatus, Skeleton } from '@ageniza/ui';

import { useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';

const contextKey = (context: Context): string =>
  context.type === 'agency' ? `agency:${context.agencyId}` : `client:${context.clientId}`;

const contextTitle = (context: Context): string =>
  context.type === 'agency' ? context.agencyName : context.clientName;

// The two kinds are different products, so the distinction is the item's second line (specs/auth.md
// section 7): role for an agency, owning agency for a client portal.
const contextDescription = (context: Context): string =>
  context.type === 'agency' ? `Área da agência · ${context.roleName}` : `Portal do cliente · ${context.agencyName}`;

/** `agency:<uuid>` or `client:<uuid>`, the shape `resolve` accepts for `preferred` (UUIDs, either case). */
const PREFERRED_PATTERN = /^(?:agency|client):[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89abAB][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/;

/**
 * `GET /me/contexts/resolve` already ordered and highlighted the contexts (specs/auth.md section 7);
 * this screen renders that answer verbatim -- it never calls `/me/contexts` again and never sorts.
 * The `preferred` context (e.g. just accepted from an invitation) arrives in the URL and is
 * forwarded to `resolve`, which is the only place that fills `highlighted`. Choosing writes
 * `PUT /me/last-context` and enters the workspace.
 */
export function ContextSelectPage() {
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authStore = useAuthSessionStore();
  const [searchParams] = useSearchParams();
  useDocumentTitle('Onde você quer entrar? — Ageniza');

  const requestedPreferred = searchParams.get('preferred');
  // The server compares the exact string against UUIDs Postgres returns in lowercase, so normalize
  // before forwarding; a valid-but-uppercase UUID would otherwise highlight nothing.
  const preferred = requestedPreferred !== null && PREFERRED_PATTERN.test(requestedPreferred) ? requestedPreferred.toLowerCase() : undefined;

  const resolve = useQuery({
    queryKey: ['contexts', 'resolve', preferred ?? null],
    queryFn: () => httpClient.request({
      path: preferred === undefined ? '/me/contexts/resolve' : `/me/contexts/resolve?preferred=${encodeURIComponent(preferred)}`,
      response: ContextResolveResponseSchema
    })
  });

  const choose = useMutation({
    mutationFn: (context: Context) => httpClient.request({
      path: '/me/last-context',
      method: 'PUT',
      body: context.type === 'agency'
        ? { type: 'agency' as const, agencyId: context.agencyId }
        : { type: 'client' as const, clientId: context.clientId },
      response: PutLastContextResponseSchema
    }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['contexts'] });
      navigate('/app');
    },
    onError: (error: unknown) => {
      // The chosen context can stop being valid between the resolve and the click; reload the list
      // so the dead option disappears.
      if (error instanceof HttpClientError && error.status === 404) void queryClient.invalidateQueries({ queryKey: ['contexts'] });
    }
  });

  const signOut = useMutation({
    mutationFn: () => httpClient.request({ path: '/auth/logout', method: 'POST', response: AuthLogoutResponseSchema }),
    onSuccess: () => {
      queryClient.clear();
      authStore.end();
      navigate('/entrar');
    }
  });

  const decision = resolve.data?.decision;
  // `resolve` with no context ends the session server-side (specs/auth.md section 7): go to the
  // "no access" screen and drop the client session at once.
  useEffect(() => {
    if (decision === 'none') {
      navigate('/sem-acesso', { replace: true });
      authStore.end();
    }
  }, [decision, navigate, authStore]);

  if (resolve.isPending) {
    return <section aria-labelledby="context-select-title">
      <h1 id="context-select-title">Onde você quer entrar?</h1>
      <LiveStatus>Carregando seus contextos…</LiveStatus>
      <div className="ui-choice-list"><Skeleton /><Skeleton /></div>
    </section>;
  }

  if (resolve.isError) {
    return <section aria-labelledby="context-select-title">
      <h1 id="context-select-title">Onde você quer entrar?</h1>
      <p role="alert">Não foi possível carregar seus contextos.</p>
      <Button onClick={() => { void resolve.refetch(); }} disabled={resolve.isFetching}>Tentar de novo</Button>
    </section>;
  }

  // Exactly one valid context is entered without asking; none at all is handled by the effect above.
  if (resolve.data.decision === 'enter') return <Navigate to="/app" replace />;
  if (resolve.data.decision === 'none') return <LiveStatus>Encerrando a sessão…</LiveStatus>;

  const { contexts, highlighted } = resolve.data;
  const highlightedKey = highlighted === null ? null : contextKey(highlighted);

  const actionError = choose.isError
    ? 'Não foi possível entrar nesse contexto. Tente de novo.'
    : signOut.isError
      ? 'Não foi possível sair. Tente de novo.'
      : undefined;
  const retryAction = (): void => {
    // A 404 means the chosen context stopped being valid; resending it would fail again, so reload
    // the list instead.
    if (choose.isError && choose.error instanceof HttpClientError && choose.error.status === 404) void resolve.refetch();
    else if (choose.isError && choose.variables !== undefined) choose.mutate(choose.variables);
    else if (signOut.isError) signOut.mutate();
  };

  return <section aria-labelledby="context-select-title">
    <h1 id="context-select-title">Onde você quer entrar?</h1>
    {actionError !== undefined && <div role="alert">
      <p>{actionError}</p>
      <Button onClick={retryAction}>Tentar de novo</Button>
    </div>}
    <ul className="ui-choice-list">
      {contexts.map((context) => {
        const isHighlighted = contextKey(context) === highlightedKey;
        return <li key={contextKey(context)}>
          <ChoiceCard
            title={contextTitle(context)}
            description={contextDescription(context)}
            highlighted={isHighlighted}
            badge={isHighlighted ? 'Sugerido' : undefined}
            disabled={choose.isPending}
            aria-busy={choose.isPending && choose.variables === context ? true : undefined}
            onClick={() => choose.mutate(context)}
          />
        </li>;
      })}
    </ul>
    <Button variant="ghost" onClick={() => signOut.mutate()} disabled={signOut.isPending}>Sair</Button>
  </section>;
}
