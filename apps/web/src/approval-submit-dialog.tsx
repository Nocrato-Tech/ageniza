import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';

import {
  APPROVAL_BATCH_MAX_CONTENTS,
  APPROVAL_NOTE_MAX_CHARACTERS,
  ApprovalNoteSchema,
  CalendarDaySchema,
  ContentDetailSchema,
  SubmitContentsBatchResponseSchema,
  type ContentFormat,
  type ContentListItem,
  type SubmitContentRequest,
  type SubmitContentsBatchRequest
} from '@ageniza/contracts';
import { Button, DatePicker, Dialog, Field, FieldMessage, FormatTag, invalidDayMessage, Textarea, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { actionRefusal } from './content-actions.js';
import { addDays, dayMonthLabel, saoPauloClock, weekdayShortLabel } from './content-dates.js';
import { FORMAT_LABELS, FORMAT_TONES } from './content-labels.js';
import { HttpClientError, useApiClient } from './http.js';

/** How far ahead a deadline may be, counted from now (decision 2026-11-11). */
const DUE_MAX_DAYS = 90;

/** The deadline proposed when a round is sent: 48 hours from now (decision 2026-11-11). */
const DUE_DEFAULT_HOURS = 48;

/** São Paulo has no daylight saving time since 2019, so its wall clock is UTC-3 all year. */
const SAO_PAULO_OFFSET = '-03:00';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const CONTENTS_PATH = '/agencies/:agencyId/clients/:clientId/contents';

const MESSAGES = {
  dueRange: 'Escolha um dia e uma hora de agora até 90 dias à frente.',
  dueRefused: 'O prazo vai de agora até 90 dias à frente. Escolha outro dia ou outra hora.',
  timeInvalid: 'Escolha uma hora válida.',
  noteTooLong: `O recado tem até ${APPROVAL_NOTE_MAX_CHARACTERS} caracteres.`,
  noteInvalid: 'O recado tem caracteres que não são aceitos.',
  noteRefused: `O recado tem até ${APPROVAL_NOTE_MAX_CHARACTERS} caracteres e não pode ter caracteres especiais. Deixe em branco para enviar sem recado.`,
  review: 'Revise o prazo e o recado.',
  nothingSent: 'Nenhum conteúdo foi enviado.',
  batchState: 'Algum dos conteúdos já não está em produção nem em ajuste. Nenhum conteúdo foi enviado: confira a lista abaixo.',
  batchGone: 'Algum dos conteúdos não existe mais. Nenhum conteúdo foi enviado: confira a lista abaixo.',
  batchFailed: 'Não foi possível enviar os conteúdos para aprovação. Tente de novo.',
  limit: `Um envio leva até ${APPROVAL_BATCH_MAX_CONTENTS} conteúdos.`
} as const;

const characters = (value: string): number => Array.from(value.trim()).length;

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The deadline as an instant, from the day and the hour typed in São Paulo; `null` when either is not a real one. */
export const dueInstant = (dueOn: string, time: string): Date | null => {
  if (!CalendarDaySchema.safeParse(dueOn).success || !TIME_FORMAT.test(time)) return null;
  const instant = new Date(`${dueOn}T${time}:00${SAO_PAULO_OFFSET}`);
  return Number.isNaN(instant.getTime()) ? null : instant;
};

/** The deadline proposed for a send made `now`: 48 hours later, as the day and the hour of São Paulo. */
export const defaultDue = (now: Date): { readonly dueOn: string; readonly time: string } => {
  const clock = saoPauloClock(new Date(now.getTime() + DUE_DEFAULT_HOURS * HOUR_MS));
  return { dueOn: clock.day, time: clock.time.slice(0, 5) };
};

/** The deadline by the rule of the screen (after now, up to 90 days ahead): the contract only checks the format of the instant. */
export const dueProblem = (dueOn: string, time: string, now: Date): string | undefined => {
  if (dueOn === '') return undefined;
  if (!TIME_FORMAT.test(time)) return MESSAGES.timeInvalid;
  const instant = dueInstant(dueOn, time);
  if (instant === null || instant.getTime() <= now.getTime() || instant.getTime() > now.getTime() + DUE_MAX_DAYS * DAY_MS) return MESSAGES.dueRange;
  return undefined;
};

/** The note by the contract's own rule; blank is no note at all, and the words are the screen's. */
export const noteProblem = (note: string): string | undefined => {
  if (note.trim() === '') return undefined;
  if (ApprovalNoteSchema.safeParse(note).success) return undefined;
  return characters(note) > APPROVAL_NOTE_MAX_CHARACTERS ? MESSAGES.noteTooLong : MESSAGES.noteInvalid;
};

/** One content of the period as the batch lists it: why it cannot go yet, when it cannot. */
export interface BatchCandidate {
  readonly id: string;
  readonly title: string;
  readonly format: ContentFormat;
  readonly publishOn: string;
  readonly publishAtTime: string | null;
  /** In production or in adjustment: where a send starts. The others are listed only to say why they left the batch. */
  readonly startsHere: boolean;
  readonly blocked: string | undefined;
}

const STATE_BLOCKS: Readonly<Partial<Record<ContentListItem['status'], string>>> = {
  awaiting_approval: 'Já aguarda aprovação.',
  approved: 'Já foi aprovado.',
  published: 'Já foi publicado.',
  cancelled: 'Foi cancelado.'
};

/** What the list can tell before the API does: the state, the media (a post with none has no cover) and the subtasks. The API still decides. */
export const batchCandidates = (contents: readonly ContentListItem[]): BatchCandidate[] => contents.map((content) => {
  const startsHere = content.status === 'in_production' || content.status === 'adjusting';
  const open = content.tasksTotal - content.tasksApproved;
  const media = content.thumbnailAssetId === null ? 'Falta a mídia do post.' : undefined;
  const tasks = open === 1 ? 'Falta aprovar 1 subtarefa.' : open > 1 ? `Faltam aprovar ${open} subtarefas.` : undefined;
  return {
    id: content.id,
    title: content.title,
    format: content.format,
    publishOn: content.publishOn,
    publishAtTime: content.publishAtTime,
    startsHere,
    blocked: STATE_BLOCKS[content.status] ?? media ?? tasks
  };
});

type Refusal = { readonly field?: 'due' | 'note'; readonly message: string };

const refusalOf = (error: unknown, batch: boolean): Refusal => {
  if (error instanceof HttpClientError) {
    if (error.status === 400 && error.code === 'CONTENT_APPROVAL_DUE_INVALID') return { field: 'due', message: MESSAGES.dueRefused };
    if (error.status === 400 && error.code === 'CONTENT_APPROVAL_NOTE_INVALID') return { field: 'note', message: MESSAGES.noteRefused };
    if (error.status === 400) return { message: MESSAGES.review };
    if (batch) {
      if (error.status === 409 && error.code === 'CONTENT_STATE') return { message: MESSAGES.batchState };
      if (error.status === 404) return { message: MESSAGES.batchGone };
      if (error.code === 'CONTENT_TASKS_NOT_APPROVED' || error.code === 'CONTENT_MEDIA_INCOMPLETE' || error.code === 'CONTENT_MEDIA_NOT_CONFIRMED') {
        return { message: `${actionRefusal(error, 'submit')} ${MESSAGES.nothingSent}` };
      }
      if (error.status !== 403 && error.code !== 'TRY_AGAIN' && error.code !== 'CLIENT_ARCHIVED') return { message: MESSAGES.batchFailed };
    }
  }
  return { message: batch && !(error instanceof HttpClientError) ? MESSAGES.batchFailed : actionRefusal(error, 'submit') };
};

export type ApprovalSubmitTarget =
  | { readonly kind: 'one'; readonly clientId: string; readonly content: { readonly id: string; readonly title: string } }
  | { readonly kind: 'batch'; readonly clientId: string; readonly candidates: readonly BatchCandidate[]; readonly scope: string; readonly preselected?: ReadonlySet<string> };

/**
 * "Enviar para aprovação": the deadline (day and hour, 48 hours ahead unless changed or cleared) and the note of the round, for one content or for a batch of one client.
 * What was typed stays when the API refuses; the dialog closes only on success, through `onSent`, and asks before it loses
 * typed data when the person closes it (the guard of `Dialog`).
 */
export function ApprovalSubmitDialog({ target, onClose, onSent, onBusyChange }: {
  target: ApprovalSubmitTarget;
  onClose: () => void;
  /** The send went through: the number of contents sent. */
  onSent: (count: number) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const formId = useId();
  const proposed = useRef(defaultDue(new Date())).current;
  const today = saoPauloClock().day;
  const batch = target.kind === 'batch';

  const [dueOn, setDueOn] = useState(proposed.dueOn);
  const [dueTime, setDueTime] = useState(proposed.time);
  // The field holds text that is not a day: `dueOn` is '' then too, and sending it as "no deadline" would drop what the person meant.
  const [dueInvalid, setDueInvalid] = useState(false);
  const [note, setNote] = useState('');
  const initialPicked = useRef<ReadonlySet<string>>(batch ? target.preselected ?? new Set() : new Set()).current;
  const [picked, setPicked] = useState<ReadonlySet<string>>(initialPicked);
  const [refusal, setRefusal] = useState<Refusal | undefined>();
  const [problems, setProblems] = useState<{ dueOn?: string; note?: string; pick?: string }>({});
  // The mutation's own pending state reaches the button a render late: a second click in between must not send a second request.
  const sending = useRef(false);

  // The ones that were listed when the dialog opened stay listed, so one that changed meanwhile says why it left the batch.
  const [listed] = useState<ReadonlySet<string>>(() => new Set(batch ? target.candidates.filter((candidate) => candidate.startsHere).map((candidate) => candidate.id) : []));
  const rows = batch ? target.candidates.filter((candidate) => listed.has(candidate.id)) : [];
  const ready = rows.filter((row) => row.blocked === undefined);
  const chosen = ready.filter((row) => picked.has(row.id));
  const full = chosen.length >= APPROVAL_BATCH_MAX_CONTENTS;

  const send = useMutation({
    mutationFn: async (body: { dueAt?: string; note?: string }) => {
      const base = apiPath(CONTENTS_PATH, { agencyId: agency.agencyId, clientId: target.clientId });
      if (target.kind === 'one') {
        await httpClient.request({ path: `${base}/${target.content.id}/submit`, method: 'POST', body: body satisfies SubmitContentRequest, response: ContentDetailSchema });
        return 1;
      }
      const answer = await httpClient.request({
        path: `${base}/submit`,
        method: 'POST',
        body: { contentIds: chosen.map((row) => row.id), ...body } satisfies SubmitContentsBatchRequest,
        response: SubmitContentsBatchResponseSchema
      });
      return answer.data.contents.length;
    },
    onSettled: () => { sending.current = false; },
    onSuccess: (count) => {
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', target.clientId] });
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'awaiting-client'] });
      onSent(count);
    },
    onError: (error) => {
      const found = refusalOf(error, batch);
      setRefusal(found);
      // A refusal means the list behind may be stale: another operator moved a content, or the client was archived.
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', target.clientId] });
    }
  });

  const busy = send.isPending;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const toggle = (id: string, on: boolean): void => {
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
    setProblems((current) => ({ ...current, pick: undefined }));
  };

  const everyone = ready.slice(0, APPROVAL_BATCH_MAX_CONTENTS);
  const allMarked = everyone.length > 0 && everyone.every((row) => picked.has(row.id));
  const toggleAll = (): void => {
    setPicked(allMarked ? new Set() : new Set(everyone.map((row) => row.id)));
    setProblems((current) => ({ ...current, pick: undefined }));
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (sending.current) return;
    const found = {
      dueOn: dueInvalid ? invalidDayMessage : dueProblem(dueOn, dueTime, new Date()),
      note: noteProblem(note),
      pick: batch && chosen.length === 0 ? 'Escolha ao menos um conteúdo.' : undefined
    };
    setProblems(found);
    if (found.dueOn !== undefined || found.note !== undefined || found.pick !== undefined) return;
    const instant = dueOn === '' ? null : dueInstant(dueOn, dueTime);
    sending.current = true;
    setRefusal(undefined);
    send.mutate({
      ...(instant === null ? {} : { dueAt: instant.toISOString() }),
      ...(note.trim() === '' ? {} : { note: note.trim() })
    });
  };

  const dirty = dueOn !== proposed.dueOn || dueTime !== proposed.time || dueInvalid || note !== '' || picked.size !== initialPicked.size || [...picked].some((id) => !initialPicked.has(id));
  const label = batch ? (chosen.length === 0 ? 'Enviar para aprovação' : `Enviar ${chosen.length} para aprovação`) : 'Enviar para aprovação';

  return <Dialog
    title={batch ? 'Enviar conteúdos para aprovação' : 'Enviar para aprovação'}
    description={batch ? `Escolha os conteúdos ${target.scope} que vão juntos para o cliente, com o mesmo prazo e recado.` : target.content.title}
    closeLabel="Fechar envio para aprovação"
    size={batch ? 'lg' : 'md'}
    confirmDiscard={{ dirty: dirty && !busy }}
    actions={<Button type="submit" form={formId} leadingIcon={<Send />} loading={busy}>{label}</Button>}
    onClose={() => { if (!sending.current) onClose(); }}
  >
    <form id={formId} className="approval-submit" onSubmit={submit} noValidate>
      {batch && <fieldset className="approval-submit__pick" aria-describedby={problems.pick === undefined ? undefined : `${formId}-pick`}>
        <legend>Conteúdos</legend>
        {ready.length > 1 && <Button variant="ghost" size="sm" disabled={busy} onClick={toggleAll}>{allMarked ? 'Desmarcar todos' : ready.length > APPROVAL_BATCH_MAX_CONTENTS ? `Marcar os primeiros ${APPROVAL_BATCH_MAX_CONTENTS}` : 'Marcar todos'}</Button>}
        <ul className="approval-submit__list">
          {rows.map((row) => {
            const checked = picked.has(row.id) && row.blocked === undefined;
            const reasonId = `${formId}-${row.id}-reason`;
            return <li key={row.id} className="approval-submit__row" data-blocked={row.blocked === undefined ? undefined : ''}>
              <input
                id={`${formId}-${row.id}`}
                className="approval-submit__box"
                type="checkbox"
                checked={checked}
                disabled={busy || row.blocked !== undefined || (full && !checked)}
                aria-describedby={row.blocked === undefined ? undefined : reasonId}
                onChange={(event) => { toggle(row.id, event.target.checked); }}
              />
              <label htmlFor={`${formId}-${row.id}`} className="approval-submit__label">
                <span className="approval-submit__title">{row.title}</span>
                <span className="approval-submit__meta">
                  <FormatTag format={FORMAT_TONES[row.format]}>{FORMAT_LABELS[row.format]}</FormatTag>
                  <span>{weekdayShortLabel(row.publishOn)}, {dayMonthLabel(row.publishOn)}{row.publishAtTime !== null && ` · ${row.publishAtTime}`}</span>
                </span>
              </label>
              {row.blocked !== undefined && <p id={reasonId} className="approval-submit__reason">{row.blocked}</p>}
            </li>;
          })}
        </ul>
        {full && <p className="approval-submit__limit" role="status">{MESSAGES.limit}</p>}
        {problems.pick !== undefined && <FieldMessage id={`${formId}-pick`} role="alert">{problems.pick}</FieldMessage>}
      </fieldset>}
      <div className="approval-submit__due">
        <Field label="Responder até" hint="Padrão: 48 horas" error={problems.dueOn ?? (refusal?.field === 'due' ? refusal.message : undefined)}>
          {(control) => <DatePicker
            {...control}
            today={today}
            min={today}
            max={addDays(today, DUE_MAX_DAYS)}
            value={dueOn}
            disabled={busy}
            onInvalidChange={setDueInvalid}
            onChange={(day) => { setDueOn(day); setProblems((current) => ({ ...current, dueOn: undefined })); setRefusal(undefined); }}
          />}
        </Field>
        <Field label="Hora do prazo">
          {(control) => <TextInput
            {...control}
            type="time"
            value={dueTime}
            disabled={busy || (dueOn === '' && !dueInvalid)}
            onChange={(event) => { setDueTime(event.target.value); setProblems((current) => ({ ...current, dueOn: undefined })); setRefusal(undefined); }}
          />}
        </Field>
      </div>
      <Field label="Recado para o cliente" hint="Opcional. O cliente lê junto do prazo, assinado pela agência." counter={{ count: characters(note), max: APPROVAL_NOTE_MAX_CHARACTERS }} error={problems.note ?? (refusal?.field === 'note' ? refusal.message : undefined)}>
        {(control) => <Textarea
          {...control}
          rows={4}
          value={note}
          readOnly={busy}
          onChange={(event) => { setNote(event.target.value); setProblems((current) => ({ ...current, note: undefined })); setRefusal(undefined); }}
        />}
      </Field>
      {refusal !== undefined && refusal.field === undefined && <FieldMessage role="alert">{refusal.message}</FieldMessage>}
    </form>
  </Dialog>;
}
