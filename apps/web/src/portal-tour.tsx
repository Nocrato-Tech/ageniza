import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@ageniza/ui';

/**
 * The welcome tour (specs/clientes.md §7, issue #144). A step names the navigation item it points
 * at, so adding Calendário or Relatórios later is one more entry here once their modules work.
 */
export type PortalTourTarget = 'inicio' | 'marca';

interface TourStep {
  readonly target: PortalTourTarget;
  readonly title: string;
  readonly body: string;
}

export const PORTAL_TOUR_STEPS: readonly TourStep[] = [
  { target: 'inicio', title: 'Início', body: 'Aqui você vê a próxima coisa a fazer, sempre uma só.' },
  { target: 'marca', title: 'Sua marca', body: 'Aqui fica o estudo da sua marca, do jeito que a agência entende o seu negócio.' },
  { target: 'marca', title: 'Como sugerir', body: 'Se quiser mudar algo, abra a Marca e toque em Sugerir ao lado da parte que você quer ajustar.' }
];

export interface PortalTourProps {
  readonly personName: string;
  readonly clientName: string;
  readonly agencyName: string;
  /** Called once when the tour ends: `completed` is true on the last step, false on Pular or Esc. */
  readonly onClose: (completed: boolean) => void;
  readonly onTargetChange: (target: PortalTourTarget | null) => void;
}

export function PortalTour({ personName, clientName, agencyName, onClose, onTargetChange }: PortalTourProps) {
  // -1 is the welcome card; 0..n-1 are the steps that point at the navigation.
  const [index, setIndex] = useState(-1);
  const cardRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const step = index >= 0 ? PORTAL_TOUR_STEPS[index] : undefined;
  const last = index === PORTAL_TOUR_STEPS.length - 1;

  useEffect(() => {
    const previousFocus = document.activeElement;
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    onTargetChange(step?.target ?? null);
    cardRef.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus();
  }, [index]);

  useEffect(() => () => { onTargetChange(null); }, []);

  const close = (completed: boolean): void => { onClose(completed); };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(false);
      return;
    }
    if (event.key !== 'Tab' || cardRef.current === null) return;
    const focusable = Array.from(cardRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
    const first = focusable[0];
    const lastButton = focusable[focusable.length - 1];
    if (first === undefined || lastButton === undefined) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); lastButton.focus(); }
    else if (!event.shiftKey && document.activeElement === lastButton) { event.preventDefault(); first.focus(); }
  };

  return <section
    ref={cardRef}
    className="portal-tour"
    data-step={step === undefined ? 'welcome' : String(index + 1)}
    data-target={step?.target}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    onKeyDown={onKeyDown}
  >
    {step === undefined ? <>
      <h2 id={titleId}>Boas-vindas, {personName}!</h2>
      <p>Este é o espaço de {clientName} com {agencyName}.</p>
      <div className="portal-tour__actions">
        <Button variant="ghost" onClick={() => { close(false); }}>Pular</Button>
        <Button data-tour-primary onClick={() => { setIndex(0); }}>Começar</Button>
      </div>
    </> : <>
      <h2 id={titleId}>{step.title}</h2>
      <p>{step.body}</p>
      <p className="portal-tour__progress">passo {index + 1} de {PORTAL_TOUR_STEPS.length}</p>
      <div className="portal-tour__actions">
        <Button variant="ghost" onClick={() => { close(false); }}>Pular</Button>
        {index > 0 && <Button variant="secondary" onClick={() => { setIndex(index - 1); }}>Voltar</Button>}
        <Button data-tour-primary onClick={() => { if (last) close(true); else setIndex(index + 1); }}>
          {last ? 'Concluir' : 'Próximo'}
        </Button>
      </div>
    </>}
  </section>;
}
