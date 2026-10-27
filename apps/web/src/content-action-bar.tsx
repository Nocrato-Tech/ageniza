import { useEffect, useId, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, CalendarClock, Check, CheckCheck, Send, Undo2 } from 'lucide-react';

import {
  CalendarDaySchema,
  ContentDetailSchema,
  type ApproveContentByAgencyRequest,
  type ContentDetail,
  type PublishContentRequest,
  type RescheduleContentRequest
} from '@ageniza/contracts';
import { Button, DatePicker, FieldMessage, Textarea } from '@ageniza/ui';

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

const ACTION_ICONS: Readonly<Record<ContentAction, ReactNode>> = {
  submit: <Send />,
  approve: <Check />,
  publish: <CheckCheck />,
  unpublish: <Undo2 />,
  reschedule: <CalendarClock />,
  cancel: <Ban />
};

/** The move that carries the state forward is the one filled button of the footer, and only while nothing is waiting to be saved. */
const FORWARD: ReadonlySet<ContentAction> = new Set(['submit', 'approve', 'publish', 'reschedule']);

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
export function ContentActions({ clientId, content, dirty, onBusyChange, onDone, children }: {
  clientId: string;
  /** The content as saved: what the move acts on, and the revision an approval confirms. */
  content: ContentDetail;
  dirty: boolean;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
  /** The buttons of the form itself, which share the row of the footer with the moves but are not one of them. */
  children?: ReactNode;
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

  const assets = useFolderAssets(clientId, content.folderId);
  const missing = missingForSubmit(content, assets.data);

  const [panel, setPanel] = useState<Panel | null>(null);
  const [reason, setReason] = useState('');
  const [publishedOn, setPublishedOn] = useState(() => todayInSaoPaulo());
  const [publishOn, setPublishOn] = useState(content.publishOn);
  const [problem, setProblem] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // The move on its way is this screen's own state, set in the click: the mutation's reaches the buttons a render later, and a second click in between would send it twice.
  const [sending, setSending] = useState<ContentAction | null>(null);
  const move = useMutation({
    mutationFn: ({ action, body }: Request) => httpClient.request({
      path: `${apiPath(ACTION_PATH, { agencyId: agency.agencyId, clientId, contentId: content.id })}/${ACTION_RULES[action].segment}`,
      method: 'POST',
      ...(body === undefined ? {} : { body }),
      response: ContentDetailSchema
    }),
    onSettled: () => { setSending(null); },
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

  const busy = sending !== null;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  if (available.length === 0) return <div className="content-modal__footer-row">{children}</div>;

  const send = (request: Request): void => {
    if (sending !== null) return;
    setSending(request.action);
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
      className={action === 'cancel' ? 'content-actions__cancel' : undefined}
      variant={FORWARD.has(action) && !dirty ? 'primary' : action === 'cancel' ? 'ghost' : 'secondary'}
      leadingIcon={ACTION_ICONS[action]}
      loading={sending === action}
      disabled={waiting || disabled}
      aria-expanded={action === 'approve' || action === 'publish' || action === 'reschedule' ? panel === action : undefined}
      onClick={handler}
    >{ACTION_RULES[action].label}</Button>
  );
  const buttonOf = (action: ContentAction) => {
    switch (action) {
      case 'submit': return button(action, () => send({ action }), missing.length > 0);
      case 'approve': return button(action, () => open('approve'));
      case 'publish': return button(action, () => open('publish'));
      case 'reschedule': return button(action, () => open('reschedule'));
      default: return button(action, () => send({ action }));
    }
  };

  const showMissing = canSubmit && missing.length > 0;
  const showPanel = panel !== null && available.includes(panel);
  const hasNotes = showMissing || dirty || showPanel || error !== undefined;

  return <>
    {hasNotes && <div className="content-actions__notes">
      {showMissing && <div role="status" className="content-actions__missing">
        <p>Antes de enviar para aprovação, falta:</p>
        <ul>{missing.map((line) => <li key={line}>{line}</li>)}</ul>
      </div>}
      {dirty && <p className="form-hint">Salve as mudanças antes de usar estas ações.</p>}
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
          <Button loading={busy} disabled={waiting} onClick={confirmApprove}>Confirmar aprovação</Button>
        </div>
      </div>}
      {panel === 'publish' && available.includes('publish') && <div className="form-field content-actions__panel">
        <label htmlFor={`${ids}-published`}>Dia real da publicação</label>
        <DatePicker
          id={`${ids}-published`}
          today={todayInSaoPaulo()}
          max={todayInSaoPaulo()}
          value={publishedOn}
          disabled={busy}
          onChange={(day) => { setPublishedOn(day); setProblem(undefined); }}
          aria-invalid={problem === undefined ? undefined : true}
          aria-describedby={problem === undefined ? undefined : `${ids}-problem`}
        />
        {problem !== undefined && <FieldMessage id={`${ids}-problem`} role="alert">{problem}</FieldMessage>}
        <div className="form-actions">
          <Button loading={busy} disabled={waiting} onClick={confirmPublish}>Confirmar publicação</Button>
        </div>
      </div>}
      {panel === 'reschedule' && available.includes('reschedule') && <div className="form-field content-actions__panel">
        <label htmlFor={`${ids}-reschedule`}>Novo dia da publicação</label>
        <DatePicker
          id={`${ids}-reschedule`}
          today={todayInSaoPaulo()}
          value={publishOn}
          disabled={busy}
          onChange={(day) => { setPublishOn(day); setProblem(undefined); }}
          aria-invalid={problem === undefined ? undefined : true}
          aria-describedby={problem === undefined ? undefined : `${ids}-problem`}
        />
        {problem !== undefined && <FieldMessage id={`${ids}-problem`} role="alert">{problem}</FieldMessage>}
        <div className="form-actions">
          <Button loading={busy} disabled={waiting} onClick={confirmReschedule}>Confirmar novo dia</Button>
        </div>
      </div>}
      {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
    </div>}
    <div className="content-modal__footer-row">
      {children}
      <section className="content-actions" aria-label="Ações do conteúdo">
        {available.includes('cancel') && buttonOf('cancel')}
        {available.filter((action) => action !== 'cancel').map(buttonOf)}
      </section>
    </div>
  </>;
}
