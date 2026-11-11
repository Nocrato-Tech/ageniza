// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Button, MilestoneTrail, type MilestoneStep } from './index.js';

afterEach(cleanup);

const steps = (statuses: readonly ('done' | 'current' | 'upcoming')[]): MilestoneStep[] =>
  statuses.map((status, index) => ({
    id: `step-${index}`,
    status,
    title: `Passo ${index + 1}`,
    when: `Feito no dia ${index + 1}`,
    description: `O que falta no passo ${index + 1}`,
    action: <Button size="sm">Resolver {index + 1}</Button>
  }));

const items = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.ui-trail__item')];

describe('MilestoneTrail', () => {
  it('is a list of steps named by the screen, one item per step', () => {
    const { container } = render(<MilestoneTrail aria-label="Primeiros passos" steps={steps(['done', 'current', 'upcoming'])} />);
    const list = screen.getByRole('list', { name: 'Primeiros passos' });

    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(items(container).map((item) => item.dataset.status)).toEqual(['done', 'current', 'upcoming']);
  });

  it('draws done as a filled dot, current as a ring and upcoming as an empty dot, by the class of the status', () => {
    const { container } = render(<MilestoneTrail steps={steps(['done', 'current', 'upcoming'])} />);

    expect(items(container).map((item) => item.className)).toEqual([
      'ui-trail__item ui-trail__item--done',
      'ui-trail__item ui-trail__item--current',
      'ui-trail__item ui-trail__item--upcoming'
    ]);
    for (const item of items(container)) {
      expect(item.querySelector('.ui-trail__node .ui-trail__check path')).not.toBeNull();
      expect(item.querySelector('.ui-trail__line')).not.toBeNull();
    }
  });

  it('marks only the current step as the step the person is on', () => {
    const { container } = render(<MilestoneTrail steps={steps(['done', 'current', 'upcoming'])} />);

    expect(items(container).map((item) => item.getAttribute('aria-current'))).toEqual([null, 'step', null]);
  });

  it('says the status in words, since the dot is only a picture, and keeps the picture out of the accessibility tree', () => {
    const { container } = render(<MilestoneTrail steps={steps(['done', 'current', 'upcoming'])} />);

    expect(items(container).map((item) => item.querySelector('.ui-trail__title')!.textContent)).toEqual([
      'Feito: Passo 1',
      'Passo atual: Passo 2',
      'Próximo passo: Passo 3'
    ]);
    for (const rail of container.querySelectorAll('.ui-trail__rail')) expect(rail.getAttribute('aria-hidden')).toBe('true');
  });

  it('lets the screen say the words of the status in its own language', () => {
    const { container } = render(<MilestoneTrail steps={steps(['done'])} statusLabels={{ done: 'Done', current: 'Current', upcoming: 'Next' }} />);

    expect(container.querySelector('.ui-trail__title')!.textContent).toBe('Done: Passo 1');
  });

  it('shows when it happened only on a done step, what it asks only on the others, and the action only on the current one', () => {
    render(<MilestoneTrail steps={steps(['done', 'current', 'upcoming'])} />);

    expect(screen.getByText('Feito no dia 1')).toBeTruthy();
    expect(screen.queryByText('Feito no dia 2')).toBeNull();
    expect(screen.queryByText('Feito no dia 3')).toBeNull();
    expect(screen.queryByText('O que falta no passo 1')).toBeNull();
    expect(screen.getByText('O que falta no passo 2')).toBeTruthy();
    expect(screen.getByText('O que falta no passo 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resolver 1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Resolver 2' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resolver 3' })).toBeNull();
  });

  it('keeps the same elements when a step is reached, so the fill, the check and the line play as transitions', () => {
    const { container, rerender } = render(<MilestoneTrail steps={steps(['current', 'upcoming', 'upcoming'])} />);
    const before = items(container);
    const nodes = before.map((item) => item.querySelector('.ui-trail__node'));

    rerender(<MilestoneTrail steps={steps(['done', 'current', 'upcoming'])} />);

    const after = items(container);
    expect(after).toEqual(before);
    expect(after.map((item) => item.querySelector('.ui-trail__node'))).toEqual(nodes);
    expect(after.map((item) => item.dataset.status)).toEqual(['done', 'current', 'upcoming']);
    expect(after[0]!.className).toContain('ui-trail__item--done');
    expect(after[1]!.getAttribute('aria-current')).toBe('step');
    expect(after[0]!.getAttribute('aria-current')).toBeNull();
  });

  it('shows the last step done with no current one when the trail is complete', () => {
    const { container } = render(<MilestoneTrail steps={steps(['done', 'done', 'done'])} />);

    expect(items(container).every((item) => item.dataset.status === 'done')).toBe(true);
    expect(container.querySelector('[aria-current]')).toBeNull();
  });

  it('draws the small trail and keeps the class of the screen', () => {
    const { container } = render(<MilestoneTrail size="sm" className="activation" steps={steps(['current'])} />);

    expect(container.querySelector('ol')!.className).toBe('ui-trail ui-trail--sm activation');
  });
});
