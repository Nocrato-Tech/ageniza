// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button, Popover, type PopoverProps } from './index.js';

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness(props: Partial<PopoverProps>) {
  return (
    <>
      <p>Fora</p>
      <Popover label="Detalhes do post" trigger={(trigger) => <Button {...trigger}>Ver detalhes</Button>} {...props}>
        <p>Legenda completa</p>
        <Button variant="secondary">Abrir post</Button>
      </Popover>
    </>
  );
}

const trigger = (): HTMLButtonElement => screen.getByRole('button', { name: 'Ver detalhes' }) as HTMLButtonElement;
const card = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Detalhes do post' });

// jsdom builds pointer events without `pointerType`, so the tests set it the way a browser reports it.
const enter = (element: HTMLElement, pointerType: string): void => {
  const event = createEvent.pointerOver(element, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(element, event);
};

const leave = (element: HTMLElement, pointerType: string): void => {
  const event = createEvent.pointerOut(element, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(element, event);
};

const rest = (ms: number): void => {
  act(() => { vi.advanceTimersByTime(ms); });
};

describe('Popover on click', () => {
  it('starts closed, with the trigger saying it can open a dialog', () => {
    render(<Harness />);

    expect(card()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger().hasAttribute('aria-controls')).toBe(false);
  });

  it('opens on click, named by its label and linked to its trigger, and closes on the next click', () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    fireEvent.click(trigger());
    expect(card()!.textContent).toContain('Legenda completa');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(card()!.id);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(trigger());
    expect(card()).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it('closes on Esc and gives the focus back to the trigger', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    screen.getByRole('button', { name: 'Abrir post' }).focus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('ignores the other keys', () => {
    render(<Harness />);
    fireEvent.click(trigger());

    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });

    expect(card()).not.toBeNull();
  });

  it('closes on a press outside and stays open on a press inside', () => {
    render(<Harness />);
    fireEvent.click(trigger());

    fireEvent.pointerDown(screen.getByText('Legenda completa'));
    fireEvent.pointerDown(trigger());
    expect(card()).not.toBeNull();

    fireEvent.pointerDown(screen.getByText('Fora'));
    expect(card()).toBeNull();
  });

  it('closes when the focus leaves, and stays open while it moves inside the card', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const inside = screen.getByRole('button', { name: 'Abrir post' });

    fireEvent.blur(trigger(), { relatedTarget: inside });
    expect(card()).not.toBeNull();

    fireEvent.blur(inside, { relatedTarget: screen.getByText('Fora') });
    expect(card()).toBeNull();
  });

  it('stays open when a press on the card text blurs the trigger to nothing', () => {
    render(<Harness />);
    fireEvent.click(trigger());

    fireEvent.blur(trigger(), { relatedTarget: card() });

    expect(card()).not.toBeNull();
    expect(card()!.getAttribute('tabindex')).toBe('-1');
  });

  it('stops listening to the document once it closes', () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    onOpenChange.mockClear();

    fireEvent.pointerDown(screen.getByText('Fora'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('takes a placement and sits on the bottom start by default', () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(trigger());
    expect(card()!.classList.contains('ui-popover--bottom-start')).toBe(true);
    unmount();

    render(<Harness placement="top-end" />);
    fireEvent.click(trigger());
    expect(card()!.classList.contains('ui-popover--top-end')).toBe(true);
  });

  it('reserves the shape of the card and marks it busy while loading', () => {
    render(<Harness loading />);
    fireEvent.click(trigger());

    expect(card()!.getAttribute('aria-busy')).toBe('true');
    expect(card()!.querySelectorAll('.ui-skeleton')).toHaveLength(2);
    expect(screen.queryByText('Legenda completa')).toBeNull();
  });

  it('is not busy once loaded', () => {
    render(<Harness />);
    fireEvent.click(trigger());

    expect(card()!.hasAttribute('aria-busy')).toBe(false);
    expect(card()!.querySelector('.ui-skeleton')).toBeNull();
  });

  it('does not open when disabled, and says so on the trigger', () => {
    const onOpenChange = vi.fn();
    render(<Harness disabled onOpenChange={onOpenChange} />);

    fireEvent.click(trigger());

    expect(card()).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-disabled')).toBe('true');
  });

  it('closes when it becomes disabled while open', () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(trigger());

    rerender(<Harness disabled />);

    expect(card()).toBeNull();
  });
});

describe('Popover on hover', () => {
  it('opens only after the mouse has rested for 300 ms', () => {
    render(<Harness openOn="hover" />);

    enter(trigger(), 'mouse');
    rest(299);
    expect(card()).toBeNull();

    rest(1);
    expect(card()).not.toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('waits as long as hoverDelay says', () => {
    render(<Harness openOn="hover" hoverDelay={800} />);

    enter(trigger(), 'mouse');
    rest(799);
    expect(card()).toBeNull();

    rest(1);
    expect(card()).not.toBeNull();
  });

  it('closes when the mouse leaves, and a pending open never happens', () => {
    render(<Harness openOn="hover" />);

    enter(trigger(), 'mouse');
    rest(200);
    leave(trigger(), 'mouse');
    rest(500);
    expect(card()).toBeNull();

    enter(trigger(), 'mouse');
    rest(300);
    expect(card()).not.toBeNull();
    leave(trigger(), 'mouse');
    rest(150);
    expect(card()).toBeNull();
  });

  it('waits 150 ms after the mouse leaves before it closes, and no longer', () => {
    render(<Harness openOn="hover" />);
    enter(trigger(), 'mouse');
    rest(300);

    leave(trigger(), 'mouse');
    rest(149);
    expect(card()).not.toBeNull();

    rest(1);
    expect(card()).toBeNull();
  });

  it('waits as long as hoverLeaveDelay says', () => {
    render(<Harness openOn="hover" hoverLeaveDelay={400} />);
    enter(trigger(), 'mouse');
    rest(300);

    leave(trigger(), 'mouse');
    rest(399);
    expect(card()).not.toBeNull();

    rest(1);
    expect(card()).toBeNull();
  });

  it('stays open when the mouse crosses the gap from the trigger onto the card, and keeps staying open', () => {
    const onOpenChange = vi.fn();
    render(<Harness openOn="hover" onOpenChange={onOpenChange} />);
    enter(trigger(), 'mouse');
    rest(300);

    leave(trigger(), 'mouse');
    rest(100);
    enter(card()!, 'mouse');
    rest(1000);

    expect(card()).not.toBeNull();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes once the mouse leaves both the trigger and the card', () => {
    render(<Harness openOn="hover" />);
    enter(trigger(), 'mouse');
    rest(300);
    leave(trigger(), 'mouse');
    enter(card()!, 'mouse');

    leave(card()!, 'mouse');
    rest(149);
    expect(card()).not.toBeNull();

    rest(1);
    expect(card()).toBeNull();
  });

  it('lets the mouse go back from the card to the trigger without closing', () => {
    render(<Harness openOn="hover" />);
    enter(trigger(), 'mouse');
    rest(300);
    leave(trigger(), 'mouse');
    enter(card()!, 'mouse');

    leave(card()!, 'mouse');
    rest(100);
    enter(trigger(), 'mouse');
    rest(1000);

    expect(card()).not.toBeNull();
  });

  it('closes on Esc while the mouse is on the card, and gives the focus back', () => {
    render(<Harness openOn="hover" />);
    enter(trigger(), 'mouse');
    rest(300);
    leave(trigger(), 'mouse');
    enter(card()!, 'mouse');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('drops the pending close when it unmounts, so nothing fires afterwards', () => {
    const onOpenChange = vi.fn();
    const { unmount } = render(<Harness openOn="hover" onOpenChange={onOpenChange} />);
    enter(trigger(), 'mouse');
    rest(300);
    leave(trigger(), 'mouse');
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    rest(1000);

    expect(vi.getTimerCount()).toBe(0);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it('keeps one timer however often the mouse goes back and forth', () => {
    render(<Harness openOn="hover" />);
    enter(trigger(), 'mouse');
    rest(300);

    leave(trigger(), 'mouse');
    enter(card()!, 'mouse');
    leave(card()!, 'mouse');
    enter(trigger(), 'mouse');
    leave(trigger(), 'mouse');

    expect(vi.getTimerCount()).toBe(1);
  });

  it('never opens on touch or pen', () => {
    render(<Harness openOn="hover" />);

    enter(trigger(), 'touch');
    enter(trigger(), 'pen');
    rest(1000);

    expect(card()).toBeNull();
  });

  it('opens at once on keyboard focus, and closes when the focus leaves', () => {
    render(<Harness openOn="hover" />);

    act(() => trigger().focus());
    expect(card()).not.toBeNull();

    fireEvent.blur(trigger(), { relatedTarget: screen.getByText('Fora') });
    expect(card()).toBeNull();
  });

  it('does not open on a focus that did not come from the keyboard', () => {
    render(<Harness openOn="hover" />);

    fireEvent.focus(trigger());

    expect(document.activeElement).not.toBe(trigger());
    expect(card()).toBeNull();
  });

  it('leaves the press to the trigger: a click does not open or close it', () => {
    render(<Harness openOn="hover" />);

    fireEvent.click(trigger());
    expect(card()).toBeNull();

    act(() => trigger().focus());
    fireEvent.click(trigger());
    expect(card()).not.toBeNull();
  });

  it('closes on Esc and gives the focus back to the trigger', () => {
    render(<Harness openOn="hover" />);
    enter(trigger(), 'mouse');
    rest(300);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('does not open when disabled, by mouse or by focus', () => {
    render(<Harness openOn="hover" disabled />);

    enter(trigger(), 'mouse');
    rest(1000);
    act(() => trigger().focus());

    expect(card()).toBeNull();
  });

  it('holds one timer however often the mouse comes back, and opens once', () => {
    const onOpenChange = vi.fn();
    render(<Harness openOn="hover" onOpenChange={onOpenChange} />);

    enter(trigger(), 'mouse');
    enter(trigger(), 'mouse');
    enter(trigger(), 'mouse');
    expect(vi.getTimerCount()).toBe(1);

    rest(300);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops the pending open when it unmounts, so nothing fires afterwards', () => {
    const onOpenChange = vi.fn();
    const { unmount } = render(<Harness openOn="hover" onOpenChange={onOpenChange} />);
    enter(trigger(), 'mouse');
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    rest(1000);

    expect(vi.getTimerCount()).toBe(0);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('drops the pending open when it becomes disabled', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<Harness openOn="hover" onOpenChange={onOpenChange} />);
    enter(trigger(), 'mouse');

    rerender(<Harness openOn="hover" disabled onOpenChange={onOpenChange} />);
    rest(1000);

    expect(card()).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('Popover with a fixed strategy', () => {
  const rectOf = (rect: { top: number; left: number; width: number; height: number }): DOMRect => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) });

  const measure = (): void => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'dialog'
        ? rectOf({ top: 0, left: 0, width: 300, height: 200 })
        : rectOf({ top: 400, left: 850, width: 100, height: 60 });
    });
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  };

  afterEach(() => vi.restoreAllMocks());

  it('places the card on the screen, towards the side of its placement, inside the viewport', () => {
    measure();
    render(<Harness openOn="hover" strategy="fixed" placement="top-end" />);
    enter(trigger(), 'mouse');
    rest(300);

    const panel = card()!;
    expect(panel.className).toContain('ui-popover--fixed');
    expect(panel.className).not.toContain('ui-popover--top-end');
    expect(panel.style.visibility).toBe('');
    // Above the anchor (400 - 8 gap - 200 tall), its end edge on the end edge of the anchor (850 + 100 - 300).
    expect(panel.style.top).toBe('192px');
    expect(panel.style.left).toBe('650px');
  });

  it('closes when the page scrolls or resizes, and not when the card itself scrolls', () => {
    measure();
    render(<Harness openOn="click" strategy="fixed" />);
    fireEvent.click(trigger());
    fireEvent.scroll(screen.getByText('Legenda completa'));
    expect(card()).not.toBeNull();

    fireEvent.scroll(document);
    expect(card()).toBeNull();

    fireEvent.click(trigger());
    expect(card()).not.toBeNull();
    fireEvent(window, new Event('resize'));
    expect(card()).toBeNull();
  });

  it('does not listen to the scroll of an absolute card, which moves with its anchor', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.scroll(document);
    expect(card()).not.toBeNull();
  });
});
