import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ClientSchema, type Client, type ClientDetailResponse } from '@ageniza/contracts';
import { Button, FieldMessage, Menu, MenuItem, Modal, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { clientDetailQueryKey } from './client-detail.js';
import { HttpClientError, useApiClient } from './http.js';

const CLOSING_HINT = 'Até essa data tudo continua funcionando, inclusive o portal do cliente. No dia seguinte o cliente é arquivado automaticamente. Você pode desmarcar até lá.';
const ARCHIVE_EFFECTS = [
  'O portal deixa de funcionar para as pessoas do cliente imediatamente.',
  'Convites de portal pendentes são cancelados.',
  'Nada é apagado. Reativar devolve o acesso a quem já tinha.'
];
const DATE_REQUIRED = 'Informe o último dia do contrato.';
const DATE_IN_THE_PAST = 'A data precisa ser hoje ou depois.';
const VALIDATION_FAILED = 'Revise os dados informados.';
const NO_PERMISSION = 'Você não tem permissão para alterar este cliente.';
const CLOSING_FAILED = 'Não foi possível agendar o encerramento. Tente de novo.';
const ARCHIVE_FAILED = 'Não foi possível arquivar o cliente. Tente de novo.';
const CLEAR_FAILED = 'Não foi possível desmarcar o encerramento. Tente de novo.';
const REACTIVATE_FAILED = 'Não foi possível reativar o cliente. Tente de novo.';

/** Today in the agency's timezone (America/Sao_Paulo) as `YYYY-MM-DD` (SPEC §4: the day is the agency's). */
const agencyTodayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });

export const agencyToday = (now: Date = new Date()): string => agencyTodayFormatter.format(now);

/** Validation issues carry the field path the API refused; only that field is marked. */
const refusedClosingDate = (details: unknown): boolean => {
  const issues = (details as { issues?: Array<{ path?: unknown }> } | undefined)?.issues;
  return Array.isArray(issues) && issues.some((issue) => issue.path === 'closingDate' || String(issue.path).startsWith('closingDate.'));
};

const lifecycleError = (error: unknown, fallback: string): string => {
  if (!(error instanceof HttpClientError)) return fallback;
  if (error.code === 'FORBIDDEN' || error.status === 403) return NO_PERMISSION;
  if (error.code === 'CLIENT_ARCHIVED') return 'Cliente arquivado: a única ação possível é reativar.';
  return fallback;
};

/** Every lifecycle write invalidates the clients prefix: detail, roster, Acessos and Convites (SPEC §6). */
const useClientWrite = (client: ClientDetailResponse) => {
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const path = (suffix: string) =>
    apiPath(`/agencies/:agencyId/clients/:clientId${suffix}`, { agencyId: agency.agencyId, clientId: client.id });
  const applyClient = (updated: Client): void => {
    queryClient.setQueryData<ClientDetailResponse>(clientDetailQueryKey(agency.agencyId, client.id), (current) =>
      current === undefined ? current : { ...current, ...updated });
    void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'clients'] });
  };
  return { path, applyClient };
};

/**
 * The closing dialog (`specs/clientes.md` §7, issue #139): the last day of the contract, today or
 * later in the agency's timezone. The confirmation says the portal keeps working until the date —
 * the assumption the text exists to prevent.
 */
