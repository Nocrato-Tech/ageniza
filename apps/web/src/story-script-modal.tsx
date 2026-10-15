import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Send } from 'lucide-react';

import {
  CalendarDaySchema,
  STORY_SCENE_GUIDANCE_MAX_LENGTH,
  STORY_SCENE_TEXT_MAX_LENGTH,
  STORY_SCRIPT_MAX_SCENES,
  StorySceneGuidanceSchema,
  StorySceneTextSchema,
  StoryScriptSchema,
  type CreateStoryScriptRequest,
  type StoryScript,
  type UpdateStoryScriptRequest
} from '@ageniza/contracts';
import { Button, Dialog, Field, FieldMessage, IconButton, Skeleton, Textarea, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';
import { StoryScriptStatusTag } from './story-script-status.js';

export type StoryScriptTarget =
  | { readonly kind: 'new'; readonly day: string }
  | { readonly kind: 'open'; readonly scriptId: string };

const SCRIPTS_PATH = '/agencies/:agencyId/clients/:clientId/story-scripts';
const SCRIPT_PATH = `${SCRIPTS_PATH}/:scriptId`;

const SAVE_FAILED = 'Não foi possível salvar o roteiro. Tente de novo.';
const SEND_FAILED = 'Não foi possível enviar o roteiro. Tente de novo.';
const SAVED_NOT_SENT = 'O roteiro foi salvo como rascunho, mas não foi enviado. Tente enviar de novo.';

/** The screen's own words for each refusal: what the server wrote is never shown. */
const refusalMessage = (error: unknown, fallback: string): string => {
  if (error instanceof HttpClientError) {
    if (error.status === 409 && error.code === 'STORY_SCRIPT_STATE') return 'Este roteiro já foi enviado e não pode mais ser editado. Feche e abra de novo para ver a versão atual.';
    if (error.status === 409 && error.code === 'STORY_SCENES_MISMATCH') return 'O roteiro mudou desde que você o abriu. Feche e abra de novo para ver a versão atual.';
    if (error.status === 409 && error.code === 'CLIENT_ARCHIVED') return 'Este cliente está arquivado: o roteiro é só leitura.';
    if (error.status === 403) return 'Você não tem permissão para alterar roteiros.';
    if (error.status === 404) return 'Este roteiro não existe mais.';
    if (error.status === 400) return 'Revise os dados do roteiro.';
  }
  return fallback;
};

/** Which step of save-then-send failed, and whether the save of this very attempt had already worked. */
class StepFailed extends Error {
  public constructor(public readonly step: 'save' | 'send', public readonly wrote: boolean, public readonly reason: unknown) {
    super(`The story script could not be ${step === 'save' ? 'saved' : 'sent'}.`);
  }
}

interface SceneDraft {
  /** For React and focus only; never sent. */
  readonly key: string;
  /** Present for a scene the server already has. */
  readonly id?: string;
  readonly text: string;
  readonly guidance: string;
}

interface ScriptForm {
  readonly scriptOn: string;
  readonly scenes: readonly SceneDraft[];
}

interface FieldErrors {
  readonly scriptOn?: string;
  readonly scenes: Readonly<Record<string, { readonly text?: string; readonly guidance?: string }>>;
}

const NO_ERRORS: FieldErrors = { scenes: {} };

const toForm = (script: StoryScript, newKey: () => string): ScriptForm => ({
  scriptOn: script.scriptOn,
  scenes: script.scenes.map((scene) => ({ key: newKey(), id: scene.id, text: scene.text, guidance: scene.guidance ?? '' }))
});

/** Order counts: the same two scenes the other way round are another script. */
const signature = (form: ScriptForm): string =>
  JSON.stringify([form.scriptOn, form.scenes.map((scene) => [scene.id ?? null, scene.text, scene.guidance])]);

const textIssue = (value: string): string | undefined => {
  if (StorySceneTextSchema.safeParse(value).success) return undefined;
  if (value.trim() === '') return 'Escreva o texto da cena.';
  if (value.length > STORY_SCENE_TEXT_MAX_LENGTH) return `O texto da cena passa de ${STORY_SCENE_TEXT_MAX_LENGTH} caracteres.`;
  return 'O texto da cena tem caracteres invisíveis ou de controle.';
};

const guidanceIssue = (value: string): string | undefined => {
  if (StorySceneGuidanceSchema.safeParse(value).success) return undefined;
  if (value.length > STORY_SCENE_GUIDANCE_MAX_LENGTH) return `A orientação passa de ${STORY_SCENE_GUIDANCE_MAX_LENGTH} caracteres.`;
  return 'A orientação tem caracteres invisíveis ou de controle.';
};

const validate = (form: ScriptForm): FieldErrors | null => {
  const scenes: Record<string, { text?: string; guidance?: string }> = {};
  for (const scene of form.scenes) {
    const text = textIssue(scene.text);
    const guidance = guidanceIssue(scene.guidance);
    if (text !== undefined || guidance !== undefined) scenes[scene.key] = { ...(text === undefined ? {} : { text }), ...(guidance === undefined ? {} : { guidance }) };
  }
  const dayValid = CalendarDaySchema.safeParse(form.scriptOn).success;
  if (dayValid && Object.keys(scenes).length === 0) return null;
  return { ...(dayValid ? {} : { scriptOn: 'Informe o dia dos stories.' }), scenes };
};

const dayText = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** The one a scene's move left focus on: its own button for that direction, or the other when it hit the edge. */
interface PendingFocus { readonly key: string; readonly direction: 'up' | 'down' }

function ScriptEditor({ clientId, initial, initialDay, canOperate, onBusyChange, onDone }: {
  clientId: string;
  initial: StoryScript | null;
  initialDay: string;
  canOperate: boolean;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const keyCounter = useRef(0);
  const newKey = (): string => { keyCounter.current += 1; return `scene-${keyCounter.current}`; };

  const [saved, setSaved] = useState<StoryScript | null>(initial);
  const [form, setForm] = useState<ScriptForm>(() => initial === null
    ? { scriptOn: initialDay, scenes: [{ key: newKey(), text: '', guidance: '' }] }
    : toForm(initial, newKey));
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS);
  const [formError, setFormError] = useState<string | undefined>();
  const [announcement, setAnnouncement] = useState('');
  const pendingFocus = useRef<PendingFocus | null>(null);
  const addedKey = useRef<string | null>(null);
  const moveButtons = useRef(new Map<string, { up: HTMLButtonElement | null; down: HTMLButtonElement | null }>());
  const textareas = useRef(new Map<string, HTMLTextAreaElement | null>());
  const dayId = useId();

  const status = saved?.status ?? 'draft';
  const canWrite = canOperate && status === 'draft';
  const dirty = saved === null || signature(form) !== signature(toForm(saved, () => ''));

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending !== null) {
      pendingFocus.current = null;
      const buttons = moveButtons.current.get(pending.key);
      const preferred = pending.direction === 'up' ? buttons?.up : buttons?.down;
      const other = pending.direction === 'up' ? buttons?.down : buttons?.up;
      (preferred != null && !preferred.disabled ? preferred : other)?.focus();
    }
    const added = addedKey.current;
    if (added !== null) {
      addedKey.current = null;
      textareas.current.get(added)?.focus();
    }
  });

  const submit = useMutation({
    mutationFn: async (intent: 'save' | 'send'): Promise<StoryScript> => {
      let current = saved;
      let wrote = false;
      if (current === null || dirty) {
        try {
          current = current === null
            ? await httpClient.request({
              path: apiPath(SCRIPTS_PATH, { agencyId: agency.agencyId, clientId }),
              method: 'POST',
              body: {
                scriptOn: form.scriptOn,
                scenes: form.scenes.map((scene) => ({ text: scene.text, guidance: scene.guidance }))
              } satisfies CreateStoryScriptRequest,
              response: StoryScriptSchema
            })
            : await httpClient.request({
              path: apiPath(SCRIPT_PATH, { agencyId: agency.agencyId, clientId, scriptId: current.id }),
              method: 'PATCH',
              body: {
                scriptOn: form.scriptOn,
                scenes: form.scenes.map((scene) => ({ ...(scene.id === undefined ? {} : { id: scene.id }), text: scene.text, guidance: scene.guidance }))
              } satisfies UpdateStoryScriptRequest,
              response: StoryScriptSchema
            });
        } catch (error) {
          throw new StepFailed('save', false, error);
        }
        wrote = true;
        // What the server stored is what is on screen from now on, ids included: a retry of the send edits this script, never creates another.
        setSaved(current);
        setForm(toForm(current, newKey));
      }
      if (intent === 'save') return current;
      try {
        return await httpClient.request({
          path: apiPath(`${SCRIPT_PATH}/send`, { agencyId: agency.agencyId, clientId, scriptId: current.id }),
          method: 'POST',
          response: StoryScriptSchema
        });
      } catch (error) {
        throw new StepFailed('send', wrote, error);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId] });
      onDone();
    },
    onError: (error) => {
      const failure = error instanceof StepFailed ? error : new StepFailed('save', false, error);
      const message = refusalMessage(failure.reason, failure.step === 'save' ? SAVE_FAILED : SEND_FAILED);
      setFormError(failure.step === 'send' && failure.wrote && message === SEND_FAILED ? SAVED_NOT_SENT : message);
      // A refusal from the server means the calendar behind this modal may be stale (another operator sent it, the client was archived).
      if (failure.wrote || (failure.reason instanceof HttpClientError && failure.reason.status !== undefined && failure.reason.status < 500)) {
        void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId] });
      }
    }
  });

  const busy = submit.isPending;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  const run = (intent: 'save' | 'send'): void => {
    setFormError(undefined);
    const problems = validate(form);
    setErrors(problems ?? NO_ERRORS);
    if (problems !== null) return;
    submit.mutate(intent);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    run('save');
  };

  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= form.scenes.length) return;
    const scenes = [...form.scenes];
    const moved = scenes[index]!;
    scenes[index] = scenes[target]!;
    scenes[target] = moved;
    pendingFocus.current = { key: moved.key, direction: direction === -1 ? 'up' : 'down' };
    setForm({ ...form, scenes });
    setAnnouncement(`Cena movida para a posição ${target + 1} de ${scenes.length}.`);
  };

  const addScene = (): void => {
    if (form.scenes.length >= STORY_SCRIPT_MAX_SCENES) return;
    const key = newKey();
    addedKey.current = key;
    setForm({ ...form, scenes: [...form.scenes, { key, text: '', guidance: '' }] });
  };

  const editScene = (key: string, patch: Partial<Pick<SceneDraft, 'text' | 'guidance'>>): void => {
    setForm({ ...form, scenes: form.scenes.map((scene) => (scene.key === key ? { ...scene, ...patch } : scene)) });
    setErrors((current) => ({ ...current, scenes: { ...current.scenes, [key]: {} } }));
    setFormError(undefined);
  };

  if (!canWrite) {
    return <div className="form-stack story-script">
      <p className="story-script__status">
        <StoryScriptStatusTag status={status} />
        {saved?.recordedBy?.name != null && <span>Gravado por {saved.recordedBy.name}</span>}
      </p>
      <p className="story-script__day"><strong>Dia dos stories:</strong> <time dateTime={form.scriptOn}>{dayText(form.scriptOn)}</time></p>
      {form.scenes.length === 0
        ? <p className="form-hint">Este roteiro não tem cenas.</p>
        : <ol className="story-script__scenes">
          {form.scenes.map((scene, index) => <li key={scene.key} className="story-script__scene">
            <h3 className="story-script__scene-title">Cena {index + 1}</h3>
            <p className="story-script__text">{scene.text}</p>
            {scene.guidance !== '' && <p className="story-script__guidance"><strong>Orientação:</strong> {scene.guidance}</p>}
          </li>)}
        </ol>}
      {!canOperate && status === 'draft' && <p className="form-hint">Você pode ver este roteiro, mas não editar nem enviar.</p>}
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>Fechar</Button>
      </div>
    </div>;
  }

  return <form className="form-stack story-script" onSubmit={onSubmit} noValidate>
    <p className="story-script__status"><StoryScriptStatusTag status={status} /></p>
    <Field id={dayId} label="Dia dos stories" error={errors.scriptOn}>
      {(control) => (
        <TextInput
          {...control}
          type="date"
          value={form.scriptOn}
          disabled={busy}
          onChange={(event) => { setForm({ ...form, scriptOn: event.target.value }); setErrors((current) => ({ scenes: current.scenes })); setFormError(undefined); }}
        />
      )}
    </Field>
    <ol className="story-script__scenes">
      {form.scenes.map((scene, index) => {
        const sceneErrors = errors.scenes[scene.key] ?? {};
        const number = index + 1;
        return <li key={scene.key} className="story-script__scene">
          <div className="story-script__scene-heading">
            <h3 className="story-script__scene-title">Cena {number}</h3>
            <div className="story-script__moves">
              <IconButton
                label={`Mover cena ${number} para cima`}
                icon={<ArrowUp />}
                disabled={busy || index === 0}
                ref={(element) => { moveButtons.current.set(scene.key, { up: element, down: moveButtons.current.get(scene.key)?.down ?? null }); }}
                onClick={() => move(index, -1)}
              />
              <IconButton
                label={`Mover cena ${number} para baixo`}
                icon={<ArrowDown />}
                disabled={busy || index === form.scenes.length - 1}
                ref={(element) => { moveButtons.current.set(scene.key, { up: moveButtons.current.get(scene.key)?.up ?? null, down: element }); }}
                onClick={() => move(index, 1)}
              />
            </div>
          </div>
          <Field id={`${scene.key}-text`} label={`Texto da cena ${number}`} error={sceneErrors.text}>
            {(control) => (
              <Textarea
                {...control}
                ref={(element) => { textareas.current.set(scene.key, element); }}
                rows={3}
                maxLength={STORY_SCENE_TEXT_MAX_LENGTH}
                value={scene.text}
                disabled={busy}
                onChange={(event) => editScene(scene.key, { text: event.target.value })}
              />
            )}
          </Field>
          <Field id={`${scene.key}-guidance`} label={`Orientação da cena ${number}`} error={sceneErrors.guidance}>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                maxLength={STORY_SCENE_GUIDANCE_MAX_LENGTH}
                value={scene.guidance}
                disabled={busy}
                onChange={(event) => editScene(scene.key, { guidance: event.target.value })}
              />
            )}
          </Field>
        </li>;
      })}
    </ol>
    <div className="story-script__add">
      <Button variant="secondary" leadingIcon={<Plus />} disabled={busy || form.scenes.length >= STORY_SCRIPT_MAX_SCENES} onClick={addScene}>Adicionar cena</Button>
      {form.scenes.length >= STORY_SCRIPT_MAX_SCENES && <p className="form-hint">Um roteiro tem no máximo {STORY_SCRIPT_MAX_SCENES} cenas.</p>}
    </div>
    <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
    <div className="form-actions">
      <Button variant="ghost" disabled={busy} onClick={onDone}>Cancelar</Button>
      <Button type="submit" variant="secondary" loading={busy && submit.variables === 'save'} disabled={busy}>Salvar rascunho</Button>
      <Button leadingIcon={<Send />} loading={busy && submit.variables === 'send'} disabled={busy} onClick={() => run('send')}>Enviar ao cliente</Button>
    </div>
  </form>;
}

