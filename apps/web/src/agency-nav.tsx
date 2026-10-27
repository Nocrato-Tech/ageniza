import { useState } from 'react';
import { Link, NavLink, matchPath, useLocation } from 'react-router-dom';
import { Briefcase, CalendarDays, ChevronsLeft, ChevronsRight, House, Users, type LucideIcon } from 'lucide-react';

import { BrandSymbol, IconButton, Logo, Skeleton } from '@ageniza/ui';

import { AccountMenu } from './account-menu.js';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
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

/**
 * The agency side navigation (issue #628): groups, the context link, the person and the way out.
 * Open at 248px, a rail at 80px, and a bottom bar below 48rem (the same markup, reshaped by CSS).
 * The person's explicit choice wins; until they make one, the calendar route decides.
 */
export function AgencySidebar({ agenciaId, agencyName, permissions }: { agenciaId: string; agencyName: string; permissions: readonly string[] }) {
  const { pathname } = useLocation();
  const [choice, setChoice] = useState<boolean | null>(null);
  const collapsed = choice ?? isCalendarPath(pathname);

  const can = (permission: string): boolean => permissions.includes(permission);
  const canSeeCollaborators = can('colaborador.visualizar');
  const canSeeClients = can('cliente.visualizar');
  // The picker is the roster: contents without the roster is not a screen (decisions/2026-10-11-conteudo-o-item-exige-conteudo-e-carteira).
  const canSeeContents = can('conteudo.visualizar') && canSeeClients;
  const base = `/agencia/${agenciaId}`;

  const work: NavItem[] = [
    { to: base, label: 'Início', icon: House, end: true },
    ...(canSeeContents ? [{ to: `${base}/conteudos`, label: 'Conteúdos', icon: CalendarDays }] : []),
    ...(canSeeClients ? [{ to: `${base}/clientes`, label: 'Clientes', icon: Briefcase }] : [])
  ];
  const agency: NavItem[] = canSeeCollaborators ? [{ to: `${base}/colaboradores`, label: 'Equipe', icon: Users }] : [];

  return <aside className="agency-sidebar" data-collapsed={collapsed}>
    <div className="agency-sidebar__top">
      {collapsed ? <BrandSymbol variant="white" size={32} label="Ageniza" /> : <Logo variant="on-dark" height={30} />}
      <IconButton
        className="agency-sidebar__toggle"
        label={collapsed ? 'Abrir navegação' : 'Recolher navegação'}
        aria-expanded={!collapsed}
        icon={collapsed ? <ChevronsRight /> : <ChevronsLeft />}
        onClick={() => { setChoice(!collapsed); }}
      />
    </div>
    <div className="agency-sidebar__context">
      <span className="agency-sidebar__context-label">Contexto ativo</span>
      <Link className="agency-sidebar__context-name" to={base}>{agencyName}</Link>
    </div>
    <nav className="agency-nav" aria-label="Navegação da agência">
      <NavGroup id="agency-nav-work" title="Trabalho" items={work} />
      <NavGroup id="agency-nav-agency" title="Agência" items={agency} />
    </nav>
    <div className="agency-sidebar__foot">
      <AccountMenu variant="sidebar" activeContext={agencyName} />
    </div>
  </aside>;
}

export function AgencySidebarSkeleton() {
  return <aside className="agency-sidebar" data-collapsed={false}>
    <div className="agency-sidebar__top"><Logo variant="on-dark" height={30} /></div>
    <div className="agency-sidebar__context"><Skeleton className="agency-header__skeleton" /></div>
    <nav className="agency-nav" aria-label="Navegação da agência"><Skeleton /></nav>
    <div className="agency-sidebar__foot"><AccountMenu variant="sidebar" reopensEmailChange={false} /></div>
  </aside>;
}
