// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ArrowRight, Grid2x2, List, Plus } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as ui from './index.js';
import { Button, IconButton, Pill, PillAction, Segmented, Tabs, type SegmentedOption, type TabItem } from './index.js';

afterEach(cleanup);

describe('exports', () => {
  it('never take the name of a JS global, which a consumer would silently shadow', () => {
    const shadowing = Object.keys(ui).filter((name) => name in globalThis);

    expect(shadowing).toEqual([]);
  });
});

describe('Button with an icon', () => {
  it('puts the icon before and after the label and keeps the label as the whole name', () => {
    render(<Button leadingIcon={<Plus />} trailingIcon={<ArrowRight />}>Nova publicação</Button>);
    const button = screen.getByRole('button', { name: 'Nova publicação' });
    const slots = button.querySelectorAll('.ui-icon');

    expect(slots).toHaveLength(2);
    expect(button.firstElementChild).toBe(slots[0]);
    expect(button.lastElementChild).toBe(slots[1]);
    expect(button.querySelector('.ui-button__label')?.textContent).toBe('Nova publicação');
    slots.forEach((slot) => expect(slot.getAttribute('aria-hidden')).toBe('true'));
  });

  it('draws no icon slot when none is given', () => {
    render(<Button>Salvar</Button>);

    expect(screen.getByRole('button', { name: 'Salvar' }).querySelector('.ui-icon')).toBeNull();
  });

  it('does not act while loading and keeps its name', () => {
    const onClick = vi.fn();
    render(<Button loading leadingIcon={<Plus />} onClick={onClick}>Enviar</Button>);
    const button = screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;

    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps the keyboard focus when it starts loading, and acts again when it stops', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Enviar</Button>);
    const button = screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
    button.focus();

    rerender(<Button loading onClick={onClick}>Enviar</Button>);
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);

    rerender(<Button onClick={onClick}>Enviar</Button>);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
  });

  it('does not submit its form while loading', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(<form onSubmit={onSubmit}><Button type="submit" loading>Enviar</Button></form>);

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('can take keyboard focus while idle and acts on a click', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Salvar</Button>);
    const button = screen.getByRole('button', { name: 'Salvar' });

    button.focus();
    fireEvent.click(button);

    expect(document.activeElement).toBe(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not act when disabled and cannot take focus', () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Salvar</Button>);
    const button = screen.getByRole('button', { name: 'Salvar' });

    fireEvent.click(button);
    button.focus();

    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(button);
  });
});