export function StoryScriptModal({ clientId, target, canOperate, onClose }: {
  clientId: string;
  target: StoryScriptTarget;
  /** `conteudo.operar` and a client that is not archived. */
  canOperate: boolean;
  onClose: () => void;
}) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const [busy, setBusy] = useState(false);
  const scriptId = target.kind === 'open' ? target.scriptId : '';
  const script = useQuery({
    queryKey: ['agency', agency.agencyId, 'story-script', clientId, scriptId],
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath(SCRIPT_PATH, { agencyId: agency.agencyId, clientId, scriptId }),
      response: StoryScriptSchema,
      signal
    }),
    enabled: target.kind === 'open',
    // A script is read when it is opened: a copy from a minute ago may be one another operator already sent.
    staleTime: 0,
    gcTime: 0
  });

  // Closing in the middle of a write would leave its success to close whatever modal is open by then.
  const close = (): void => { if (!busy) onClose(); };
  const notFound = script.error instanceof HttpClientError && script.error.status === 404;

  return <Dialog
    title={target.kind === 'new' ? 'Novo roteiro de stories' : 'Roteiro de stories'}
    description="Cada cena leva o texto e, se quiser, a orientação para gravar."
    closeLabel="Fechar roteiro de stories"
    onClose={close}
  >
    {target.kind === 'new'
      ? <ScriptEditor clientId={clientId} initial={null} initialDay={target.day} canOperate={canOperate} onBusyChange={setBusy} onDone={onClose} />
      : script.isPending
        ? <div className="story-script__loading" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
        : script.isError
          ? <div className="form-stack" role="alert">
            <p>{notFound ? 'Este roteiro não existe mais.' : 'Não foi possível carregar o roteiro. Tente de novo.'}</p>
            <div className="form-actions">
              {!notFound && <Button onClick={() => { void script.refetch(); }}>Tentar de novo</Button>}
              <Button variant="secondary" onClick={onClose}>Fechar</Button>
            </div>
          </div>
          : <ScriptEditor clientId={clientId} initial={script.data} initialDay={script.data.scriptOn} canOperate={canOperate} onBusyChange={setBusy} onDone={onClose} />}
  </Dialog>;
}
