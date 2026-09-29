import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate } from 'react-router-dom';
import { ContextResolveResponseSchema, type Context } from '@ageniza/contracts';
import { Button, ChoiceCard, Skeleton } from '@ageniza/ui';
import { z } from 'zod';

import { useAuthSessionStore } from './auth.js';
import { useApiClient } from './http.js';

/** `PUT /me/last-context` and `POST /auth/logout` answer 204; the client still wants a schema. */
const NoContentResponseSchema = z.void();

const contextKey = (context: Context): string =>
  context.type === 'agency' ? `agency:${context.agencyId}` : `client:${context.clientId}`;

const contextTitle = (context: Context): string =>
  context.type === 'agency' ? context.agencyName : context.clientName;

// The two kinds are different products, so the distinction is the item's second line (specs/auth.md
// section 7): role for an agency, owning agency for a client portal.
const contextDescription = (context: Context): string =>
  context.type === 'agency' ? `Área da agência · ${context.roleName}` : `Portal do cliente · ${context.agencyName}`;

/**
 * `GET /me/contexts/resolve` already ordered and highlighted the contexts (specs/auth.md section 7);
 * this screen renders that answer verbatim -- it never calls `/me/contexts` again and never sorts.
 * Choosing writes `PUT /me/last-context` and enters the workspace.
 */
export function ContextSelectPage() {
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authStore = useAuthSessionStore();

  const resolve = useQuery({
    queryKey: ['contexts', 'resolve'],
    queryFn: () => httpClient.request({ path: '/me/contexts/resolve', response: ContextResolveResponseSchema })
  });

  const choose = useMutation({
    mutationFn: (context: Context) => httpClient.request({
      path: '/me/last-context',
      method: 'PUT',
      body: context.type === 'agency'
        ? { type: 'agency' as const, agencyId: context.agencyId }
        : { type: 'client' as const, clientId: context.clientId },
      response: NoContentResponseSchema
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contexts'] });
      navigate('/app');
    }
  });

  const signOut = useMutation({
    mutationFn: () => httpClient.request({ path: '/auth/logout', method: 'POST', response: NoContentResponseSchema }),
    onSuccess: () => {
      authStore.end();
      navigate('/entrar');
    }
  });

  if (resolve.isPending) {
    return <section aria-labelledby="context-select-title">
      <h1 id="context-select-title">Onde você quer entrar?</h1>
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

  // Exactly one valid context is entered without asking; none at all ends the session server-side.
  if (resolve.data.decision === 'enter') return <Navigate to="/app" replace />;
  if (resolve.data.decision === 'none') return <Navigate to="/entrar" replace />;

  const { contexts, highlighted } = resolve.data;
  const highlightedKey = highlighted === null ? null : contextKey(highlighted);

  return <section aria-labelledby="context-select-title">
    <h1 id="context-select-title">Onde você quer entrar?</h1>
    <ul className="ui-choice-list">
      {contexts.map((context) => (
        <li key={contextKey(context)}>
          <ChoiceCard
            title={contextTitle(context)}
            description={contextDescription(context)}
            highlighted={contextKey(context) === highlightedKey}
            disabled={choose.isPending}
            aria-busy={choose.isPending && choose.variables === context ? true : undefined}
            onClick={() => choose.mutate(context)}
          />
        </li>
      ))}
    </ul>
    <Button variant="ghost" onClick={() => signOut.mutate()} disabled={signOut.isPending}>Sair</Button>
  </section>;
}
