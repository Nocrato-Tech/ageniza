import { ShieldCheck, UserMinus } from 'lucide-react';

import { Avatar } from './avatar.js';
import { IconSlot } from './icon.js';
import { Pill } from './pill.js';

export interface BadgeCardProps {
  name: string;
  photoUrl?: string | null;
  /** Free text, so it can be long: the card wraps it instead of widening its grid track. */
  jobTitle?: string | null;
  role: string;
  /** A removed membership still shows the person; the badge itself says the link ended (#105). */
  removed?: boolean;
}

/**
 * The team badge (specs/colaboradores.md §7): exactly four pieces of information — photo or
 * initials, name, job title and role — plus the removed marker, which is not a fifth field but the
 * absence of the link. Adding a fifth data field turns the badge into a table, which the SPEC
 * explicitly rejects. The role is a neutral `Pill` with its icon, so it reads as access and not as
 * one more line of text.
 */
export function BadgeCard({ name, photoUrl, jobTitle, role, removed = false }: BadgeCardProps) {
  return (
    <article className="ui-badge-card">
      <div className="ui-badge-card__cover">
        <Avatar name={name} photoUrl={photoUrl} size="lg" />
      </div>
      <div className="ui-badge-card__body">
        <p className="ui-badge-card__name">{name}</p>
        {jobTitle !== null && jobTitle !== undefined && jobTitle !== '' && <p className="ui-badge-card__job">{jobTitle}</p>}
        <p className="ui-badge-card__role"><Pill icon={<ShieldCheck />}>{role}</Pill></p>
        {removed && <p className="ui-badge-card__removed"><IconSlot><UserMinus /></IconSlot>removido</p>}
      </div>
    </article>
  );
}
