// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Bell, Eye, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AvatarGroup, BadgeCard, Button, Chip, ChoiceRadio, DatePicker, EmptyState, Field, IconButton, Kbd, Menu, MenuItem, MenuSeparator, ProgressBar, SearchField, StatusTag, Tabs, TextInput, Trait } from './index.js';

afterEach(cleanup);

describe('StatusTag scheduled and size', () => {
  it('gives Agendado its own class and the calendar-clock shape, apart from the other states', () => {
    const { container } = render(<><StatusTag status="scheduled">Agendado</StatusTag><StatusTag status="waiting">Aguardando</StatusTag></>);
    const [scheduled, waiting] = Array.from(container.querySelectorAll('.ui-status-tag'));

    expect(scheduled!.classList.contains('ui-status-tag--scheduled')).toBe(true);
    expect(scheduled!.textContent).toBe('Agendado');
    expect(scheduled!.querySelector('svg')!.outerHTML).not.toBe(waiting!.querySelector('svg')!.outerHTML);
  });

  it('is medium unless asked for the large label of a page header', () => {
    const { container } = render(<><StatusTag status="ready">Aprovado</StatusTag><StatusTag status="ready" size="lg">Aprovado</StatusTag></>);
    const [medium, large] = Array.from(container.querySelectorAll('.ui-status-tag'));

    expect(medium!.classList.contains('ui-status-tag--lg')).toBe(false);
    expect(large!.classList.contains('ui-status-tag--lg')).toBe(true);
  });
});

describe('Button danger-quiet and IconButton dot', () => {
  it('maps the discreet danger to its own class and keeps the label as the name', () => {
    render(<Button variant="danger-quiet">Excluir</Button>);

    expect(screen.getByRole('button', { name: 'Excluir' }).classList.contains('ui-button--danger-quiet')).toBe(true);
  });

  it('says what the dot means in the name and the tooltip, and draws it hidden from assistive technology', () => {
    render(<IconButton label="Notificações" dot="3 não lidas" icon={<Bell />} />);
    const button = screen.getByRole('button', { name: 'Notificações, 3 não lidas' });

    expect(button.getAttribute('title')).toBe('Notificações, 3 não lidas');
    expect(button.classList.contains('ui-icon-button--dot')).toBe(true);
    expect(button.querySelector('.ui-icon-button__dot')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws no dot and keeps the plain name without one', () => {
    render(<IconButton label="Notificações" icon={<Bell />} />);
    const button = screen.getByRole('button', { name: 'Notificações' });

    expect(button.querySelector('.ui-icon-button__dot')).toBeNull();
    expect(button.classList.contains('ui-icon-button--dot')).toBe(false);
  });
});

describe('Field suffix and counter', () => {
  it('puts the suffix inside the control box and describes the control by it, before the other descriptions', () => {
    render(<Field label="Prazo para o cliente" suffix="horas" hint="De 1 a 168">{(control) => <TextInput {...control} defaultValue="48" />}</Field>);
    const input = screen.getByLabelText('Prazo para o cliente');
    const suffix = screen.getByText('horas');

    expect(suffix.parentElement!.contains(input)).toBe(true);
    expect(input.getAttribute('aria-describedby')!.split(' ')[0]).toBe(suffix.id);
    expect(suffix.parentElement!.style.getPropertyValue('--ui-field-suffix-ch')).toBe('5');
  });

  it('adds no wrapper when there is no suffix', () => {
    const { container } = render(<Field label="Título">{(control) => <TextInput {...control} />}</Field>);

    expect(container.querySelector('.ui-field__control')).toBeNull();
  });

  it('reads the counter as "N de M" when asked, and as N/M by default', () => {
    render(<>
      <Field label="Recado" counter={{ count: 52, max: 280, format: 'of' }}>{(control) => <TextInput {...control} />}</Field>
      <Field label="Legenda" counter={{ count: 12, max: 80 }}>{(control) => <TextInput {...control} />}</Field>
    </>);

    expect(screen.getByText('52 de 280')).toBeTruthy();
    expect(screen.getByText('12/80')).toBeTruthy();
  });

  it('keeps a polite, atomic live region that stays empty while there is room, so typing is not read letter by letter', () => {
    const { container } = render(<Field label="Recado" counter={{ count: 52, max: 280, format: 'of' }}>{(control) => <TextInput {...control} />}</Field>);
    const live = container.querySelector('.ui-field__live')!;

    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('aria-atomic')).toBe('true');
    expect(live.textContent).toBe('');
  });

  it('says how many characters remain near the limit and by how many it was passed', () => {
    const { container, rerender } = render(<Field label="Recado" counter={{ count: 270, max: 280 }}>{(control) => <TextInput {...control} />}</Field>);
    const live = (): string => container.querySelector('.ui-field__live')!.textContent ?? '';

    expect(live()).toBe('Restam 10 caracteres.');
    rerender(<Field label="Recado" counter={{ count: 279, max: 280 }}>{(control) => <TextInput {...control} />}</Field>);
    expect(live()).toBe('Restam 1 caractere.');
    rerender(<Field label="Recado" counter={{ count: 283, max: 280 }}>{(control) => <TextInput {...control} />}</Field>);
    expect(live()).toBe('Passou do limite em 3 caracteres.');
  });
});

