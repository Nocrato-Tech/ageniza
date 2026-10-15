import type { ReactNode, Ref } from 'react';
import { CircleAlert, CircleCheck, Clock, PencilLine } from 'lucide-react';
import { Link, Outlet } from 'react-router-dom';
import { Logo } from '@ageniza/ui';

/** An anchor wearing the primary Button, for a way forward that is a navigation. Swap for ButtonLink when #625 lands. */
export const AUTH_LINK_BUTTON_CLASS = 'ui-button ui-button--primary ui-button--md auth-submit';

/** Sign-in, recovery, invitation and e-mail confirmation: the logo, one column, the legal links, and the example week beside it on a wide screen. */
export function AuthLayout() {
  return <div className="auth">
    <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
    <div className="auth__column">
      <header className="auth__brand"><Link to="/"><Logo variant="on-light" height={40} /></Link></header>
      <main id="main-content" className="auth__main"><Outlet /></main>
      <footer className="auth__legal">
        <Link to="/termos">Termos de uso</Link>
        <Link to="/privacidade">Privacidade</Link>
      </footer>
    </div>
    <AuthShowcase />
  </div>;
}

export interface AuthPanelProps {
  titleId: string;
  title: string;
  /** One sentence under the title that says what the screen is for. */
  lead?: string;
  /** Lets a screen that swaps its form for a confirmation move focus to the new title. */
  headingRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
}

/** The title, the lead and the content of one auth screen, in the width every auth screen shares. */
export function AuthPanel({ titleId, title, lead, headingRef, children }: AuthPanelProps) {
  return <section className="auth-panel" aria-labelledby={titleId}>
    <div className="auth-panel__head">
      <h1 id={titleId} ref={headingRef} tabIndex={headingRef === undefined ? undefined : -1}>{title}</h1>
      {lead !== undefined && <p>{lead}</p>}
    </div>
    {children}
  </section>;
}

export interface AuthMessageProps {
  /** `danger` is a problem to fix; `success` is a state that already happened. The icon carries it too, never the colour alone. */
  tone: 'danger' | 'success';
  role?: 'alert' | 'status';
  children: ReactNode;
}

/** A line of feedback with its icon: errors and confirmations sit where the person is looking, not in a banner. */
export function AuthMessage({ tone, role, children }: AuthMessageProps) {
  const Icon = tone === 'danger' ? CircleAlert : CircleCheck;
  return <p role={role} className={`auth-message auth-message--${tone}`}>
    <Icon className="auth-message__icon" aria-hidden="true" />
    <span>{children}</span>
  </p>;
}

/** Decoration only: a made-up week of a made-up client, so the screen shows what the product is for. Hidden from assistive technology and below the wide breakpoint. */
function AuthShowcase() {
  return <div className="auth__showcase" aria-hidden="true">
    <p className="auth-showcase__title">O mês de cada cliente numa pauta só.</p>
    <p className="auth-showcase__lead">Planeje, mande para o cliente aprovar pelo celular e veja o feed se montar antes de publicar.</p>
    <div className="auth-week">
      <div className="auth-week__head"><span>Padaria Central · semana de 12/10</span><span>exemplo</span></div>
      <div className="auth-week__grid">
        <div className="auth-day">
          <span className="auth-day__label">SEG 12</span>
          <div className="auth-post auth-post--reels">
            <span>Dia das Crianças: sonho recheado</span>
            <span className="auth-post__tags">
              <span className="auth-tag auth-tag--reels">Reels</span>
              <span className="auth-state"><CircleAlert className="auth-state__icon auth-state__icon--late" />Atrasado</span>
            </span>
          </div>
        </div>
        <div className="auth-day auth-day--today">
          <span className="auth-day__label"><span className="auth-day__today">TER 13</span></span>
          <span className="auth-day__note">Stories · roteiro enviado</span>
        </div>
        <div className="auth-day">
          <span className="auth-day__label">QUA 14</span>
          <div className="auth-post auth-post--carousel">
            <span>Cardápio de outono</span>
            <span className="auth-post__tags">
              <span className="auth-tag auth-tag--carousel">Carrossel</span>
              <span className="auth-state"><PencilLine className="auth-state__icon auth-state__icon--adjust" />Em ajuste</span>
            </span>
          </div>
        </div>
        <div className="auth-day">
          <span className="auth-day__label">QUI 15</span>
          <div className="auth-post auth-post--reels">
            <span>Receita: bolo de fubá da vó</span>
            <span className="auth-post__tags">
              <span className="auth-tag auth-tag--reels">Reels</span>
              <span className="auth-state"><Clock className="auth-state__icon auth-state__icon--waiting" />Aguardando</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>;
}