describe('Button with a blocked reason (issue #714)', () => {
  const describedBy = (button: HTMLElement) => (button.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent).join(' ');

  it('stays focusable, answers nothing, and reads the reason as its description, never as its name', () => {
    const onClick = vi.fn();
    render(<Button blockedReason="O plano precisa ser renovado." aria-describedby="other" onClick={onClick}>Convidar</Button>);
    const button = screen.getByRole('button', { name: 'Convidar' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-describedby')?.split(' ')[0]).toBe('other');
    expect(describedBy(button)).toContain('O plano precisa ser renovado.');
    expect(button.className).toContain('ui-button--blocked');
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is an ordinary button without one', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Convidar</Button>);
    const button = screen.getByRole('button', { name: 'Convidar' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('IconButton', () => {
  it('is named by its label, shows it as the tooltip and hides the glyph', () => {
    render(<IconButton label="Fechar" icon={<Plus />} />);
    const button = screen.getByRole('button', { name: 'Fechar' });

    expect(button.getAttribute('aria-label')).toBe('Fechar');
    expect(button.getAttribute('title')).toBe('Fechar');
    expect(button.textContent).toBe('');
    expect(button.querySelector('.ui-button__label')).toBeNull();
    expect(button.querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['ui-button', 'ui-icon-button', 'ui-button--ghost', 'ui-button--md']));
  });

  it('takes a variant and a size like a button', () => {
    render(<IconButton label="Adicionar" icon={<Plus />} variant="primary" size="sm" />);

    expect(screen.getByRole('button', { name: 'Adicionar' }).className.split(' ')).toEqual(
      expect.arrayContaining(['ui-button--primary', 'ui-button--sm'])
    );
  });

  it('keeps its name while loading, does not act and keeps the keyboard focus', () => {
    const onClick = vi.fn();
    const { rerender } = render(<IconButton label="Adicionar" icon={<Plus />} onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement;
    button.focus();

    rerender(<IconButton label="Adicionar" icon={<Plus />} loading onClick={onClick} />);
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('takes keyboard focus and acts on a click while idle', () => {
    const onClick = vi.fn();
    render(<IconButton label="Adicionar" icon={<Plus />} onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Adicionar' });

    button.focus();
    fireEvent.click(button);

    expect(document.activeElement).toBe(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Pill', () => {
  it('is a static capsule with its text, an optional hidden icon and a tone', () => {
    render(<Pill tone="accent" icon={<Plus />} data-testid="pill">24</Pill>);
    const pill = screen.getByTestId('pill');

    expect(pill.tagName).toBe('SPAN');
    expect(pill.textContent).toBe('24');
    expect(pill.className.split(' ')).toEqual(expect.arrayContaining(['ui-pill', 'ui-pill--accent']));
    expect(pill.querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is neutral by default', () => {
    render(<Pill data-testid="pill">3</Pill>);

    expect(screen.getByTestId('pill').className.split(' ')).toContain('ui-pill--neutral');
  });
});

describe('PillAction', () => {
  it('is a non-submitting button named by its label, with the icon outside the name', () => {
    const onClick = vi.fn();
    render(<PillAction trailingIcon={<ArrowRight />} onClick={onClick}>Abrir</PillAction>);
    const button = screen.getByRole('button', { name: 'Abrir' });

    button.focus();
    fireEvent.click(button);

    expect(button.getAttribute('type')).toBe('button');
    expect(document.activeElement).toBe(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['ui-pill', 'ui-pill--action', 'ui-pill--neutral']));
    expect(button.querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not act when disabled and cannot take focus', () => {
    const onClick = vi.fn();
    render(<PillAction disabled onClick={onClick}>Abrir</PillAction>);
    const button = screen.getByRole('button', { name: 'Abrir' });

    fireEvent.click(button);
    button.focus();

    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(button);
  });

  it('keeps its name while loading, marks itself busy, does not act and keeps the keyboard focus', () => {
    const onClick = vi.fn();
    const { rerender } = render(<PillAction tone="accent" onClick={onClick}>Abrir</PillAction>);
    const button = screen.getByRole('button', { name: 'Abrir' }) as HTMLButtonElement;
    button.focus();

    rerender(<PillAction loading tone="accent" onClick={onClick}>Abrir</PillAction>);
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['ui-pill--loading', 'ui-pill--accent']));
  });

  it('acts again once it stops loading', () => {
    const onClick = vi.fn();
    const { rerender } = render(<PillAction loading onClick={onClick}>Abrir</PillAction>);
    rerender(<PillAction onClick={onClick}>Abrir</PillAction>);

    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Abrir' }).hasAttribute('aria-disabled')).toBe(false);
  });
});

const views: SegmentedOption[] = [
  { value: 'grid', label: 'Grade', icon: <Grid2x2 /> },
  { value: 'list', label: 'Lista', icon: <List /> },
  { value: 'map', label: 'Mapa', disabled: true },
  { value: 'table', label: 'Tabela' }
];

function SegmentedHarness({ onChange = () => undefined, disabled, loading, initial = 'grid' }: { onChange?: (value: string) => void; disabled?: boolean; loading?: boolean; initial?: string }) {
  const [value, setValue] = useState(initial);
  return <Segmented label="Visualização" value={value} options={views} disabled={disabled} loading={loading} onChange={(next) => { setValue(next); onChange(next); }} />;
}

const radio = (name: string): HTMLButtonElement => screen.getByRole('radio', { name }) as HTMLButtonElement;
const radioNames = ['Grade', 'Lista', 'Mapa', 'Tabela'];

describe('Segmented', () => {
  it('is a named radio group whose options are named by their visible text', () => {
    render(<SegmentedHarness />);
    const group = screen.getByRole('radiogroup', { name: 'Visualização' });

    expect(within(group).getAllByRole('radio').map((option) => option.textContent)).toEqual(radioNames);
    expect(radio('Grade').querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks only the chosen option and gives the group a single tab stop on it', () => {
    render(<SegmentedHarness initial="list" />);

    expect(radioNames.map((name) => radio(name).getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false']);
    expect(radioNames.map((name) => radio(name).tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it('chooses an option on click and reports its value', () => {
    const onChange = vi.fn();
    render(<SegmentedHarness onChange={onChange} />);

    fireEvent.click(radio('Lista'));

    expect(onChange).toHaveBeenCalledWith('list');
    expect(radio('Lista').getAttribute('aria-checked')).toBe('true');
    expect(radio('Grade').getAttribute('aria-checked')).toBe('false');
  });

  it('moves focus and choice with the arrow keys, skipping a disabled option and wrapping at the ends', () => {
    const onChange = vi.fn();
    render(<SegmentedHarness onChange={onChange} />);

    radio('Grade').focus();
    expect(fireEvent.keyDown(radio('Grade'), { key: 'ArrowRight' })).toBe(false);
    expect(document.activeElement).toBe(radio('Lista'));
    expect(onChange).toHaveBeenLastCalledWith('list');

    fireEvent.keyDown(radio('Lista'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(radio('Tabela'));
    expect(onChange).toHaveBeenLastCalledWith('table');

    fireEvent.keyDown(radio('Tabela'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radio('Grade'));

    fireEvent.keyDown(radio('Grade'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(radio('Tabela'));
    expect(radio('Tabela').getAttribute('aria-checked')).toBe('true');
  });

  it('jumps to the first and last usable option with Home and End', () => {
    render(<SegmentedHarness initial="list" />);

    fireEvent.keyDown(radio('Lista'), { key: 'End' });
    expect(document.activeElement).toBe(radio('Tabela'));

    fireEvent.keyDown(radio('Tabela'), { key: 'Home' });
    expect(document.activeElement).toBe(radio('Grade'));
  });

  it('ignores keys that are not movement and never chooses a disabled option', () => {
    const onChange = vi.fn();
    render(<SegmentedHarness onChange={onChange} />);

    expect(fireEvent.keyDown(radio('Grade'), { key: 'Enter' })).toBe(true);
    fireEvent.click(radio('Mapa'));

    expect(onChange).not.toHaveBeenCalled();
    expect(radio('Mapa').disabled).toBe(true);
  });

  it('puts the tab stop on the first usable option when the value matches none', () => {
    render(<SegmentedHarness initial="unknown" />);

    expect(radioNames.map((name) => radio(name).tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('freezes every option when disabled', () => {
    const onChange = vi.fn();
    render(<SegmentedHarness disabled onChange={onChange} />);

    fireEvent.click(radio('Lista'));
    fireEvent.keyDown(radio('Grade'), { key: 'ArrowRight' });

    expect(onChange).not.toHaveBeenCalled();
    expect(radioNames.every((name) => radio(name).disabled)).toBe(true);
    expect(screen.getByRole('radiogroup').getAttribute('aria-disabled')).toBe('true');
  });

  it('freezes the choice and says it is busy while loading, without taking the keyboard focus away', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Segmented label="Visualização" value="grid" options={views} onChange={onChange} />);
    radio('Grade').focus();

    rerender(<Segmented label="Visualização" value="grid" options={views} onChange={onChange} loading />);
    fireEvent.click(radio('Lista'));
    expect(fireEvent.keyDown(radio('Grade'), { key: 'ArrowRight' })).toBe(false);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radiogroup').getAttribute('aria-busy')).toBe('true');
    expect(radio('Grade').disabled).toBe(false);
    expect(radio('Grade').getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(radio('Grade'));
    expect(radio('Grade').getAttribute('aria-checked')).toBe('true');
  });

  it('chooses again once it stops loading', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Segmented label="Visualização" value="grid" options={views} onChange={onChange} loading />);
    rerender(<Segmented label="Visualização" value="grid" options={views} onChange={onChange} />);

    fireEvent.click(radio('Lista'));

    expect(onChange).toHaveBeenCalledWith('list');
    expect(radio('Lista').hasAttribute('aria-disabled')).toBe(false);
  });

  it('is neither busy nor disabled by default', () => {
    render(<SegmentedHarness />);
    const group = screen.getByRole('radiogroup');

    expect(group.hasAttribute('aria-busy')).toBe(false);
    expect(group.hasAttribute('aria-disabled')).toBe(false);
  });
});

const sections: TabItem[] = [
  { value: 'general', label: 'Geral', content: <p>Conteúdo geral</p> },
  { value: 'assignment', label: 'Atribuição', count: 3, content: <p>Quem faz o quê</p> },
  { value: 'history', label: 'Histórico', disabled: true, content: <p>Linha do tempo</p> },
  { value: 'files', label: 'Arquivos', icon: <List />, content: <p>Os arquivos</p> }
];

function TabsHarness({ onChange = () => undefined, loading = false, initial = 'general' }: { onChange?: (value: string) => void; loading?: boolean; initial?: string }) {
  const [value, setValue] = useState(initial);
  return <Tabs label="Seções do conteúdo" value={value} items={sections} loading={loading} onChange={(next) => { setValue(next); onChange(next); }} />;
}

const tab = (name: string): HTMLButtonElement => screen.getByRole('tab', { name }) as HTMLButtonElement;
const tabNames = ['Geral', 'Atribuição 3', 'Histórico', 'Arquivos'];

describe('Tabs', () => {
  it('is a named tablist whose tabs are named by their text and count', () => {
    render(<TabsHarness />);
    const list = screen.getByRole('tablist', { name: 'Seções do conteúdo' });

    expect(within(list).getAllByRole('tab').map((item) => item.textContent)).toEqual(['Geral', 'Atribuição3', 'Histórico', 'Arquivos']);
    expect(tab('Atribuição 3')).toBeTruthy();
  });

  it('shows only the open panel, labelled by its tab, and links the tab to it', () => {
    render(<TabsHarness initial="assignment" />);
    const panel = screen.getByRole('tabpanel');

    expect(panel.textContent).toBe('Quem faz o quê');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('Atribuição 3').id);
    expect(tab('Atribuição 3').getAttribute('aria-controls')).toBe(panel.id);
    expect(tab('Geral').hasAttribute('aria-controls')).toBe(false);
    expect(screen.queryByText('Conteúdo geral')).toBeNull();
    expect(tab('Atribuição 3').getAttribute('aria-selected')).toBe('true');
    expect(tab('Geral').getAttribute('aria-selected')).toBe('false');
  });

  it('keeps a single tab stop on the open tab and lets the panel be reached by keyboard', () => {
    render(<TabsHarness />);

    expect(tabNames.map((name) => tab(name).tabIndex)).toEqual([0, -1, -1, -1]);
    expect(screen.getByRole('tabpanel').tabIndex).toBe(0);
  });

  it('opens a tab on click and reports its value', () => {
    const onChange = vi.fn();
    render(<TabsHarness onChange={onChange} />);

    fireEvent.click(tab('Arquivos'));

    expect(onChange).toHaveBeenCalledWith('files');
    expect(screen.getByRole('tabpanel').textContent).toBe('Os arquivos');
  });

  it('moves focus and opens the tab with the horizontal arrows, skipping a disabled tab and wrapping', () => {
    render(<TabsHarness />);

    tab('Geral').focus();
    expect(fireEvent.keyDown(tab('Geral'), { key: 'ArrowRight' })).toBe(false);
    expect(document.activeElement).toBe(tab('Atribuição 3'));
    expect(screen.getByRole('tabpanel').textContent).toBe('Quem faz o quê');

    fireEvent.keyDown(tab('Atribuição 3'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Arquivos'));

    fireEvent.keyDown(tab('Arquivos'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Geral'));

    fireEvent.keyDown(tab('Geral'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab('Arquivos'));
  });

  it('jumps to the first and last tab with Home and End and leaves the vertical arrows alone', () => {
    const onChange = vi.fn();
    render(<TabsHarness initial="assignment" onChange={onChange} />);

    expect(fireEvent.keyDown(tab('Atribuição 3'), { key: 'ArrowDown' })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(tab('Atribuição 3'), { key: 'End' });
    expect(document.activeElement).toBe(tab('Arquivos'));

    fireEvent.keyDown(tab('Arquivos'), { key: 'Home' });
    expect(document.activeElement).toBe(tab('Geral'));
  });

  it('does not open a disabled tab', () => {
    const onChange = vi.fn();
    render(<TabsHarness onChange={onChange} />);

    fireEvent.click(tab('Histórico'));

    expect(tab('Histórico').disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText('Linha do tempo')).toBeNull();
  });

  it('reserves the panel and marks it busy while loading, without rendering its content', () => {
    render(<TabsHarness loading />);
    const panel = screen.getByRole('tabpanel');

    expect(panel.getAttribute('aria-busy')).toBe('true');
    expect(panel.querySelector('.ui-skeleton')).not.toBeNull();
    expect(screen.queryByText('Conteúdo geral')).toBeNull();
  });

  it('gives every tab and panel an id no other instance shares', () => {
    render(<><TabsHarness /><TabsHarness /></>);
    const ids = [...screen.getAllByRole('tab'), ...screen.getAllByRole('tabpanel')].map((element) => element.id);

    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids.every((id) => id !== '')).toBe(true);
    const [firstPanel, secondPanel] = screen.getAllByRole('tabpanel');
    expect(firstPanel!.getAttribute('aria-labelledby')).not.toBe(secondPanel!.getAttribute('aria-labelledby'));
  });

  it('is not busy once loaded', () => {
    render(<TabsHarness />);

    expect(screen.getByRole('tabpanel').hasAttribute('aria-busy')).toBe(false);
    expect(screen.getByRole('tabpanel').querySelector('.ui-skeleton')).toBeNull();
  });

  it('shows no panel when the value matches no tab', () => {
    render(<TabsHarness initial="gone" />);

    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(tabNames.map((name) => tab(name).tabIndex)).toEqual([0, -1, -1, -1]);
  });
  describe('keepMounted', () => {
    const kept: TabItem[] = [
      { value: 'general', label: 'Geral', keepMounted: true, content: <input aria-label="Título" defaultValue="" /> },
      { value: 'assignment', label: 'Atribuição', content: <p>Quem faz o quê</p> }
    ];
    function KeptHarness() {
      const [value, setValue] = useState('general');
      return <Tabs label="Seções" value={value} items={kept} onChange={setValue} />;
    }

    it('keeps what was typed in a panel that was left, hidden, and gives it back', () => {
      render(<KeptHarness />);
      fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Digitado' } });

      fireEvent.click(tab('Atribuição'));
      const left = document.querySelector('input')!;
      expect(left.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.getByRole('tabpanel').textContent).toBe('Quem faz o quê');

      fireEvent.click(tab('Geral'));
      expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('Digitado');
    });

    it('mounts the others only while they are open, and points each tab at the panel it has', () => {
      render(<KeptHarness />);

      expect(screen.queryByText('Quem faz o quê')).toBeNull();
      expect(tab('Atribuição').hasAttribute('aria-controls')).toBe(false);
      expect(tab('Geral').getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id);
      fireEvent.click(tab('Atribuição'));
      expect(tab('Atribuição').getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id);
      expect(tab('Geral').getAttribute('aria-controls')).not.toBe(tab('Atribuição').getAttribute('aria-controls'));
    });

    it('does not mark the hidden panel busy while the open one loads', () => {
      render(<Tabs label="Seções" value="assignment" items={kept} onChange={() => undefined} loading />);
      const [general, assignment] = screen.getAllByRole('tabpanel', { hidden: true });

      expect(general!.hasAttribute('aria-busy')).toBe(false);
      expect(assignment!.getAttribute('aria-busy')).toBe('true');
    });
  });
});
