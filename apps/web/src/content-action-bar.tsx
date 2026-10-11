import { useEffect, useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  CalendarDaySchema,
  ContentDetailSchema,
  type ApproveContentByAgencyRequest,
  type ContentDetail,
  type PublishContentRequest,
  type RescheduleContentRequest
} from '@ageniza/contracts';
import { Button, FieldMessage, Textarea, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import {
  ACTION_RULES,
  actionRefusal,
  actionsFor,
  missingForSubmit,
  reasonIssue,
  type ContentAction
} from './content-actions.js';
import { todayInSaoPaulo } from './content-dates.js';
import { useFolderAssets } from './content-media.js';
import { useApiClient } from './http.js';

const ACTION_PATH = '/agencies/:agencyId/clients/:clientId/contents/:contentId';

/** The moves that ask something first: a reason, the real day of the publication, the new day. */
type Panel = 'approve' | 'publish' | 'reschedule';

interface Request {
  readonly action: ContentAction;
  readonly body?: ApproveContentByAgencyRequest | PublishContentRequest | RescheduleContentRequest;
}

/**
 * The buttons of the six moves of a content (`specs/conteudo.md` section 4), each only for who holds its permission and
 * only in the state where the move exists. They act on the content as it is saved: while the form holds changes that
 * were not saved they wait, so a move never leaves with a caption nobody sent. UX only; the API checks every move.
 */
export function ContentActions({ clientId, content, dirty, onBusyChange, onDone }: {
  clientId: string;
  /** The content as saved: what the move acts on, and the revision an approval confirms. */
  content: ContentDetail;
  dirty: boolean;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const ids = useId();
  const canOperate = useCan('conteudo.operar');
  const canApprove = useCan('conteudo.aprovar_pela_agencia');
  const canPublish = useCan('conteudo.publicar');
  const canCancel = useCan('conteudo.cancelar');
  const permissions = new Set([
    ...(canOperate ? ['conteudo.operar'] : []),
    ...(canApprove ? ['conteudo.aprovar_pela_agencia'] : []),
    ...(canPublish ? ['conteudo.publicar'] : []),
    ...(canCancel ? ['conteudo.cancelar'] : [])
  ]);
  const available = actionsFor(content.status, (permission) => permissions.has(permission));
  const canSubmit = available.includes('submit');

  const assets = useFolderAssets(clientId, canSubmit ? content.folderId : '');
  const missing = missingForSubmit(content, assets.data);

  const [panel, setPanel] = useState<Panel | null>(null);
  const [reason, setReason] = useState('');
  const [publishedOn, setPublishedOn] = useState(() => todayInSaoPaulo());
  const [publishOn, setPublishOn] = useState(content.publishOn);
  const [problem, setProblem] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const move = useMutation({
    mutationFn: ({ action, body }: Request) => httpClient.request({
      path: `${apiPath(ACTION_PATH, { agencyId: agency.agencyId, clientId, contentId: content.id })}/${ACTION_RULES[action].segment}`,
      method: 'POST',
      ...(body === undefined ? {} : { body }),
      response: ContentDetailSchema
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId] });
      onDone();
    },
    onError: (failure, { action }) => {
      setError(actionRefusal(failure, action));
      // A refusal means the calendar behind may be stale: another operator moved it, or the client was archived.
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId] });
    }
  });

  const busy = move.isPending;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  if (available.length === 0) return null;

  const send = (request: Request): void => {
    setError(undefined);
    move.mutate(request);
  };

  const open = (next: Panel): void => {
    setError(undefined);
    setProblem(undefined);
    setPanel(panel === next ? null : next);
  };

  const confirmApprove = (): void => {
    const issue = reasonIssue(reason);
    setProblem(issue);
    if (issue === undefined) send({ action: 'approve', body: { revision: content.revision, reason } });
  };

  const confirmPublish = (): void => {
    const valid = CalendarDaySchema.safeParse(publishedOn).success && publishedOn <= todayInSaoPaulo();
    setProblem(valid ? undefined : 'Informe o dia real da publicação, que não pode ser futuro.');
    if (valid) send({ action: 'publish', body: { publishedOn } });
  };

  const confirmReschedule = (): void => {
    const valid = CalendarDaySchema.safeParse(publishOn).success;
    setProblem(valid ? undefined : 'Informe o novo dia da publicação.');
    if (valid) send({ action: 'reschedule', body: { publishOn } });
  };

  const waiting = busy || dirty;
  const button = (action: ContentAction, handler: () => void, disabled = false) => (
    <Button
      key={action}
      variant={action === 'submit' ? 'primary' : 'secondary'}
      loading={busy && move.variables.action === action}
      disabled={waiting || disabled}
      aria-expanded={action === 'approve' || action === 'publish' || action === 'reschedule' ? panel === action : undefined}
      onClick={handler}
    >{ACTION_RULES[action].label}</Button>
  );

  return <section className="content-actions" aria-label="Ações do conteúdo">
    {canSubmit && missing.length > 0 && <div role="status" className="content-actions__missing">
      <p>Antes de enviar para aprovação, falta:</p>
      <ul>{missing.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>}
    {dirty && <p className="form-hint">Salve as mudanças antes de usar estas ações.</p>}
    <div className="form-actions">
      {available.map((action) => {
        switch (action) {
          case 'submit': return button(action, () => send({ action }), missing.length > 0);
          case 'approve': return button(action, () => open('approve'));
          case 'publish': return button(action, () => open('publish'));
          case 'reschedule': return button(action, () => open('reschedule'));
          default: return button(action, () => send({ action }));
        }
      })}
    </div>
    {panel === 'approve' && available.includes('approve') && <div className="form-field content-actions__panel">
      <label htmlFor={`${ids}-reason`}>Motivo da aprovação</label>
      <Textarea
        id={`${ids}-reason`}
        rows={3}
        value={reason}
        disabled={busy}
        onChange={(event) => { setReason(event.target.value); setProblem(undefined); }}
        aria-invalid={problem !== undefined}
        aria-describedby={problem === undefined ? undefined : `${ids}-problem`}
      />
      {problem !== undefined && <FieldMessage id={`${ids}-problem`} role="alert">{problem}</FieldMessage>}
      <div className="form-actions">
        <Button loading={busy} disabled={busy} onClick={confirmApprove}>Confirmar aprovação</Button>
      </div>
    </div>}
    {panel === 'publish' && available.includes('publish') && <div className="form-field content-actions__panel">
      <label htmlFor={`${ids}-published`}>Dia real da publicação</label>
      <TextInput
        id={`${ids}-published`}
        type="date"
        max={todayInSaoPaulo()}
        value={publishedOn}
        disabled={busy}
        onChange={(event) => { setPublishedOn(event.target.value); setProblem(undefined); }}
        aria-invalid={problem !== undefined}
        aria-describedby={problem === undefined ? undefined : `${ids}-problem`}
      />
      {problem !== undefined && <FieldMessage id={`${ids}-problem`} role="alert">{problem}</FieldMessage>}
      <div className="form-actions">
        <Button loading={busy} disabled={busy} onClick={confirmPublish}>Confirmar publicação</Button>
      </div>
    </div>}
    {panel === 'reschedule' && available.includes('reschedule') && <div className="form-field content-actions__panel">
      <label htmlFor={`${ids}-reschedule`}>Novo dia da publicação</label>
      <TextInput
        id={`${ids}-reschedule`}
        type="date"
        value={publishOn}
        disabled={busy}
        onChange={(event) => { setPublishOn(event.target.value); setProblem(undefined); }}
        aria-invalid={problem !== undefined}
        aria-describedby={problem === undefined ? undefined : `${ids}-problem`}
      />
      {problem !== undefined && <FieldMessage id={`${ids}-problem`} role="alert">{problem}</FieldMessage>}
      <div className="form-actions">
        <Button loading={busy} disabled={busy} onClick={confirmReschedule}>Confirmar novo dia</Button>
      </div>
    </div>}
    {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
  </section>;
}
