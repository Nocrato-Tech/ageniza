import { UserMinus } from 'lucide-react';

import { Avatar } from './avatar.js';
import { IconSlot } from './icon.js';
import { RoleTag, type RoleTagTone } from './role-tag.js';

export type BadgeRoleTone = RoleTagTone;

export interface BadgeCardProps {
  name: string;
  photoUrl?: string | null;
  /** Free text, so it can be long: the card wraps it instead of widening its grid track. */
  jobTitle?: string | null;
  role: string;
  /** The colour of the role's capsule, from the colour blocks; `neutral` when the role has none. The words say the role: the colour only helps. */
  roleTone?: BadgeRoleTone;
  /** The agency's owner: not a role but a property of the agency, so the capsule says "Dona da agência" with a crown, in indigo, whatever `role` is. */
  isOwner?: boolean;
  /** A removed membership still shows the person; the badge itself says the link ended (#105). */
  removed?: boolean;
}

/**
 * The team badge (specs/colaboradores.md §7): exactly four pieces of information — photo or
 * initials, name, job title and role — plus the removed marker, which is not a fifth field but the
 * absence of the link. Adding a fifth data field turns the badge into a table, which the SPEC
 * explicitly rejects. The role is a `RoleTag`, so it reads as access and not as
 * one more line of text.
 */
export function BadgeCard({ name, photoUrl, jobTitle, role, roleTone = 'neutral', isOwner = false, removed = false }: BadgeCardProps) {
  return (
    <article className="ui-badge-card">
      <div className="ui-badge-card__cover">
        <Avatar name={name} photoUrl={photoUrl} size="lg" />
      </div>
      <div className="ui-badge-card__body">
        <p className="ui-badge-card__name">{name}</p>
        {jobTitle !== null && jobTitle !== undefined && jobTitle !== '' && <p className="ui-badge-card__job">{jobTitle}</p>}
        <p className="ui-badge-card__role"><RoleTag name={role} tone={roleTone} isOwner={isOwner} /></p>
        {removed && <p className="ui-badge-card__removed"><IconSlot><UserMinus /></IconSlot>removido</p>}
      </div>
    </article>
  );
}
