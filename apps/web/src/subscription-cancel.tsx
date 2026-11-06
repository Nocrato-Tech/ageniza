import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';

import { AuthNoContentResponseSchema, type SubscriptionOverviewResponse } from '@ageniza/contracts';
import { Button, FieldMessage, Modal } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';
import { formatDay, formatGb, formatInstant } from './subscription-format.js';

type Subscription = NonNullable<SubscriptionOverviewResponse['subscription']>;

const plural = (count: number, one: string, many: string): string => `${count.toLocaleString('pt-BR')} ${count === 1 ? one : many}`;

/**
 * The cost of cancelling, before the click (issue #773): what the agency has here and what happens when the period ends.
 * Only what the subscription already knows is counted (active clients and media in use): no route gives contents or
 * approvals without a new query, so they are not guessed.
 */
export function CancelSubscriptionDialog({ agencyId, subscription, onClose, onCanceled }: {
  agencyId: string;
  subscription: Subscription;
  onClose: () => void;
  onCanceled: () => void;
}) {
  const httpClient = useApiClient();
  const cancel = useMutation({
    mutationFn: () => httpClient.request({
      path: apiPath('/agencies/:agenciaId/subscription/cancel', { agenciaId: agencyId }),
      method: 'POST',
      response: AuthNoContentResponseSchema
    }),
    onSuccess: onCanceled
  });
  const confirming = useRef(false);
  const inGrace = subscription.graceEndsOn !== null;
  const failure = cancel.error instanceof HttpClientError && cancel.error.status === 409 ? cancel.error.message : 'Não foi possível cancelar agora. Tente de novo.';

  return <Modal
    title="Cancelar a assinatura?"
    closeLabel="Fechar o cancelamento"
    size="sm"
    onClose={() => { if (!cancel.isPending) onClose(); }}
    actions={<>
      <Button variant="secondary" disabled={cancel.isPending} onClick={onClose}>Manter a assinatura</Button>
      <Button variant="destructive" loading={cancel.isPending} onClick={() => {
        if (confirming.current) return;
        confirming.current = true;
        cancel.mutate(undefined, { onSettled: () => { confirming.current = false; } });
      }}>Cancelar a assinatura</Button>
    </>}
  >
    <div className="subscription-cancel">
      <section aria-labelledby="subscription-cancel-has">
        <h3 id="subscription-cancel-has">O que a agência tem no Ageniza</h3>
        <ul>
          <li>{plural(subscription.usedClients, 'cliente ativo', 'clientes ativos')}</li>
          <li>{formatGb(subscription.usedBytes)} de mídia guardada</li>
        </ul>
      </section>
      <section aria-labelledby="subscription-cancel-then">
        <h3 id="subscription-cancel-then">O que acontece</h3>
        <ul>
          {inGrace
            ? <li>O pagamento está atrasado: a agência fica somente leitura assim que você confirmar.</li>
            : subscription.currentPeriodEnd !== null && <li>O acesso continua até {formatInstant(subscription.currentPeriodEnd)}, sem nova cobrança. Depois, a agência fica somente leitura.</li>}
          <li>Os dados continuam guardados e visíveis.</li>
          {!inGrace && <li>Você pode manter a assinatura até o fim do período.</li>}
        </ul>
      </section>
      {inGrace && subscription.graceEndsOn !== null && <p className="subscription-cancel__note">O prazo para pagar ia até {formatDay(subscription.graceEndsOn)}.</p>}
      {cancel.isError && <FieldMessage role="alert">{failure}</FieldMessage>}
    </div>
  </Modal>;
}
