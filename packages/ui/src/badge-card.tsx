import { Avatar } from './avatar.js';

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
 * explicitly rejects.
 */
export function BadgeCard({ name, photoUrl, jobTitle, role, removed = false }: BadgeCardProps) {
  return (
    <article className="ui-badge-card">
      <Avatar name={name} photoUrl={photoUrl} size="lg" />
      <p className="ui-badge-card__name">{name}</p>
      {jobTitle !== null && jobTitle !== undefined && jobTitle !== '' && <p className="ui-badge-card__job">{jobTitle}</p>}
      <p className="ui-badge-card__role">{role}</p>
      {removed && <p className="ui-badge-card__removed">removido</p>}
    </article>
  );
}
