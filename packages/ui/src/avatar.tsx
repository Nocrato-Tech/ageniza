import { type HTMLAttributes } from 'react';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** The person's name; the initials are taken from it when there is no photo. */
  name: string;
  /** Signed photo URL, or null when the person has no photo. */
  photoUrl?: string | null;
  size?: AvatarSize;
}

/**
 * First letter of the first and last word, uppercased; a single word gives one letter. Uses
 * `Array.from` so a name starting with a surrogate pair (an emoji, an accented letter outside the
 * BMP) is not cut in half.
 */
export const avatarInitials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  const first = words.length === 0 ? '' : Array.from(words[0]!)[0] ?? '';
  const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0] ?? '' : '';
  return (first + last).toUpperCase();
};

/**
 * A person's photo, or their initials when there is none (never a generic person icon, which does
 * not distinguish anyone). The avatar is decorative: the name is always shown next to it, so the
 * image is `alt=""` and the initials are hidden from assistive technology.
 */
export function Avatar({ name, photoUrl, size = 'md', className, ...props }: AvatarProps) {
  return (
    <span className={['ui-avatar', `ui-avatar--${size}`, className].filter(Boolean).join(' ')} {...props}>
      {photoUrl === null || photoUrl === undefined
        ? <span className="ui-avatar__initials" aria-hidden="true">{avatarInitials(name)}</span>
        : <img className="ui-avatar__photo" src={photoUrl} alt="" />}
    </span>
  );
}
