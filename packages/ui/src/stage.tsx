import { useEffect, useRef, type HTMLAttributes } from 'react';

/** The size of the icon: the disc, the contact shadow and the box all come from it (`--stage-size-*`). */
export type Stage3DSize = 'sm' | 'md' | 'lg' | 'xl';

/** The family of the card the icon sits on: it sets the tone of the disc. `slate` is the neutral one. */
export type Stage3DTone = 'indigo' | 'violet' | 'teal' | 'sky' | 'red' | 'slate';

export type Stage3DProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  /** The 3dicons "color" render (CC0), served as it comes: never painted over. */
  src: string;
  size?: Stage3DSize;
  tone?: Stage3DTone;
  /** The icon leaves the card through its top edge. Only from `md` up, and the card must not clip it. */
  breakout?: boolean;
};

const TILT_MAX_Y = 26;
const TILT_MAX_X = 22;

/** Following the pointer needs a pointer that hovers and a person who did not ask for less motion. */
const canTilt = (): boolean => {
  try {
    return window.matchMedia('(hover: hover)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/**
 * A 3D icon on its stage: the render sits on a disc in the tone of the card, with a contact shadow, and floats a little.
 * It is decorative (`aria-hidden`, empty alt): the title beside it says everything. With a hovering pointer it leans
 * toward the pointer while it is over the card (`[data-stage-host]`, or the parent); otherwise it stays still.
 */
export function Stage3D({ src, size = 'lg', tone = 'slate', breakout = false, className, ...props }: Stage3DProps) {
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const stage = root.current;
    if (stage === null || !canTilt()) return undefined;
    const host = stage.closest<HTMLElement>('[data-stage-host]') ?? stage.parentElement ?? stage;
    const rest = (): void => {
      stage.style.setProperty('--rx', '0deg');
      stage.style.setProperty('--ry', '0deg');
    };
    const follow = (event: PointerEvent): void => {
      const box = host.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      stage.style.setProperty('--ry', `${((event.clientX - box.left) / box.width - 0.5) * TILT_MAX_Y}deg`);
      stage.style.setProperty('--rx', `${(0.5 - (event.clientY - box.top) / box.height) * TILT_MAX_X}deg`);
    };
    host.addEventListener('pointermove', follow);
    host.addEventListener('pointerleave', rest);
    return () => {
      host.removeEventListener('pointermove', follow);
      host.removeEventListener('pointerleave', rest);
      rest();
    };
  }, []);

  return (
    <span
      ref={root}
      className={['ui-stage', `ui-stage--${size}`, `ui-stage--${tone}`, breakout && 'ui-stage--breakout', className].filter(Boolean).join(' ')}
      {...props}
      aria-hidden="true"
    >
      <span className="ui-stage__float">
        <img className="ui-stage__icon" src={src} alt="" draggable={false} />
      </span>
    </span>
  );
}
