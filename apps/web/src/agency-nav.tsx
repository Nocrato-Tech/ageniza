import { useState, type CSSProperties } from 'react';
import { Link, NavLink, matchPath, useLocation } from 'react-router-dom';
import { Briefcase, CalendarDays, ChevronsUpDown, House, PanelLeftClose, PanelLeftOpen, Users, WalletCards, type LucideIcon } from 'lucide-react';

import { BrandSymbol, IconButton, Logo, Skeleton } from '@ageniza/ui';

import { AccountMenu } from './account-menu.js';
import { HelpMenu } from './help-menu.js';
import { NotificationsBell } from './notifications-panel.js';
import { usePhone } from './use-phone.js';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** What the bottom bar shows when the label does not fit; the link keeps the full name. */
  short?: string;
}

/** The calendar is a working screen that needs the width: the navigation opens as a rail there. */
export const isCalendarPath = (pathname: string): boolean =>
  matchPath({ path: '/agencia/:agenciaId/conteudos/:clienteId', end: false }, pathname) !== null;

function NavGroup({ id, title, items }: { id: string; title: string; items: NavItem[] }) {
  if (items.length === 0) return null;
  return <section className="agency-nav__group" data-items={items.length} aria-labelledby={id}>
    <h2 className="agency-nav__group-title" id={id}>{title}</h2>
    <ul>
      {items.map(({ to, label, icon: Icon, end }) => <li key={to}>
        <NavLink to={to} end={end}><Icon aria-hidden="true" /><span>{label}</span></NavLink>
      </li>)}
    </ul>
  </section>;
}

export interface AgencySidebarProps {
  agenciaId: string;
  agencyName: string;
  permissions: readonly string[];
  /** The Owner is a property of the agency, not a role: it is "Dona" whatever the role says. */
  isOwner: boolean;
  roleName: string;
}

/**
 * The agency navigation (issue #628), in the layout of the approved board.
 * Wide: a side column, open at 248px or a rail at 80px (the person's explicit choice wins; until they make one, the calendar route
 * decides). Phone: a top bar with the mark, Ajuda and the person, and a bottom bar with the four daily destinations; Assinatura
 * goes to the account menu.
 */
export function AgencySidebar({ agenciaId, agencyName, permissions, isOwner, roleName }: AgencySidebarProps) {
  const { pathname } = useLocation();
  const phone = usePhone();
  const [choice, setChoice] = useState<boolean | null>(null);
  const collapsed = choice ?? isCalendarPath(pathname);

  const can = (permission: string): boolean => permissions.includes(permission);
  const canSeeCollaborators = can('colaborador.visualizar');
  const canSeeClients = can('cliente.visualizar');
  // The picker is the roster: contents without the roster is not a screen (decisions/2026-10-11-conteudo-o-item-exige-conteudo-e-carteira).
  const canSeeContents = can('conteudo.visualizar') && canSeeClients;
  const base = `/agencia/${agenciaId}`;
  const subscriptionTo = can('assinatura.gerenciar') ? `${base}/assinatura` : undefined;

  const work: NavItem[] = [
    { to: base, label: 'Início', icon: House, end: true },
    ...(canSeeContents ? [{ to: `${base}/conteudos`, label: 'Calendário Editorial', short: 'Calendário', icon: CalendarDays }] : []),
    ...(canSeeClients ? [{ to: `${base}/clientes`, label: 'Clientes', icon: Briefcase }] : [])
  ];
  const team: NavItem[] = canSeeCollaborators ? [{ to: `${base}/colaboradores`, label: 'Equipe', icon: Users }] : [];
  const agency: NavItem[] = [...team, ...(subscriptionTo === undefined ? [] : [{ to: subscriptionTo, label: 'Assinatura', icon: WalletCards }])];
  const role = { label: isOwner ? 'Dona' : roleName, owner: isOwner };

  if (phone) {
    const bottom = [...work, ...team];
    return <>
      <div className="agency-mbar">
        <Link className="agency-mbar__ctx" to="/contextos">
          <BrandSymbol variant="color" size={28} />
          <span className="agency-mbar__name">{agencyName}</span>
        </Link>
        <div className="agency-mbar__end">
          <NotificationsBell agencyId={agenciaId} />
          <HelpMenu />
          <AccountMenu variant="compact" activeContext={agencyName} contextLabel="Agência logada" subscriptionTo={subscriptionTo} />
        </div>
      </div>
      <nav className="agency-bottomnav" aria-label="Navegação da agência" style={{ '--n': bottom.length } as CSSProperties}>
        {bottom.map(({ to, label, short, icon: Icon, end }) => <NavLink key={to} to={to} end={end} aria-label={short === undefined ? undefined : label}>
          <Icon aria-hidden="true" /><span>{short ?? label}</span>
        </NavLink>)}
      </nav>
    </>;
  }

  return <aside className="agency-sidebar" data-collapsed={collapsed}>
    <div className="agency-sidebar__top">
      {collapsed ? <BrandSymbol variant="color" size={32} label="Ageniza" /> : <Logo variant="on-light" height={30} />}
      <IconButton
        className="agency-sidebar__toggle"
        label={collapsed ? 'Abrir navegação' : 'Recolher navegação'}
        aria-expanded={!collapsed}
        icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        onClick={() => { setChoice(!collapsed); }}
      />
    </div>
    <Link className="agency-sidebar__context" to="/contextos">
      <BrandSymbol variant="color" size={36} />
      <span className="agency-sidebar__context-text">
        <span className="agency-sidebar__context-label">Agência logada</span>
        <span className="agency-sidebar__context-name">{agencyName}</span>
      </span>
      <ChevronsUpDown aria-hidden="true" />
    </Link>
    <nav className="agency-nav" aria-label="Navegação da agência">
      <NavGroup id="agency-nav-work" title="Trabalho" items={work} />
      <NavGroup id="agency-nav-agency" title="Agência" items={agency} />
    </nav>
    <div className="agency-sidebar__foot">
      <AccountMenu variant="sidebar" activeContext={agencyName} contextLabel="Agência logada" role={role} />
    </div>
  </aside>;
}

export function AgencySidebarSkeleton() {
  const phone = usePhone();
  if (phone) return <div className="agency-mbar"><BrandSymbol variant="color" size={28} label="Ageniza" /></div>;
  return <aside className="agency-sidebar" data-collapsed={false}>
    <div className="agency-sidebar__top"><Logo variant="on-light" height={30} /></div>
    <div className="agency-sidebar__context"><Skeleton className="agency-header__skeleton" /></div>
    <nav className="agency-nav" aria-label="Navegação da agência"><Skeleton /></nav>
    <div className="agency-sidebar__foot"><AccountMenu variant="sidebar" /></div>
  </aside>;
}