function CloseContractDialog({ client, onClose }: { client: ClientDetailResponse; onClose: () => void }) {
  const httpClient = useApiClient();
  const { path, applyClient } = useClientWrite(client);
  const dateId = useId();
  const hintId = useId();
  const errorId = useId();
  const [closingDate, setClosingDate] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const min = agencyToday();

  const save = useMutation({
    mutationFn: (date: string) => httpClient.request({
      path: path('/closing'),
      method: 'PUT',
      body: { closingDate: date },
      response: ClientSchema
    }),
    onSuccess: (updated) => { applyClient(updated); onClose(); },
    onError: (error: unknown) => {
      if (error instanceof HttpClientError && error.code === 'CLIENT_ARCHIVED') { setFormError(lifecycleError(error, CLOSING_FAILED)); return; }
      if (error instanceof HttpClientError && error.status === 400) {
        if (refusedClosingDate(error.details)) setFieldError(DATE_IN_THE_PAST);
        else setFormError(VALIDATION_FAILED);
        return;
      }
      setFormError(lifecycleError(error, CLOSING_FAILED));
    }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (closingDate === '') { setFieldError(DATE_REQUIRED); return; }
    // `YYYY-MM-DD` compares as text, and `min` is the agency's today; the API checks it again.
    if (closingDate < min) { setFieldError(DATE_IN_THE_PAST); return; }
    save.mutate(closingDate);
  };

  return <Modal title={`Encerrar contrato de ${client.name}`} closeLabel="Fechar encerramento do contrato" onClose={onClose}>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <div className="form-field">
        <label htmlFor={dateId}>Último dia do contrato</label>
        <TextInput
          id={dateId}
          name="closingDate"
          type="date"
          min={min}
          value={closingDate}
          onChange={(event) => { setClosingDate(event.target.value); setFieldError(undefined); setFormError(undefined); }}
          aria-invalid={fieldError !== undefined}
          aria-describedby={fieldError === undefined ? hintId : `${hintId} ${errorId}`}
        />
        <p id={hintId} className="form-hint">{CLOSING_HINT}</p>
        {fieldError !== undefined && <FieldMessage id={errorId} role="alert">{fieldError}</FieldMessage>}
      </div>
      {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
      <div className="form-actions">
        <Button type="submit" loading={save.isPending}>Agendar encerramento</Button>
        <Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>Cancelar</Button>
      </div>
    </form>
  </Modal>;
}

/**
 * The archive confirmation (`specs/clientes.md` §7, issue #139): immediate, and the text lists the
 * three effects — the portal drops, pending invitations are cancelled, nothing is deleted.
 */
function ArchiveClientDialog({ client, onClose }: { client: ClientDetailResponse; onClose: () => void }) {
  const httpClient = useApiClient();
  const { path, applyClient } = useClientWrite(client);
  const [error, setError] = useState<string | undefined>();

  const archive = useMutation({
    mutationFn: () => httpClient.request({ path: path('/archive'), method: 'POST', response: ClientSchema }),
    onSuccess: (updated) => { applyClient(updated); onClose(); },
    onError: (archiveError: unknown) => { setError(lifecycleError(archiveError, ARCHIVE_FAILED)); }
  });

  return <Modal title={`Arquivar ${client.name} agora?`} closeLabel="Fechar arquivamento do cliente" onClose={onClose}>
    <div className="form-stack">
      <ul className="client-lifecycle__effects">
        {ARCHIVE_EFFECTS.map((effect) => <li key={effect}>{effect}</li>)}
      </ul>
      {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
      <div className="form-actions">
        <Button variant="secondary" disabled={archive.isPending} onClick={onClose}>Cancelar</Button>
        <Button loading={archive.isPending} onClick={() => { setError(undefined); archive.mutate(); }}>Arquivar</Button>
      </div>
    </div>
  </Modal>;
}

/**
 * The header's lifecycle controls (`specs/clientes.md` §7, issue #139): the `⋯` menu for
 * `cliente.arquivar` on an active client — schedule or clear the closing, archive now — and the
 * single Reactivate action on an archived one. Without the permission nothing here exists.
 */
export function ClientLifecycleActions({ client }: { client: ClientDetailResponse }) {
  const httpClient = useApiClient();
  const canArchive = useCan('cliente.arquivar');
  const { path, applyClient } = useClientWrite(client);
  const [closingOpen, setClosingOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const clearClosing = useMutation({
    mutationFn: () => httpClient.request({ path: path('/closing'), method: 'DELETE', response: ClientSchema }),
    onSuccess: (updated) => { applyClient(updated); setError(undefined); },
    onError: (clearError: unknown) => {
      if (clearError instanceof HttpClientError && clearError.code === 'CLOSING_DATE_NOT_SET') {
        setError('Este cliente não tem encerramento agendado.');
        return;
      }
      if (clearError instanceof HttpClientError && clearError.code === 'CLIENT_NOT_ARCHIVED') {
        setError('Este cliente já está ativo.');
        return;
      }
      setError(lifecycleError(clearError, CLEAR_FAILED));
    }
  });

  const reactivate = useMutation({
    mutationFn: () => httpClient.request({ path: path('/reactivate'), method: 'POST', response: ClientSchema }),
    onSuccess: (updated) => { applyClient(updated); setError(undefined); },
    onError: (reactivateError: unknown) => {
      // The conflict message is product copy written by the API ("renomeie um dos dois antes").
      if (reactivateError instanceof HttpClientError && reactivateError.code === 'CLIENT_NAME_IN_USE') {
        setError(reactivateError.message);
        return;
      }
      if (reactivateError instanceof HttpClientError && reactivateError.code === 'CLIENT_NOT_ARCHIVED') {
        setError('Este cliente já está ativo.');
        return;
      }
      setError(lifecycleError(reactivateError, REACTIVATE_FAILED));
    }
  });

  if (!canArchive) return null;

  return <div className="client-lifecycle">
    {client.status === 'archived'
      ? <Button loading={reactivate.isPending} onClick={() => { setError(undefined); reactivate.mutate(); }}>Reativar</Button>
      : <Menu
          label="Ações do cliente"
          triggerLabel="Ações do cliente"
          trigger={<span aria-hidden="true">⋯</span>}
        >
          <MenuItem onClick={() => { setError(undefined); setClosingOpen(true); }}>Encerrar contrato…</MenuItem>
          {client.closingDate !== null && <MenuItem onClick={() => { setError(undefined); clearClosing.mutate(); }}>Desmarcar encerramento</MenuItem>}
          <MenuItem onClick={() => { setError(undefined); setArchiveOpen(true); }}>Arquivar agora…</MenuItem>
        </Menu>}
    {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
    {closingOpen && <CloseContractDialog client={client} onClose={() => setClosingOpen(false)} />}
    {archiveOpen && <ArchiveClientDialog client={client} onClose={() => setArchiveOpen(false)} />}
  </div>;
}