describe('DatePicker marked days', () => {
  function Harness({ marked }: { marked?: readonly string[] }) {
    const [value, setValue] = useState('2026-10-20');
    return <Field label="Dia">{(control) => <DatePicker {...control} today="2026-10-16" value={value} onChange={setValue} {...(marked === undefined ? {} : { markedDates: marked })} />}</Field>;
  }
  const open = (): HTMLElement => {
    fireEvent.click(screen.getByRole('button', { name: 'Abrir calendário' }));
    return screen.getByRole('dialog');
  };

  it('dots the marked days, says "tem conteúdo" in their name and explains the dot in the footer', () => {
    render(<Harness marked={['2026-10-17', '2026-10-20']} />);
    const panel = open();
    const day = (iso: string): HTMLElement => panel.querySelector<HTMLElement>(`button[data-day="${iso}"]`)!;

    expect(day('2026-10-17').classList.contains('ui-date-picker__day--marked')).toBe(true);
    expect(day('2026-10-17').getAttribute('aria-label')).toMatch(/, tem conteúdo$/);
    expect(day('2026-10-18').classList.contains('ui-date-picker__day--marked')).toBe(false);
    expect(day('2026-10-18').getAttribute('aria-label')).not.toMatch(/tem conteúdo/);
    expect(within(panel).getByText('tem conteúdo').className).toBe('ui-date-picker__legend');
  });

  it('keeps the footer without a legend, and the days plain, when nothing is marked', () => {
    render(<Harness />);
    const panel = open();

    expect(panel.querySelector('.ui-date-picker__legend')).toBeNull();
    expect(panel.querySelector('.ui-date-picker__day--marked')).toBeNull();
  });

  it('keeps "Hoje" in the footer: it picks the day of the business today and closes the calendar', () => {
    render(<Harness marked={['2026-10-17']} />);
    const panel = open();

    fireEvent.click(within(panel).getByRole('button', { name: 'Hoje' }));

    expect((screen.getByLabelText('Dia') as HTMLInputElement).value).toBe('16/10/2026');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Tabs count chip', () => {
  it('shows the count in a chip that is part of the tab name, and none where there is no count', () => {
    render(<Tabs label="Seções" value="media" onChange={() => undefined} items={[
      { value: 'overview', label: 'Visão geral', content: null },
      { value: 'media', label: 'Mídias', count: 163, content: null }
    ]} />);

    expect(screen.getByRole('tab', { name: 'Mídias 163' }).querySelector('.ui-tabs__count')!.textContent).toBe('163');
    expect(screen.getByRole('tab', { name: 'Visão geral' }).querySelector('.ui-tabs__count')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Mídias 163' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('Menu with icons and the danger item', () => {
  it('draws the icon hidden from the name and keeps the label as the name of the item', () => {
    render(<Menu label="Ações do arquivo" trigger="Ações">
      <MenuItem icon={<Eye />}>Abrir</MenuItem><MenuSeparator /><MenuItem variant="destructive" icon={<Trash2 />}>Excluir</MenuItem>
    </Menu>);
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));

    const open = screen.getByRole('menuitem', { name: 'Abrir' });
    expect(open.querySelector('.ui-icon')!.getAttribute('aria-hidden')).toBe('true');
    const danger = screen.getByRole('menuitem', { name: 'Excluir' });
    expect(danger.classList.contains('ui-menu-item--destructive')).toBe(true);
    expect(danger.querySelector('.ui-icon')).not.toBeNull();
  });

  it('walks the items with the arrow keys, Home and End, and closes on Esc returning focus to the trigger', () => {
    render(<Menu label="Ações" trigger="Ações"><MenuItem icon={<Eye />}>Abrir</MenuItem><MenuItem>Baixar</MenuItem><MenuItem variant="destructive" icon={<Trash2 />}>Excluir</MenuItem></Menu>);
    const trigger = screen.getByRole('button', { name: 'Ações' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');

    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Abrir' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Baixar' }));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Excluir' }));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Abrir' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('EmptyState failure with the serious owl', () => {
  it('shows the serious owl instead of the alert icon, the code and the second action, and stays an alert', () => {
    const retry = vi.fn();
    const { container } = render(<EmptyState kind="failure" mascot title="Não foi possível carregar as mídias" onRetry={retry} secondaryAction={<Button variant="ghost">Avisar o suporte</Button>} code="Código 503 · 11 nov, 10h42" />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(container.querySelector('img.ui-mascot')!.getAttribute('src')).toBe('/brand/mascote-serio.webp');
    expect(container.querySelector('.ui-empty-state__icon')).toBeNull();
    expect(container.firstElementChild!.classList.contains('ui-empty-state--serious')).toBe(true);
    expect(screen.getByText('Código 503 · 11 nov, 10h42').className).toBe('ui-empty-state__code');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Avisar o suporte' })).toBeTruthy();
  });

  it('keeps the failure without a mascot as it was: the alert icon, no owl, no code', () => {
    const { container } = render(<EmptyState kind="failure" title="Falhou" onRetry={() => undefined} />);

    expect(container.querySelector('.ui-empty-state__icon')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.ui-empty-state__code')).toBeNull();
  });

  it('keeps the friendly owl of the first use as it was', () => {
    const { container } = render(<EmptyState mascot title="Cadastre o primeiro cliente" />);

    expect(container.querySelector('img.ui-mascot')!.getAttribute('src')).toBe('/brand/mascote-amigavel.webp');
    expect(container.firstElementChild!.classList.contains('ui-empty-state--mascot')).toBe(true);
    expect(container.firstElementChild!.classList.contains('ui-empty-state--serious')).toBe(false);
  });

  it('holds the retry button busy while it repeats, as before', () => {
    render(<EmptyState kind="failure" mascot title="Falhou" onRetry={() => undefined} retrying />);

    expect(screen.getByRole('button', { name: 'Tentar de novo' }).getAttribute('aria-busy')).toBe('true');
  });
});

describe('BadgeCard role colour and the owner', () => {
  it('says "Dona da agência" with a crown, in indigo, whatever the role passed, for the owner', () => {
    const { container } = render(<BadgeCard name="Marina Bastos" role="Admin" isOwner />);

    expect(screen.getByText('Dona da agência')).toBeTruthy();
    expect(screen.queryByText('Admin')).toBeNull();
    expect(container.querySelector('.ui-badge-card__role .ui-role-tag')!.classList.contains('ui-role-tag--indigo')).toBe(true);
  });

  it('takes the colour of the role it is given, and stays neutral without one', () => {
    const { container } = render(<><BadgeCard name="Bianca Torres" role="Vendas" roleTone="sky" /><BadgeCard name="Henrique Dias" role="Financeiro" /></>);
    const [sky, plain] = Array.from(container.querySelectorAll('.ui-badge-card__role .ui-role-tag'));

    expect(sky!.classList.contains('ui-role-tag--sky')).toBe(true);
    expect(plain!.className).toBe('ui-pill ui-pill--neutral ui-role-tag');
    expect(screen.getByText('Vendas')).toBeTruthy();
  });
});

describe('Kbd', () => {
  it('is a kbd element with the chord as its text', () => {
    render(<Kbd>Ctrl K</Kbd>);

    expect(screen.getByText('Ctrl K').tagName).toBe('KBD');
  });
});

describe('SearchField', () => {
  function Harness({ shortcut = false, onSearch }: { shortcut?: boolean; onSearch?: (value: string) => void }) {
    const [text, setText] = useState('');
    return <SearchField label="Buscar" placeholder="Buscar cliente, conteúdo ou arquivo" value={text} onChange={setText} shortcut={shortcut} {...(onSearch === undefined ? {} : { onSearch })} />;
  }

  it('is a search input named by its label, not by its placeholder', () => {
    render(<Harness />);
    const input = screen.getByRole('searchbox', { name: 'Buscar' });

    expect(input.getAttribute('placeholder')).toBe('Buscar cliente, conteúdo ou arquivo');
    expect(screen.queryByText('Ctrl K')).toBeNull();
    expect(input.hasAttribute('aria-keyshortcuts')).toBe(false);
  });

  it('shows the shortcut hint and announces it as a key shortcut', () => {
    render(<Harness shortcut />);

    expect(screen.getByText('Ctrl K').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('searchbox', { name: 'Buscar' }).getAttribute('aria-keyshortcuts')).toBe('Control+K Meta+K');
  });

  it('focuses the field on Ctrl+K and on Cmd+K from anywhere, and ignores K alone', () => {
    render(<><button type="button">Outro</button><Harness shortcut /></>);
    const input = screen.getByRole('searchbox');

    screen.getByRole('button', { name: 'Outro' }).focus();
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(input);
    screen.getByRole('button', { name: 'Outro' }).focus();
    fireEvent.keyDown(document.body, { key: 'K', metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  it('does not listen for Ctrl+K without the shortcut, and stops listening when it goes away', () => {
    const { unmount } = render(<><button type="button">Outro</button><Harness /></>);
    screen.getByRole('button', { name: 'Outro' }).focus();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outro' }));
    unmount();

    const spy = vi.spyOn(document, 'removeEventListener');
    const again = render(<Harness shortcut />);
    again.unmount();
    expect(spy).toHaveBeenCalledWith('keydown', expect.any(Function));
    spy.mockRestore();
  });

  it('searches on Enter with the text, and Esc clears the text before anything else', () => {
    const search = vi.fn();
    render(<Harness onSearch={search} />);
    const input = screen.getByRole('searchbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'padaria' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(search).toHaveBeenCalledWith('padaria');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
  });

  it('leaves Esc alone when there is no text, so it can close what holds the field', () => {
    render(<Harness />);
    const input = screen.getByRole('searchbox');

    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
  });
});

describe('Chip', () => {
  it('is a toggle button: aria-pressed follows selected and the count is part of the name', () => {
    render(<><Chip count={5}>Reels</Chip><Chip selected count={16}>Todos</Chip></>);
    const reels = screen.getByRole('button', { name: 'Reels 5' });
    const all = screen.getByRole('button', { name: 'Todos 16' });

    expect(reels.getAttribute('aria-pressed')).toBe('false');
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(all.classList.contains('ui-chip--selected')).toBe(true);
    expect(reels.classList.contains('ui-chip--selected')).toBe(false);
    expect(reels.querySelector('.ui-chip__count')!.textContent).toBe('5');
    expect(reels.getAttribute('type')).toBe('button');
  });

  it('draws no count when there is none, and shows a zero', () => {
    render(<><Chip>Carrossel</Chip><Chip count={0}>Estático</Chip></>);

    expect(screen.getByRole('button', { name: 'Carrossel' }).querySelector('.ui-chip__count')).toBeNull();
    expect(screen.getByRole('button', { name: 'Estático 0' })).toBeTruthy();
  });

  it('does not answer a click while it is disabled', () => {
    const click = vi.fn();
    render(<Chip disabled onClick={click}>Reels</Chip>);

    fireEvent.click(screen.getByRole('button', { name: 'Reels' }));
    expect(click).not.toHaveBeenCalled();
  });
});

describe('AvatarGroup', () => {
  const people = ['Marina Bastos', 'João Pereira', 'Rafael Teixeira', 'Júlia Prado', 'Paula Ramos'].map((name) => ({ name }));

  it('shows three avatars and "+2" for five people, and names everyone as one image', () => {
    const { container } = render(<AvatarGroup label="Responsáveis" people={people} />);

    expect(container.querySelectorAll('.ui-avatar')).toHaveLength(3);
    expect(container.querySelector('.ui-avatar-group__more')!.textContent).toBe('+2');
    expect(screen.getByRole('img', { name: 'Responsáveis: Marina Bastos, João Pereira, Rafael Teixeira, Júlia Prado, Paula Ramos' })).toBeTruthy();
  });

  it('draws no "+N" when everyone fits, and tells the people apart by tone', () => {
    const { container } = render(<AvatarGroup people={people.slice(0, 3)} />);
    const avatars = Array.from(container.querySelectorAll('.ui-avatar'));

    expect(container.querySelector('.ui-avatar-group__more')).toBeNull();
    expect(avatars[0]!.classList.contains('ui-avatar--violet')).toBe(false);
    expect(avatars[1]!.classList.contains('ui-avatar--violet')).toBe(true);
    expect(avatars[2]!.classList.contains('ui-avatar--teal')).toBe(true);
    expect(screen.getByRole('img', { name: 'Marina Bastos, João Pereira, Rafael Teixeira' })).toBeTruthy();
  });

  it('honours max and the tone a person brings', () => {
    const { container } = render(<AvatarGroup max={1} people={[{ name: 'Ana Souza', tone: 'sky' }, ...people.slice(0, 2)]} />);

    expect(container.querySelectorAll('.ui-avatar')).toHaveLength(1);
    expect(container.querySelector('.ui-avatar')!.classList.contains('ui-avatar--sky')).toBe(true);
    expect(container.querySelector('.ui-avatar-group__more')!.textContent).toBe('+2');
  });
});

describe('ProgressBar', () => {
  it('is a named progressbar with its value and limits', () => {
    render(<ProgressBar label="Aprovação do mês" value={75} />);
    const bar = screen.getByRole('progressbar', { name: 'Aprovação do mês' });

    expect(bar.getAttribute('aria-valuenow')).toBe('75');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.style.getPropertyValue('--ui-progress')).toBe('75%');
  });

  it('measures against max and clamps what is out of range', () => {
    render(<><ProgressBar label="Publicados" value={40} max={50} /><ProgressBar label="Acima" value={130} /><ProgressBar label="Abaixo" value={-5} /><ProgressBar label="Nada" value={Number.NaN} /></>);

    expect(screen.getByRole('progressbar', { name: 'Publicados' }).style.getPropertyValue('--ui-progress')).toBe('80%');
    expect(screen.getByRole('progressbar', { name: 'Acima' }).getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByRole('progressbar', { name: 'Abaixo' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole('progressbar', { name: 'Nada' }).getAttribute('aria-valuenow')).toBe('0');
  });

  it('takes the teal tone on request', () => {
    render(<ProgressBar label="Meta" value={10} tone="teal" />);

    expect(screen.getByRole('progressbar').classList.contains('ui-progress-bar--teal')).toBe(true);
  });
});

describe('ChoiceRadio', () => {
  function Group() {
    const [value, setValue] = useState('approve');
    return <fieldset>
      <legend>O que fazer com o post</legend>
      <ChoiceRadio name="decision" value="approve" checked={value === 'approve'} onChange={() => setValue('approve')} title="Aprovar como está" description="A agência já pode agendar a publicação." />
      <ChoiceRadio name="decision" value="adjust" checked={value === 'adjust'} onChange={() => setValue('adjust')} title="Pedir ajuste" />
    </fieldset>;
  }

  it('is a native radio named by the title and described by the description, not named by both', () => {
    render(<Group />);
    const approve = screen.getByRole('radio', { name: 'Aprovar como está' });

    expect(approve.getAttribute('aria-describedby')).toBe(screen.getByText('A agência já pode agendar a publicação.').id);
    expect((approve as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Pedir ajuste' }).hasAttribute('aria-describedby')).toBe(false);
    expect(screen.getByRole('group', { name: 'O que fazer com o post' })).toBeTruthy();
  });

  it('chooses by click on the card text and reports the change', () => {
    render(<Group />);

    fireEvent.click(screen.getByText('Pedir ajuste'));

    expect((screen.getByRole('radio', { name: 'Pedir ajuste' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Aprovar como está' }) as HTMLInputElement).checked).toBe(false);
  });

  it('does not choose while it is disabled', () => {
    const change = vi.fn();
    render(<ChoiceRadio name="x" value="a" title="Uma" disabled onChange={change} />);

    fireEvent.click(screen.getByText('Uma'));
    expect(change).not.toHaveBeenCalled();
  });
});

describe('Trait', () => {
  it('is a static capsule with the trait as its text, and takes extra classes', () => {
    const { container } = render(<><Trait>Rotina corrida</Trait><Trait className="extra">Compra por impulso</Trait></>);
    const [first, second] = Array.from(container.querySelectorAll('span'));

    expect(first!.className).toBe('ui-trait');
    expect(first!.textContent).toBe('Rotina corrida');
    expect(second!.className).toBe('ui-trait extra');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('passes attributes through, so a list of traits can be labelled', () => {
    render(<Trait data-testid="trait" title="Hábito">Vai todo dia às 7h</Trait>);

    expect(screen.getByTestId('trait').getAttribute('title')).toBe('Hábito');
  });
});
