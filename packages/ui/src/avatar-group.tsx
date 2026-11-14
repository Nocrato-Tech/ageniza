import type { HTMLAttributes } from 'react';

import { Avatar, type AvatarTone } from './avatar.js';

export interface AvatarGroupPerson {
  name: string;
  photoUrl?: string | null;
  /** Overrides the tone the stack gives by position. */
  tone?: AvatarTone;
}

export type AvatarGroupProps = Omit<HTMLAttributes<HTMLSpanElement>, 'role'> & {
  people: readonly AvatarGroupPerson[];
  /** How many avatars show before the "+N" (default 3). */
  max?: number;
  size?: 'sm' | 'md';
  /** What the people are ("Responsáveis"); it opens the name read by assistive technology. */
  label?: string;
};

const TONES: readonly AvatarTone[] = ['indigo', 'violet', 'teal', 'sky'];

/** A stack of avatars with a "+N" for the rest. The stack is one image to assistive technology, named by everyone in it, so the overflow never hides a name. */
export function AvatarGroup({ people, max = 3, size = 'sm', label, className, ...props }: AvatarGroupProps) {
  const shown = people.slice(0, Math.max(0, max));
  const rest = people.length - shown.length;
  const names = people.map((person) => person.name).join(', ');
  return (
    <span
      role="img"
      aria-label={label === undefined ? names : `${label}: ${names}`}
      className={['ui-avatar-group', `ui-avatar-group--${size}`, className].filter(Boolean).join(' ')}
      {...props}
    >
      {shown.map((person, index) => (
        <Avatar key={`${index}-${person.name}`} name={person.name} photoUrl={person.photoUrl} size={size} tone={person.tone ?? TONES[index % TONES.length]!} />
      ))}
      {rest > 0 && <span className="ui-avatar-group__more" aria-hidden="true">+{rest}</span>}
    </span>
  );
}
