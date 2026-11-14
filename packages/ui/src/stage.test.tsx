// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Stage3D } from './index.js';

const SRC = '/3d/rocket.png';

const setMedia = (media: { hover: boolean; reduced: boolean }): void => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('hover: hover') ? media.hover : query.includes('prefers-reduced-motion') ? media.reduced : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })) as unknown as typeof window.matchMedia;
};

afterEach(cleanup);

/** jsdom has no PointerEvent: a mouse event with the pointer's name carries the same coordinates. */
const move = (target: HTMLElement, clientX: number, clientY: number): void => {
  target.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY, bubbles: true }));
};

const renderOnCard = (props: Partial<Parameters<typeof Stage3D>[0]> = {}) => {
  const view = render(<div data-testid="card" data-stage-host><Stage3D src={SRC} {...props} /></div>);
  const card = view.getByTestId('card');
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  return { card, stage: view.container.querySelector<HTMLElement>('.ui-stage')! };
};

describe('Stage3D', () => {
  it('is decorative: hidden from assistive technology, with an empty alt and no name of its own', () => {
    setMedia({ hover: true, reduced: false });
    const { stage } = renderOnCard();
    const image = stage.querySelector('img')!;

    expect(stage.getAttribute('aria-hidden')).toBe('true');
    expect(image.getAttribute('alt')).toBe('');
    expect(image.getAttribute('src')).toBe(SRC);
    expect(image.getAttribute('draggable')).toBe('false');
  });

  it('cannot be made visible to assistive technology by a prop', () => {
    setMedia({ hover: true, reduced: false });
    const { container } = render(<Stage3D src={SRC} aria-hidden={false} />);

    expect(container.querySelector('.ui-stage')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is large and neutral by default, and wears the size, the tone and the breakout it is given', () => {
    setMedia({ hover: true, reduced: false });
    const plain = render(<Stage3D src={SRC} />).container.querySelector('.ui-stage')!;
    expect(plain.className).toBe('ui-stage ui-stage--lg ui-stage--slate');

    cleanup();
    const full = render(<Stage3D src={SRC} size="xl" tone="violet" breakout className="mine" />).container.querySelector('.ui-stage')!;
    expect(full.className).toBe('ui-stage ui-stage--xl ui-stage--violet ui-stage--breakout mine');
  });

  it('leans toward the pointer while it is over its card, and straightens when the pointer leaves', () => {
    setMedia({ hover: true, reduced: false });
    const { card, stage } = renderOnCard();

    move(card, 200, 0);
    expect(stage.style.getPropertyValue('--ry')).toBe('13deg');
    expect(stage.style.getPropertyValue('--rx')).toBe('11deg');

    move(card, 0, 100);
    expect(stage.style.getPropertyValue('--ry')).toBe('-13deg');
    expect(stage.style.getPropertyValue('--rx')).toBe('-11deg');

    card.dispatchEvent(new Event('pointerleave'));
    expect(stage.style.getPropertyValue('--ry')).toBe('0deg');
    expect(stage.style.getPropertyValue('--rx')).toBe('0deg');
  });

  it('follows the parent when no card is named', () => {
    setMedia({ hover: true, reduced: false });
    const view = render(<section data-testid="parent"><Stage3D src={SRC} /></section>);
    const parent = view.getByTestId('parent');
    parent.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });

    move(parent, 100, 50);

    expect(view.container.querySelector<HTMLElement>('.ui-stage')!.style.getPropertyValue('--ry')).toBe('13deg');
  });

  it('follows the card named by an ancestor, not the wrapper the stage sits in', () => {
    setMedia({ hover: true, reduced: false });
    const view = render(
      <div data-testid="card" data-stage-host>
        <div data-testid="wrapper"><Stage3D src={SRC} /></div>
      </div>
    );
    const card = view.getByTestId('card');
    const wrapper = view.getByTestId('wrapper');
    card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, width: 20, height: 10, right: 20, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    const stage = view.container.querySelector<HTMLElement>('.ui-stage')!;

    move(wrapper, 200, 0);
    expect(stage.style.getPropertyValue('--ry'), 'the card box (200 wide) rules, not the wrapper (20 wide)').toBe('13deg');

    move(card, 0, 100);
    expect(stage.style.getPropertyValue('--ry')).toBe('-13deg');
  });

  it('stays still without a hovering pointer: a touch screen never leans', () => {
    setMedia({ hover: false, reduced: false });
    const { card, stage } = renderOnCard();

    move(card, 200, 0);

    expect(stage.style.getPropertyValue('--ry')).toBe('');
    expect(stage.style.getPropertyValue('--rx')).toBe('');
  });

  it('stays still for people who ask for less motion, even with a mouse', () => {
    setMedia({ hover: true, reduced: true });
    const { card, stage } = renderOnCard();

    move(card, 200, 0);

    expect(stage.style.getPropertyValue('--ry')).toBe('');
  });

  it('stays still when the browser cannot tell what the pointer does', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    const { card, stage } = renderOnCard();

    move(card, 200, 0);

    expect(stage.style.getPropertyValue('--ry')).toBe('');
  });

  it('lets go of the card when it unmounts', () => {
    setMedia({ hover: true, reduced: false });
    const view = render(<div data-testid="card" data-stage-host><Stage3D src={SRC} /></div>);
    const card = view.getByTestId('card');
    card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    const stage = view.container.querySelector<HTMLElement>('.ui-stage')!;

    view.rerender(<div data-testid="card" data-stage-host />);
    move(card, 200, 0);

    expect(stage.style.getPropertyValue('--ry')).toBe('0deg');
  });
});
