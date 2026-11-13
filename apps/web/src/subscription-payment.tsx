import { useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowUpRight, CalendarClock, Check, CircleAlert, FlaskConical, ReceiptText, ShieldCheck, Sparkles } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { SimulatedPaymentResponseSchema, type SubscriptionQuoteLine } from '@ageniza/contracts';
import { Button, ButtonLink, Field, LiveStatus, TextInput } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { useApiClient } from './http.js';
import { formatInstant, formatMoney, lineLabel } from './subscription-format.js';

/** How a payment ended for the screen that opened it: it approved, was refused, or the provider could not answer. */
export type PaymentResult = 'approved' | 'declined' | 'failed';

/** What is being bought, as the server quoted it: the screen adds no price of its own. */
export interface Purchase {
  kind: 'subscribe' | 'plan' | 'extras';
  planName: string;
  tagline: string | undefined;
  gain: string[];
  lines: SubscriptionQuoteLine[];
  monthlyCents: number;
  /** What the agency pays now for the plan it leaves; only on a raise, to show what is deducted. */
  currentMonthlyCents: number | undefined;
  /** The share of the period a raise charges; null when nothing is prorated. */
  daysLeft: number | null;
  periodDays: number | null;
  /** The end of the current period, when a raise is paid in the middle of one. */
  periodEnd: string | undefined;
  ceilings: { clients: number; gib: number };
}

const titleOf = (purchase: Purchase): string => purchase.kind === 'extras' ? 'Comprar extras' : purchase.kind === 'subscribe' ? `Assinar o ${purchase.planName}` : `Subir para o ${purchase.planName}`;

const approvedOf = (purchase: Purchase, amountCents: number): { title: string; text: string } => purchase.kind === 'extras'
  ? { title: 'Extras ativos', text: `Seu teto agora é de ${purchase.ceilings.clients} clientes e ${purchase.ceilings.gib} GB. A cobrança de ${formatMoney(amountCents)} foi confirmada.` }
  : { title: `Plano ${purchase.planName} ativo`, text: `Os novos tetos já valem: ${purchase.ceilings.clients} clientes ativos e ${purchase.ceilings.gib} GB. A cobrança de ${formatMoney(amountCents)} foi confirmada.` };

/**
 * The purchase screen of the simulated provider (issue #773), in the layout of the board: what is bought and what it unlocks, the sum line
 * by line, and what is paid now. The card takes any number, validity, code and name and approves; none of those fields is read, held in
 * state or sent: what leaves this screen is the outcome the person chose, for a charge opened before. A refusal stays here, and the next
 * try opens a new charge (the refused one is closed for good) before it pays.
 */
