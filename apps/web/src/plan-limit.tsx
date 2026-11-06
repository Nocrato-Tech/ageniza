import { Link } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';

import { ButtonLink } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { HttpClientError } from './http.js';

export type PlanLimit = 'client' | 'collaborator' | 'storage';

/** The refusals of the plan's ceilings (API: `TRIAL_CLIENT_LIMIT`, `PLAN_CLIENT_LIMIT`, `TRIAL_COLLABORATOR_LIMIT`, `QUOTA_EXCEEDED`). */
export const planLimitOf = (error: unknown): PlanLimit | undefined => {
  if (!(error instanceof HttpClientError)) return undefined;
  if (error.code === 'TRIAL_CLIENT_LIMIT' || error.code === 'PLAN_CLIENT_LIMIT') return 'client';
  if (error.code === 'TRIAL_COLLABORATOR_LIMIT') return 'collaborator';
  if (error.code === 'QUOTA_EXCEEDED') return 'storage';
  return undefined;
};

const TEXT: Record<PlanLimit, string> = {
  client: 'A agência chegou ao limite de clientes ativos do plano.',
  collaborator: 'O período de teste permite até 3 colaboradores, contando quem criou a agência e os convites pendentes.',
  storage: 'O armazenamento da agência está cheio.'
};

/**
 * Where a plan ceiling blocks (issue #773): says which one, and gives the Owner the way out (plans and extras); anyone else is
 * told whom to ask, since only the Owner manages billing.
 */
export function PlanLimitNotice({ limit }: { limit: PlanLimit }) {
  const agency = useAgencyContext();
  const canSubscribe = useCan('assinatura.gerenciar');
  return <div className="plan-limit" role="alert">
    <p className="plan-limit__text"><CircleAlert aria-hidden="true" />{TEXT[limit]}{' '}
      {canSubscribe ? 'Suba de plano ou compre extras para continuar.' : 'Peça a quem criou a agência para subir o plano ou comprar extras.'}
    </p>
    {canSubscribe && <ButtonLink as={Link} to={`/agencia/${agency.agencyId}/assinatura`} variant="secondary" size="sm">Ver planos e extras</ButtonLink>}
  </div>;
}
