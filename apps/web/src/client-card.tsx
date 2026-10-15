import { Archive, ArrowRight, Circle, Clock, EllipsisVertical, Mail } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import type { ClientListItem } from '@ageniza/contracts';
import { Avatar, LateBadge, Menu, MenuItem, Pill, PillAction } from '@ageniza/ui';

import { nextAction, triageSealOf, type ClientTabSlug, type TriageSeal, type TriageVisibility } from './clients-triage.js';

/** "2026-10-30" → "30/10". Built from the string: a UTC parse would flip the day in Brazil. */
const closingLabel = (closingDate: string): string => `${closingDate.slice(8, 10)}/${closingDate.slice(5, 7)}`;

const suggestionLabel = (count: number): string =>
  count === 1 ? '1 sugestão aguardando' : `${count} sugestões aguardando`;

/** The sentence-case of a label is drawn by CSS, so the text a screen reader and a test read stays as the API's words. */
const Words = ({ children }: { children: string }) => <span className="clients__words">{children}</span>;

function Seal({ seal }: { seal: TriageSeal }) {
  if (seal === 'overdue') return <LateBadge />;
  if (seal === 'dueSoon') return <Pill icon={<Clock />}>Prazo em até 2 dias</Pill>;
  return <Pill icon={<Mail />}><Words>convite pendente</Words></Pill>;
}

interface ClientCardProps {
  client: ClientListItem;
  visible: TriageVisibility;
  agencyId: string;
  /** The address of the roster with its filters and page, so the detail's "← Clientes" comes back to it. */
  listUrl: string;
}

/**
 * The client's badge (`specs/clientes.md` §7): the photo or initials over a dark base with the name and the situation, the triage
 * seal, the badges that did not become the seal, the three content numbers and the next action. The link covers the photo, the name
 * and the badges, and is named by the name alone; the menu and the action are buttons beside it, never inside it. The strip never shows a number for who cannot read contents.
 * An archived badge is dimmed and carries no seal, badge, number or action: its only destination is the read-only detail.
 */
export function ClientCard({ client, visible, agencyId, listUrl }: ClientCardProps) {
  const navigate = useNavigate();
  const archived = client.status === 'archived';
  const seal = triageSealOf(client, visible);
  const action = nextAction(client, visible);
  const indicators = visible.contents ? client.contentIndicators : undefined;
  const open = (tab: ClientTabSlug): void => {
    void navigate(`/agencia/${agencyId}/clientes/${client.id}/${tab}`, { state: { clientListUrl: listUrl } });
  };

  const badges: Array<{ key: string; text: string; attention?: true }> = [];
  if (client.threadsAwaitingAgency > 0) badges.push({ key: 'suggestions', text: suggestionLabel(client.threadsAwaitingAgency), attention: true });
  if (client.closingDate !== null) badges.push({ key: 'closing', text: `encerra em ${closingLabel(client.closingDate)}` });
  // The API omits the field for who cannot invite; the extra check keeps the promise if the response ever leaks it
  // (the same convenience, not barrier, as specs/clientes.md §7).
  if (seal !== 'invitation' && visible.invitations && client.pendingInvitations !== undefined && client.pendingInvitations > 0) {
    badges.push({ key: 'invitation', text: 'convite pendente' });
  }

  return <article className={`clients__card${archived ? ' clients__card--archived' : ''}`}>
    <Link
      className="clients__card-link"
      to={`/agencia/${agencyId}/clientes/${client.id}/geral`}
      aria-labelledby={`client-${client.id}-name`}
      // The detail's "← Clientes" restores this exact address (filters and page included) through the navigation
      // state (specs/clientes.md §7, review of #379).
      state={{ clientListUrl: listUrl }}
    >
      <div className="clients__cover">
        <Avatar name={client.name} photoUrl={client.photoUrl} size="lg" />
        {seal !== null && <div className="clients__seal"><Seal seal={seal} /></div>}
        <div className="clients__fade">
          <h3 className="clients__card-name" id={`client-${client.id}-name`}>{client.name}</h3>
          <div className="clients__fade-line">
            {client.instagramHandle !== null && <p className="clients__card-handle">@{client.instagramHandle}</p>}
            <Pill className="clients__situation" icon={archived ? <Archive /> : <Circle />}>{archived ? 'Arquivado' : 'Ativo'}</Pill>
          </div>
        </div>
      </div>
      {!archived && <div className="clients__body">
        {badges.length > 0 && <ul className="clients__badges">
          {badges.map((badge) => (
            <li key={badge.key} className={`clients__badge${badge.attention === true ? ' clients__badge--attention' : ''}`}><Words>{badge.text}</Words></li>
          ))}
        </ul>}
        {indicators === undefined
          ? <p className="clients__indicators">pendentes · em revisão · atrasos</p>
          : <ul className="clients__indicators" aria-label="Indicadores de conteúdo">
            <li><b>{indicators.pending}</b> {indicators.pending === 1 ? 'pendente' : 'pendentes'}</li>
            <li><b>{indicators.inReview}</b> em revisão</li>
            <li className={indicators.overdue > 0 ? 'clients__indicator--late' : undefined}><b>{indicators.overdue}</b> {indicators.overdue === 1 ? 'atraso' : 'atrasos'}</li>
          </ul>}
      </div>}
    </Link>
    <div className="clients__menu">
      <Menu label={`Ações de ${client.name}`} triggerLabel={`Mais ações para ${client.name}`} trigger={<EllipsisVertical aria-hidden="true" />}>
        <MenuItem onClick={() => open('geral')}>Abrir cliente</MenuItem>
        {!archived && visible.contents && <MenuItem onClick={() => open('conteudos')}>Conteúdos</MenuItem>}
        {!archived && <MenuItem onClick={() => open('estudo-de-marca')}>Estudo de marca</MenuItem>}
        {!archived && visible.invitations && <MenuItem onClick={() => open('acessos')}>Acessos</MenuItem>}
      </Menu>
    </div>
    {action !== null && <div className="clients__footer">
      {action.figure !== null
        ? <p className="clients__figure"><b>{action.figure.value}</b><span>{action.figure.caption}</span></p>
        : <span />}
      <PillAction
        className="clients__action"
        trailingIcon={<ArrowRight />}
        aria-label={`${action.label}, ${client.name}`}
        onClick={() => open(action.tab)}
      >{action.label}</PillAction>
    </div>}
  </article>;
}
