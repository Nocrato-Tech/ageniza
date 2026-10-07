import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { LegalAcceptancesResponseSchema, type LegalAcceptancesResponse, type LegalDocumentKind } from '@ageniza/contracts';
import { Button } from '@ageniza/ui';

import { useApiClient } from './http.js';

const LEGAL_KEY = ['legal-acceptances'] as const;
const DISMISSED_KEY = ['legal-acceptances', 'dismissed'] as const;

const DOCUMENTS: Record<LegalDocumentKind, { readonly announcement: string; readonly read: string; readonly acceptLabel: string; readonly to: string }> = {
  terms: { announcement: 'Atualizamos os Termos de Uso', read: 'Ler os Termos de Uso', acceptLabel: 'Li e aceito os Termos de Uso', to: '/termos' },
  privacy: { announcement: 'Atualizamos a Política de Privacidade', read: 'Ler a Política de Privacidade', acceptLabel: 'Li e aceito a Política de Privacidade', to: '/privacidade' }
};

const acceptErrorMessage = 'Não foi possível registrar o aceite. Tente de novo.';

/**
 * The non-blocking notice of a Terms or Privacy Policy version newer than the one the account
 * accepted (specs/auth.md section 10). Nothing waits on it: it renders nothing while the status is
 * loading or when the read fails, and closing it only hides it until the session changes, because
 * the dismissal lives in the query cache, which login and logout clear. Each document is accepted on
 * its own, and the server decides the version recorded.
 */
export function LegalNotice() {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: LEGAL_KEY,
    queryFn: () => httpClient.request({ path: '/me/legal-acceptances', response: LegalAcceptancesResponseSchema })
  });
  const dismissed = useQuery({
    queryKey: DISMISSED_KEY,
    queryFn: () => false,
    initialData: false,
    staleTime: Infinity,
    gcTime: Infinity
  });
  const accept = useMutation({
    mutationFn: (document: LegalDocumentKind) => httpClient.request({
      path: '/me/legal-acceptances',
      method: 'POST',
      body: { document },
      response: LegalAcceptancesResponseSchema
    }),
    onSuccess: (response: LegalAcceptancesResponse) => { queryClient.setQueryData(LEGAL_KEY, response); }
  });

  const pending = status.data?.documents.filter((entry) => entry.pending) ?? [];
  if (dismissed.data || pending.length === 0) return null;

  return <section className="legal-notice" aria-label="Aviso sobre os documentos legais">
    <ul className="legal-notice__list">
      {pending.map(({ document }) => {
        const copy = DOCUMENTS[document];
        return <li className="legal-notice__item" key={document}>
          <p className="legal-notice__text">
            <strong>{copy.announcement}.</strong>{' '}
            <Link to={copy.to} target="_blank" rel="noopener noreferrer">{copy.read}</Link>
          </p>
          <Button
            size="sm"
            aria-label={copy.acceptLabel}
            loading={accept.isPending && accept.variables === document}
            disabled={accept.isPending}
            onClick={() => { accept.mutate(document); }}
          >Li e aceito</Button>
        </li>;
      })}
    </ul>
    {accept.isError && <p className="legal-notice__error" role="alert">{acceptErrorMessage}</p>}
    <Button variant="ghost" size="sm" aria-label="Fechar o aviso" onClick={() => { queryClient.setQueryData(DISMISSED_KEY, true); }}>Fechar</Button>
  </section>;
}
