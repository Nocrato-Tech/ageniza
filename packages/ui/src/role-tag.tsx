import { Crown, ShieldCheck } from 'lucide-react';

import { Pill } from './pill.js';

/** The colour of a role's tag, from the soft colour blocks; `neutral` is the grey of a role with no colour of its own. */
export type RoleTagTone = 'indigo' | 'violet' | 'teal' | 'sky' | 'neutral';

export const OWNER_ROLE_LABEL = 'Dona da agência';

export interface RoleTagProps {
  /** The role's name: the words say the role, the colour only tells roles apart. */
  name: string;
  tone?: RoleTagTone;
  /** The agency's owner: not a role but a property of the agency, so the tag says "Dona da agência" with a crown, in indigo, whatever `name` is. */
  isOwner?: boolean;
  className?: string;
}

/** A person's role in a capsule with its colour and a shield, or the owner's crown. Static: it says, it does not act. */
export function RoleTag({ name, tone = 'neutral', isOwner = false, className }: RoleTagProps) {
  const shown = isOwner ? 'indigo' : tone;
  return (
    <Pill
      icon={isOwner ? <Crown /> : <ShieldCheck />}
      className={['ui-role-tag', shown !== 'neutral' && `ui-role-tag--${shown}`, className].filter(Boolean).join(' ')}
    >
      {isOwner ? OWNER_ROLE_LABEL : name}
    </Pill>
  );
}
