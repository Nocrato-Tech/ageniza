import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, FlaskConical } from 'lucide-react';

import {
  SaveSubscriptionTestCardRequestSchema,
  SubscriptionTestCardResponseSchema,
  TEST_CARD_BRAND,
  TEST_CARD_FIRST_YEAR,
  TEST_CARD_LAST_YEAR,
  type SaveSubscriptionTestCardRequest,
  type SubscriptionTestCard
} from '@ageniza/contracts';
import { Button, Field, FieldMessage, Modal, TextInput } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';
import { formatExpiry } from './subscription-format.js';
import { testCardQuery } from './subscription-queries.js';

const FORM_ID = 'subscription-test-card-form';
const LAST4_INVALID = 'Informe os 4 últimos dígitos do cartão de teste.';
const EXPIRY_INVALID = `Informe a validade como MM/AAAA, com o ano de ${TEST_CARD_FIRST_YEAR} a ${TEST_CARD_LAST_YEAR}.`;
const REFUSED = 'O cartão foi recusado. Confira os 4 últimos dígitos e a validade: só cartões de teste são aceitos.';
const SAVE_FAILED = 'Não foi possível salvar o cartão. Tente de novo.';

/** "08/2028" typed by a person; two digits of year are not guessed into a century. */
const parseExpiry = (value: string): { expMonth: number; expYear: number } | undefined => {
  const match = /^(\d{1,2})\s*\/\s*(\d{4})$/.exec(value.trim());
  if (match === null) return undefined;
  const expMonth = Number(match[1]);
  const expYear = Number(match[2]);
  return expMonth >= 1 && expMonth <= 12 && expYear >= TEST_CARD_FIRST_YEAR && expYear <= TEST_CARD_LAST_YEAR ? { expMonth, expYear } : undefined;
};

/**
 * Saves or replaces the test card. Only what the contract keeps travels: the last four digits, the expiry and the brand `test`. The
 * number and the security code are never asked for here, so there is nothing of them to hold or to send.
 */
function TestCardDialog({ agencyId, card, onClose, onSaved }: {
  agencyId: string;
  card: SubscriptionTestCard | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const httpClient = useApiClient();
  const [last4, setLast4] = useState('');
  const [expiry, setExpiry] = useState('');
  const [invalid, setInvalid] = useState(false);
  const saving = useRef(false);

  const save = useMutation({
    mutationFn: (body: SaveSubscriptionTestCardRequest) => httpClient.request({
      path: apiPath('/agencies/:agenciaId/subscription/test-card', { agenciaId: agencyId }),
      method: 'PUT',
      body,
      response: SubscriptionTestCardResponseSchema
    }),
    onSuccess: onSaved
  });

  const parsedExpiry = parseExpiry(expiry);
  const last4Valid = /^\d{4}$/.test(last4);
  const failure = !save.isError ? undefined : save.error instanceof HttpClientError && save.error.status === 400 ? REFUSED : SAVE_FAILED;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (saving.current) return;
    if (!last4Valid || parsedExpiry === undefined) { setInvalid(true); return; }
    saving.current = true;
    save.mutate(SaveSubscriptionTestCardRequestSchema.parse({ last4, ...parsedExpiry, brand: TEST_CARD_BRAND }), { onSettled: () => { saving.current = false; } });
  };

  return <Modal
    title={card === null ? 'Cadastrar o cartão' : 'Trocar o cartão'}
    closeLabel="Fechar o cartão"
    size="sm"
    description={card === null
      ? 'O cartão será usado a partir da próxima cobrança.'
      : `O novo cartão será usado a partir da próxima cobrança. O cartão atual é final ${card.last4}.`}
    onClose={() => { if (!save.isPending) onClose(); }}
    actions={<>
      <Button variant="secondary" disabled={save.isPending} onClick={onClose}>Cancelar</Button>
      <Button type="submit" form={FORM_ID} loading={save.isPending}>Salvar o cartão</Button>
    </>}
  >
    <form id={FORM_ID} className="subscription-test-card__form" noValidate onSubmit={submit}>
      <p className="subscription-test-card__note" role="note"><FlaskConical aria-hidden="true" /><span><strong>Ambiente de teste: nenhum valor é cobrado.</strong> Guardamos só os 4 últimos dígitos, a validade e a marca de teste; o número e o código de segurança nunca são pedidos.</span></p>
      <Field label="4 últimos dígitos" error={invalid && !last4Valid ? LAST4_INVALID : undefined}>
        {(control) => <TextInput {...control} inputMode="numeric" autoComplete="off" maxLength={4} placeholder="4242" value={last4} onChange={(event) => { setLast4(event.target.value); }} />}
      </Field>
      <Field label="Validade" hint="MM/AAAA" error={invalid && parsedExpiry === undefined ? EXPIRY_INVALID : undefined}>
        {(control) => <TextInput {...control} inputMode="numeric" autoComplete="off" placeholder="08/2028" value={expiry} onChange={(event) => { setExpiry(event.target.value); }} />}
      </Field>
      <p className="subscription-test-card__brand">Marca: cartão de teste</p>
      {failure !== undefined && <FieldMessage role="alert">{failure}</FieldMessage>}
    </form>
  </Modal>;
}

/**
 * "Cartão e cobranças" of the test card (decision 2026-11-11): "final 4242 · vence 08/2028" with "Trocar". It renders nothing where the API has
 * no test card (production answers 404), and nothing while it has not answered: the card is never a reason to hold the page.
 */
export function TestCardRow({ agencyId, onSaved }: { agencyId: string; onSaved: (message: string) => void }) {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const query = useQuery(testCardQuery(httpClient, agencyId));
  const [editing, setEditing] = useState(false);

  if (query.isError) return <p className="subscription-test-card__failure" role="alert">Não foi possível ler o cartão salvo.</p>;
  if (query.data === undefined || !query.data.available) return null;
  const { card } = query.data;

  return <>
    <div className="subscription-test-card">
      <span className="subscription-test-card__icon" aria-hidden="true"><CreditCard /></span>
      <span className="subscription-test-card__main">
        <strong>{card === null ? 'Nenhum cartão ainda' : 'Cartão salvo'}</strong>
        <span>{card === null ? 'Cadastre um cartão de teste para as próximas cobranças' : `final ${card.last4} · vence ${formatExpiry(card.expMonth, card.expYear)}`}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={() => { setEditing(true); }}>{card === null ? 'Cadastrar' : 'Trocar'}</Button>
    </div>
    {editing && <TestCardDialog
      agencyId={agencyId}
      card={card}
      onClose={() => { setEditing(false); }}
      onSaved={() => {
        setEditing(false);
        void queryClient.invalidateQueries({ queryKey: testCardQuery(httpClient, agencyId).queryKey });
        onSaved('Cartão salvo. Vale a partir da próxima cobrança.');
      }}
    />}
  </>;
}
