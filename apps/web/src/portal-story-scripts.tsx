import { useState } from 'react';
import { Check } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { PortalStoryScriptPeriodResponseSchema, PortalStoryScriptSchema, type PortalStoryScript } from '@ageniza/contracts';
import { Button, FieldMessage, Skeleton } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { formatAgencyDayMonth } from './client-detail.js';
import { todayInSaoPaulo } from './content-dates.js';
import { HttpClientError, useApiClient } from './http.js';
import { PLAN_RENEWAL_REASON } from './plan-notice.js';
import { usePortalClient } from './portal.js';

const LIST_PATH = '/clients/:clientId/story-scripts';
const RECORDED_PATH = '/clients/:clientId/story-scripts/:scriptId/recorded';

/** The words of each refusal of "marcar como gravado", in the client's language: what the server wrote is never shown. */
export const recordRefusal = (error: unknown): string => {
  if (error instanceof HttpClientError) {
    if (error.status === 409 && error.code === 'TRY_AGAIN') return 'Outra alteração aconteceu ao mesmo tempo. Tente de novo.';
    if (error.status === 409) return 'Este roteiro mudou e a tela foi atualizada com o que há agora.';
    if (error.status === 404) return 'Este roteiro não existe mais.';
    if (error.status === 403) return 'Você não tem permissão para esta ação.';
  }
  return 'Não foi possível marcar como gravado. Tente de novo.';
};

function Script({ script, number, several, sending, onRecord }: {
  script: PortalStoryScript;
  number: number;
  several: boolean;
  sending: string | null;
  onRecord: (script: PortalStoryScript) => void;
}) {
  const readOnly = usePortalClient().agencyReadOnly;
  return <article className="portal-script portal-block">
    {several && <h3 className="portal-script__title">Roteiro {number}</h3>}
    <ol className="portal-script__scenes">
      {script.scenes.map((scene) => <li key={scene.position} className="portal-script__scene">
        <p className="portal-script__text">{scene.text}</p>
        {scene.guidance !== null && <p className="portal-script__guidance">Orientação: {scene.guidance}</p>}
      </li>)}
    </ol>
    {script.status === 'sent'
      ? <Button
        variant="secondary"
        aria-label={several ? `Já gravei o roteiro ${number}` : undefined}
        loading={sending === script.id}
        disabled={sending !== null}
        blockedReason={readOnly ? PLAN_RENEWAL_REASON : undefined}
        leadingIcon={<Check />}
        onClick={() => onRecord(script)}
      >Já gravei</Button>
      : <p className="portal-script__recorded">
        <Check aria-hidden="true" />
        {script.recordedBy?.name == null ? 'Gravado' : `Gravado por ${script.recordedBy.name}`}
        {script.recordedAt !== null && ` em ${formatAgencyDayMonth(script.recordedAt)}`}
      </p>}
  </article>;
}

/**
 * The story script of today of the Início (`specs/conteudo.md` section 7): the scenes the agency sent for today's day in São Paulo, and
 * "Já gravei" on the ones not yet recorded. Without a script for today the block is not there at all.
 */
export function PortalTodayScripts({ clientId }: { clientId: string }) {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const today = todayInSaoPaulo();
  const key = ['portal', clientId, 'story-scripts', today] as const;
  const scripts = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath(LIST_PATH, { clientId })}?from=${today}&to=${today}`,
      response: PortalStoryScriptPeriodResponseSchema,
      signal
    })
  });
  // What is on its way is this screen's own state, set in the click, and the button waits for it.
  const [sending, setSending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | undefined>();

  const record = async (script: PortalStoryScript): Promise<void> => {
    if (sending !== null) return;
    setSending(script.id);
    setProblem(undefined);
    try {
      await httpClient.request({
        path: apiPath(RECORDED_PATH, { clientId, scriptId: script.id }),
        method: 'POST',
        response: PortalStoryScriptSchema
      });
    } catch (failed) {
      setProblem(recordRefusal(failed));
    } finally {
      // Read again after a refusal too: the script may have been recorded, or taken back, in the meantime.
      await queryClient.invalidateQueries({ queryKey: key });
      setSending(null);
    }
  };

  if (scripts.isPending) {
    return <div className="portal-today" aria-hidden="true"><Skeleton className="portal-today__skeleton" /></div>;
  }
  if (scripts.isError && scripts.data === undefined) {
    return <section className="portal-section portal-today" aria-labelledby="portal-today-title">
      <h2 id="portal-today-title" className="portal-section__title">Roteiro de hoje</h2>
      <div className="portal-error" role="alert">
        <p>Não foi possível carregar o roteiro de hoje.</p>
        <Button variant="secondary" loading={scripts.isFetching} onClick={() => { void scripts.refetch(); }}>Tentar de novo</Button>
      </div>
    </section>;
  }
  const list = scripts.data?.data ?? [];
  if (list.length === 0) return null;
  return <section className="portal-section portal-today" aria-labelledby="portal-today-title">
    <h2 id="portal-today-title" className="portal-section__title">Roteiro de hoje</h2>
    {list.map((script, index) => <Script
      key={script.id}
      script={script}
      number={index + 1}
      several={list.length > 1}
      sending={sending}
      onRecord={(chosen) => { void record(chosen); }}
    />)}
    {problem !== undefined && <FieldMessage role="alert">{problem}</FieldMessage>}
  </section>;
}
