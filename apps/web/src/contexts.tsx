import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AuthLogoutResponseSchema,
  ContextResolveResponseSchema,
  PutLastContextResponseSchema,
  type Context
} from '@ageniza/contracts';
import { Button, ChoiceCard, LiveStatus, Skeleton } from '@ageniza/ui';

import { useAuthSessionStore } from './auth.js';
import { contextDestination, contextTarget, rememberContext } from './context-destination.js';
import { contextDescription, contextKey, contextTitle } from './context-labels.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';

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
    onSuccess: (_data, context) => {
      queryClient.removeQueries({ queryKey: ['contexts'] });
      navigate(contextDestination(context), { replace: true });
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
  const enteredContext = resolve.data?.decision === 'enter' ? resolve.data.context : null;
  // `resolve` already ended the session on the server. Calling `logout` here would answer 401
  // without a session and trigger the session-ended redirect to `/entrar`; so only drop the client
  // session and the cache, then go to the "no access" screen.
  useEffect(() => {
    if (decision !== 'none') return;
    authStore.end();
    queryClient.clear();
    navigate('/sem-acesso', { replace: true });
  }, [decision, authStore, queryClient, navigate]);

  // Entering records the context as the last one and goes to its area (`/agencia/...` or
  // `/portal/...`), never `/app`.
  useEffect(() => {
    if (enteredContext === null) return;
    void rememberContext(httpClient, contextTarget(enteredContext));
    queryClient.removeQueries({ queryKey: ['contexts'] });
    navigate(contextDestination(enteredContext), { replace: true });
  }, [enteredContext, httpClient, queryClient, navigate]);

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
  if (resolve.data.decision === 'enter') return <LiveStatus>Entrando…</LiveStatus>;
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
