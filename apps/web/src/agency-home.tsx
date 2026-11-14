import { Link, useLocation } from 'react-router-dom';
import { Plus } from 'lucide-react';

import { ButtonLink, EmptyState } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { ActivationPath, useActivationFacts } from './activation-path.js';
import { AwaitingClient, AwaitingSummary, useContentSummary } from './awaiting-client.js';
import { useAuthSessionStore, useAuthSession } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { greeting, headingDateLabel } from './home-dates.js';
import { AgencyMilestones, MilestoneCelebration } from './milestone-celebration.js';
import type { MilestoneFacts } from './milestones.js';

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** What the header says under the greeting: the next step of a new agency, else what the counters say needs attention. */
const subtitleOf = (path: MilestoneFacts | undefined, summary: { awaitingClient: number; overdueAwaitingClient: number } | undefined): string | null => {
  if (path !== undefined && !path.approved) {
    if (!path.client) return 'Comece pelo primeiro cliente. Depois dele, a pauta começa a andar.';
    if (!path.content) return 'O cliente já está na carteira. Falta o primeiro post na pauta.';
    if (!path.sent) return 'Já há conteúdo na pauta. Falta enviá-lo ao cliente.';
    return 'Falta só a primeira aprovação. Depois dela, a pauta anda sozinha.';
  }
  if (summary === undefined) return null;
  const { overdueAwaitingClient: late, awaitingClient: waiting } = summary;
  if (late > 0) return `${late} ${plural(late, 'conteúdo está', 'conteúdos estão')} com a data de publicação vencida e sem aprovação.`;
  if (waiting > 0) return `${waiting} ${plural(waiting, 'post espera', 'posts esperam')} a resposta do cliente.`;
  return 'Nada parado no cliente.';
};

/**
 * The Início of the agency (decisions 2026-11-10 and 2026-11-11): the date and a greeting, the journey of a new agency, the four blocks
 * of the week, "Parado no cliente" and the milestones. There are no shortcuts to the modules: the menu is the way to them.
 */
export function AgencyHomePage() {
  const agency = useAgencyContext();
  const location = useLocation();
  const session = useAuthSession(useAuthSessionStore());
  const canSeeCollaborators = useCan('colaborador.visualizar');
  const canSeeClients = useCan('cliente.visualizar');
  // The same condition as the menu: Conteúdos needs the roster behind its picker.
  const canSeeContents = useCan('conteudo.visualizar') && canSeeClients;
  const canOperate = useCan('conteudo.operar');
  const blocked = useWriteBlocked() !== undefined;
  const activation = useActivationFacts(agency.agencyId, canSeeContents);
  const summary = useContentSummary(agency.agencyId, canSeeContents);
  useDocumentTitle(`${agency.agencyName} — Ageniza`);

  const now = new Date();
  const firstName = session.user?.name.trim().split(/\s+/)[0] ?? '';
  const subtitle = subtitleOf(activation.pathFacts, summary.data?.data);
  const hasModule = canSeeContents || canSeeClients || canSeeCollaborators;
  // With one client the new content opens on it; with several, the picker asks which one.
  const newContent = activation.rosterSize === 1 && activation.firstClientId !== undefined ? `conteudos/${activation.firstClientId}/novo` : 'conteudos';

  return <section aria-labelledby="agency-home-title" className="agency-home">
    <header className="agency-home__head">
      <div className="agency-home__head-text">
        <p className="agency-home__eyebrow">{headingDateLabel(now)}</p>
        <h1 id="agency-home-title">{firstName === '' ? greeting(now) : `${greeting(now)}, ${firstName}`}</h1>
        {subtitle !== null && <p className="agency-home__subtitle">{subtitle}</p>}
      </div>
      {canSeeContents && canOperate && !blocked && (activation.rosterSize ?? 0) > 0 && <ButtonLink as={Link} to={newContent} state={location.state} variant="secondary" leadingIcon={<Plus />}>Novo conteúdo</ButtonLink>}
    </header>
    <MilestoneCelebration agencyId={agency.agencyId} facts={activation.facts} />
    <ActivationPath facts={activation.pathFacts} firstClientId={activation.firstClientId} firstClientName={activation.firstClientName} steps={activation.steps} />
    {canSeeContents && <AwaitingSummary agencyId={agency.agencyId} />}
    {canSeeContents && <div className="agency-home__panels">
      <AwaitingClient agencyId={agency.agencyId} />
      <AgencyMilestones facts={activation.pathFacts} steps={activation.steps} />
    </div>}
    {!hasModule && <EmptyState
      className="agency-home__empty"
      title="Nenhum módulo disponível para o seu papel"
      description="Fale com quem administra a agência para liberar o acesso. Se você participa de outra agência, troque de contexto."
      action={<ButtonLink as={Link} to="/contextos" variant="secondary">Trocar de contexto</ButtonLink>}
    />}
  </section>;
}