export function CheckoutStep({ agencyId, chargeId, amountCents, purchase, reopen, onApproved, onFinish, onLeave, onDone }: {
  agencyId: string;
  chargeId: string;
  amountCents: number;
  purchase: Purchase;
  /** Opens a new charge for the same terms and answers its id: what "Tentar de novo" does after a refusal. */
  reopen: () => Promise<string>;
  /** The payment was confirmed: the screen refreshes what it reads, and this one stays to say so. */
  onApproved: () => void;
  /** The payment could not be concluded: the screen leaves with the reason. */
  onFinish: (result: Exclude<PaymentResult, 'approved'>) => void;
  /** The person left without paying. */
  onLeave: () => void;
  /** The person is done reading the confirmation. */
  onDone: () => void;
}) {
  const httpClient = useApiClient();
  const location = useLocation();
  const [status, setStatus] = useState<'idle' | 'declined' | 'approved'>('idle');
  const [pendingOutcome, setPendingOutcome] = useState<'approved' | 'declined' | undefined>();
  const [currentCharge, setCurrentCharge] = useState(chargeId);
  const sent = useRef(false);

  const pay = useMutation({
    mutationFn: async (outcome: 'approved' | 'declined') => {
      const id = status === 'declined' ? await reopen() : currentCharge;
      setCurrentCharge(id);
      return httpClient.request({
        path: apiPath('/agencies/:agenciaId/subscription/charges/:chargeId/simulated-payment', { agenciaId: agencyId, chargeId: id }),
        method: 'POST',
        body: { outcome },
        response: SimulatedPaymentResponseSchema
      });
    },
    onSuccess: (answer) => {
      if (answer.status === 'confirmed') { setStatus('approved'); onApproved(); return; }
      setStatus('declined');
      sent.current = false;
    },
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
  const approved = approvedOf(purchase, amountCents);
  const payLabel = status === 'declined' ? 'Tentar de novo' : `${purchase.kind === 'subscribe' ? 'Assinar e pagar' : 'Pagar'} ${formatMoney(amountCents)}`;
  const deducted = purchase.currentMonthlyCents !== undefined && purchase.kind === 'plan' ? purchase.currentMonthlyCents : undefined;
  const difference = deducted === undefined ? undefined : purchase.monthlyCents - deducted;

  return <section className="subscription checkout" aria-labelledby="checkout-title">
    <nav className="subscription__crumbs" aria-label="Você está em">
      <button type="button" className="subscription__crumb-button" disabled={busy || status === 'approved'} onClick={onLeave}>Assinatura</button>
      <span aria-hidden="true">›</span>
      <span aria-current="page">Pagamento</span>
    </nav>
    <header className="subscription__head">
      <p className="subscription__eyebrow">Pagamento</p>
      <h1 id="checkout-title">{titleOf(purchase)}</h1>
      <p className="subscription__lead">Revise o que você ganha e confirme. Nada é cobrado de verdade.</p>
    </header>

    {status === 'approved'
      ? <section className="checkout__ok" aria-labelledby="checkout-ok-title">
        <LiveStatus>
          <span id="checkout-ok-title" className="checkout__ok-title">{approved.title}</span>
          <span>{approved.text}</span>
        </LiveStatus>
        <div className="subscription__actions">
          <Button onClick={onDone}>Voltar para a assinatura</Button>
          <ButtonLink as={Link} to={`/agencia/${agencyId}/assinatura/faturas`} state={location.state} variant="secondary" leadingIcon={<ReceiptText aria-hidden="true" />}>Ver a fatura</ButtonLink>
        </div>
      </section>
      : <form className="checkout__grid" aria-labelledby="checkout-title" onSubmit={(event: FormEvent) => { event.preventDefault(); submit('approved'); }}>
        <div className="checkout__main">
          <section className="subscription__block subscription__block--card" aria-labelledby="checkout-plan">
            <div className="checkout__plan-head">
              <div>
                <p className="subscription__eyebrow">Você escolheu</p>
                <h2 id="checkout-plan">{purchase.kind === 'extras' ? `Extras no ${purchase.planName}` : `Plano ${purchase.planName}`}</h2>
                {purchase.tagline !== undefined && <p className="checkout__lead">{purchase.tagline}</p>}
              </div>
              <span className="checkout__tag">{purchase.kind === 'subscribe' ? <Sparkles aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}{purchase.kind === 'subscribe' ? 'Começa hoje' : 'Libera na hora'}</span>
            </div>
            <div>
              <p className="checkout__label">O que você ganha</p>
              <ul className="checkout__gain">{purchase.gain.map((item) => <li key={item}><Check aria-hidden="true" />{item}</li>)}</ul>
            </div>
            {purchase.daysLeft !== null && purchase.periodEnd !== undefined && <p className="checkout__period"><CalendarClock aria-hidden="true" />Período atual até {formatInstant(purchase.periodEnd)} ({purchase.daysLeft} {purchase.daysLeft === 1 ? 'dia que falta' : 'dias que faltam'}).</p>}
          </section>

          <section className="subscription__block subscription__block--card" aria-labelledby="subscription-card-title">
            <h2 id="subscription-card-title">Como você quer pagar</h2>
            <p className="checkout__testnote" role="note"><FlaskConical aria-hidden="true" /><span><strong>Ambiente de teste: nenhum valor é cobrado.</strong> Isto é um pagamento de teste: qualquer dado serve e nenhum dado de cartão sai do seu navegador.</span></p>
            <div className="subscription-card__fields">
              <Field label="Número do cartão">{(control) => <TextInput {...control} inputMode="numeric" autoComplete="off" placeholder="0000 0000 0000" />}</Field>
              <Field label="Validade">{(control) => <TextInput {...control} autoComplete="off" placeholder="MM/AA" />}</Field>
              <Field label="CVV">{(control) => <TextInput {...control} inputMode="numeric" autoComplete="off" placeholder="000" />}</Field>
              <Field label="Nome impresso no cartão">{(control) => <TextInput {...control} autoComplete="off" />}</Field>
            </div>
          </section>
        </div>

        <aside className="subscription__block subscription__block--card checkout__sum" aria-labelledby="checkout-sum-title">
          <h2 id="checkout-sum-title">Resumo</h2>
          <ul className="checkout__lines">
            {purchase.lines.map((line) => <li key={line.kind}><span>{lineLabel(line, purchase.planName)}<small>por mês</small></span><span>{formatMoney(line.totalCents)}</span></li>)}
            {deducted !== undefined && <li><span>{`Plano atual`}<small>abatido</small></span><span>− {formatMoney(deducted)}</span></li>}
            {difference !== undefined && <li className="checkout__line--total"><span>Diferença por mês</span><span>{formatMoney(difference)}</span></li>}
            {difference === undefined && purchase.lines.length > 1 && <li className="checkout__line--total"><span>Total por mês</span><span>{formatMoney(purchase.monthlyCents)}</span></li>}
          </ul>
          {difference !== undefined && purchase.daysLeft !== null && purchase.periodDays !== null && <p className="checkout__note">Diferença de {formatMoney(difference)} × {purchase.daysLeft} de {purchase.periodDays} dias = {formatMoney(amountCents)}</p>}
          <div className="checkout__due">
            <span>Você paga agora</span>
            <strong>{formatMoney(amountCents)}</strong>
            <small>{purchase.periodEnd === undefined ? `Depois, ${formatMoney(purchase.monthlyCents)} por mês.` : `Depois, ${formatMoney(purchase.monthlyCents)} por mês a partir de ${formatInstant(purchase.periodEnd)}.`}</small>
          </div>
          {busy && <p className="checkout__state" role="status">Confirmando o pagamento… Não feche a página.</p>}
          {status === 'declined' && !busy && <p className="checkout__state checkout__state--bad" role="alert"><CircleAlert aria-hidden="true" /><span><strong>O cartão foi recusado.</strong> Nenhum valor foi cobrado e seu plano continua o mesmo. Tente de novo ou volte sem pagar.</span></p>}
          <div className="subscription-card__actions">
            <Button type="submit" loading={busy && pendingOutcome === 'approved'} disabled={busy && pendingOutcome !== 'approved'}>{payLabel}</Button>
            <Button variant="secondary" loading={busy && pendingOutcome === 'declined'} disabled={busy && pendingOutcome !== 'declined'} onClick={() => { submit('declined'); }}>Simular recusa</Button>
            <Button variant="ghost" disabled={busy} onClick={onLeave}>Voltar sem pagar</Button>
          </div>
          <p className="checkout__note"><ShieldCheck aria-hidden="true" />Cancele quando quiser, sem multa. Só a dona da agência paga e altera o plano.</p>
        </aside>
      </form>}
  </section>;
}
