import { useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';

import { SimulatedPaymentResponseSchema } from '@ageniza/contracts';
import { Button, Field, TextInput } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { useApiClient } from './http.js';
import { formatBrl } from './subscription-format.js';

export type PaymentResult = 'approved' | 'declined' | 'failed';

/**
 * The card of the simulated provider (issue #773). It takes any number, validity, code and name and approves; none of those
 * fields is read, held in state or sent: what leaves this screen is the outcome the person chose, for a charge opened before.
 * "Simular recusa" is the way to test the failure path.
 */
export function SimulatedCardStep({ agencyId, chargeId, amountCents, summary, onFinish, onLeave }: {
  agencyId: string;
  chargeId: string;
  amountCents: number;
  /** What is being bought, as the server quoted it. */
  summary?: { planName: string; monthlyCents: number } | undefined;
  onFinish: (result: PaymentResult) => void;
  onLeave: () => void;
}) {
  const httpClient = useApiClient();
  const [pendingOutcome, setPendingOutcome] = useState<'approved' | 'declined' | undefined>();
  const sent = useRef(false);

  const pay = useMutation({
    mutationFn: (outcome: 'approved' | 'declined') => httpClient.request({
      path: apiPath('/agencies/:agenciaId/subscription/charges/:chargeId/simulated-payment', { agenciaId: agencyId, chargeId }),
      method: 'POST',
      body: { outcome },
      response: SimulatedPaymentResponseSchema
    }),
    onSuccess: (answer) => { onFinish(answer.status === 'confirmed' ? 'approved' : 'declined'); },
    onError: () => { onFinish('failed'); }
  });

  // One answer per charge: a second click while the first is in flight is ignored.
  const submit = (outcome: 'approved' | 'declined'): void => {
    if (sent.current) return;
    sent.current = true;
    setPendingOutcome(outcome);
    pay.mutate(outcome);
  };
  const busy = pay.isPending;

  return <form className="subscription-card" aria-labelledby="subscription-card-title" onSubmit={(event: FormEvent) => { event.preventDefault(); submit('approved'); }}>
    <h2 id="subscription-card-title" className="subscription-card__title"><CreditCard aria-hidden="true" /> Pagamento simulado</h2>
    <p className="subscription-card__lead">
      Isto é um pagamento de teste: qualquer dado serve, nenhum dado de cartão sai do seu navegador e nada é cobrado de verdade.
    </p>
    {summary !== undefined && <p className="subscription-card__plan">Plano <strong>{summary.planName}</strong>, {formatBrl(summary.monthlyCents)}/mês</p>}
    <p className="subscription-card__amount">Valor desta cobrança: <strong>{formatBrl(amountCents)}</strong></p>
    <div className="subscription-card__fields">
      <Field label="Número do cartão">{(control) => <TextInput {...control} inputMode="numeric" autoComplete="off" placeholder="0000 0000 0000" />}</Field>
      <Field label="Validade">{(control) => <TextInput {...control} autoComplete="off" placeholder="MM/AA" />}</Field>
      <Field label="CVV">{(control) => <TextInput {...control} inputMode="numeric" autoComplete="off" placeholder="000" />}</Field>
      <Field label="Nome impresso no cartão">{(control) => <TextInput {...control} autoComplete="off" />}</Field>
    </div>
    <div className="subscription-card__actions">
      <Button type="submit" loading={busy && pendingOutcome === 'approved'} disabled={busy && pendingOutcome !== 'approved'}>Pagar {formatBrl(amountCents)}</Button>
      <Button variant="secondary" loading={busy && pendingOutcome === 'declined'} disabled={busy && pendingOutcome !== 'declined'} onClick={() => { submit('declined'); }}>Simular recusa</Button>
      <Button variant="ghost" disabled={busy} onClick={onLeave}>Voltar sem pagar</Button>
    </div>
  </form>;
}
