// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Avatar, FormatTag, LateBadge, Realce, StatusTag, type FormatTagFormat, type StatusTagStatus } from './index.js';

afterEach(cleanup);

/** None of these is a control: nothing to tab to, press or announce as one. */
const expectStatic = (element: HTMLElement): void => {
  expect(element.getAttribute('tabindex')).toBeNull();
  expect(element.getAttribute('role')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
};

describe('FormatTag', () => {
  it.each<[FormatTagFormat, string]>([
    ['carousel', 'Carrossel'],
    ['reels', 'Reels'],
    ['static', 'Estático']
  ])('names the %s format with its own words and its own fill class', (format, label) => {
    render(<FormatTag format={format}>{label}</FormatTag>);
    const tag = screen.getByText(label);

    expect(tag.className).toBe(`ui-format-tag ui-format-tag--${format}`);
    expectStatic(tag);
  });

  it('keeps the other props of a span, so a screen can label or find it', () => {
    render(<FormatTag format="reels" className="card__tag" data-testid="tag" aria-label="Formato: Reels">Reels</FormatTag>);
    const tag = screen.getByTestId('tag');

    expect(tag.className).toBe('ui-format-tag ui-format-tag--reels card__tag');
    expect(tag.getAttribute('aria-label')).toBe('Formato: Reels');
  });
});

describe('StatusTag', () => {
  it.each<[StatusTagStatus, string, string]>([
    ['ready', 'Pronto para publicar', 'lucide-check'],
    ['waiting', 'Aguardando', 'lucide-clock'],
    ['adjust', 'Em ajuste', 'lucide-pencil'],
    ['published', 'Publicado', 'lucide-check-check'],
    ['production', 'Em produção', 'lucide-circle']
  ])('says %s in words and in the form of its own icon', (status, label, shape) => {
    render(<StatusTag status={status}>{label}</StatusTag>);
    const tag = screen.getByText(label);
    const icon = tag.querySelector('.ui-icon');

    expect(tag.className).toBe(`ui-status-tag ui-status-tag--${status}`);
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelector('svg')?.getAttribute('class')?.split(' ')).toContain(shape);
    expectStatic(tag);
  });

  it('never tells two states apart by colour alone: every state has a different shape', () => {
    const statuses: StatusTagStatus[] = ['ready', 'waiting', 'adjust', 'published', 'production'];
    const shapes = statuses.map((status) => {
      const { container, unmount } = render(<StatusTag status={status}>x</StatusTag>);
      const shape = container.querySelector('svg')!.getAttribute('class')!.split(' ').find((name) => name.startsWith('lucide-') && name !== 'lucide');
      unmount();
      return shape;
    });

    expect(new Set(shapes).size).toBe(5);
  });

  it('exposes the label alone as its text, since the icon is decorative', () => {
    render(<StatusTag status="adjust">Em ajuste</StatusTag>);

    expect(screen.getByText('Em ajuste').textContent).toBe('Em ajuste');
  });
});

describe('LateBadge', () => {
  it('says "Atrasado" by default', () => {
    render(<LateBadge />);

    expect(screen.getByText('Atrasado').className).toBe('ui-late-badge');
    expectStatic(screen.getByText('Atrasado'));
  });

  it('takes another wording when the screen has one', () => {
    render(<LateBadge>2 dias de atraso</LateBadge>);

    expect(screen.getByText('2 dias de atraso').className).toBe('ui-late-badge');
    expect(screen.queryByText('Atrasado')).toBeNull();
  });
});

describe('Avatar attention ring', () => {
  it('draws no ring and says nothing extra when nothing asks for action', () => {
    const { container } = render(<Avatar name="Padaria Central" />);

    expect(container.querySelector('.ui-avatar--attention')).toBeNull();
    expect(container.querySelector('.ui-avatar__attention')).toBeNull();
    expect(container.textContent).toBe('PC');
  });

  it('draws the ring and says why, so the ring is never the only signal', () => {
    const { container } = render(<Avatar name="Padaria Central" attention="em ajuste, em atraso" />);
    const avatar = container.querySelector('.ui-avatar')!;

    expect(avatar.classList.contains('ui-avatar--attention')).toBe(true);
    expect(screen.getByText('em ajuste, em atraso').className).toBe('ui-avatar__attention');
    expect(avatar.querySelector('.ui-avatar__initials')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the photo decorative when it has a ring', () => {
    const { container } = render(<Avatar name="Padaria Central" photoUrl="https://example.test/p.png" attention="em atraso" />);

    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(container.querySelector('.ui-avatar--attention')).not.toBeNull();
  });

  it('keeps the size and the extra class next to the ring', () => {
    const { container } = render(<Avatar name="Ana" size="lg" className="strip__avatar" attention="em atraso" />);

    expect(container.querySelector('.ui-avatar')?.className).toBe('ui-avatar ui-avatar--lg ui-avatar--attention strip__avatar');
  });
});

describe('Realce', () => {
  it('wraps the word that asks for a decision', () => {
    render(<p>Você tem <Realce>2 posts</Realce> esperando</p>);
    const realce = screen.getByText('2 posts');

    expect(realce.className).toBe('ui-realce');
    expect(realce.tagName).toBe('SPAN');
    expectStatic(realce);
  });

  it('sweeps in only when asked', () => {
    render(<><Realce>parado</Realce><Realce sweep>varrido</Realce></>);

    expect(screen.getByText('parado').className).toBe('ui-realce');
    expect(screen.getByText('varrido').className).toBe('ui-realce ui-realce--sweep');
  });

  it('keeps the props of a span', () => {
    render(<Realce className="today" data-testid="today">13</Realce>);

    expect(screen.getByTestId('today').className).toBe('ui-realce today');
  });
});
