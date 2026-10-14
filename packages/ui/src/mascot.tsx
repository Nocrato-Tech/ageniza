import type { ImgHTMLAttributes } from 'react';

/** The two owl poses of the brand (docs/brand.md): the friendly one for empty states, the serious one for errors. */
export type MascotVariant = 'friendly' | 'serious';

/** Natural size of each file at 1x (480 px tall; the @2x file is twice that), so the box is reserved before the image loads. */
const MASCOTS: Readonly<Record<MascotVariant, { file: string; ratio: number }>> = {
  friendly: { file: 'mascote-amigavel', ratio: 337 / 480 },
  serious: { file: 'mascote-serio', ratio: 382 / 480 }
};

export type MascotProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'width' | 'height'> & {
  variant: MascotVariant;
  /** Displayed height in CSS px; the width follows the pose. */
  height?: number;
};

/**
 * The mascot, from `/brand` (apps/web/public): WebP with a 2x `srcset` and its own width and height, so nothing jumps when it
 * loads. It is decorative by default (`alt=""`): the title next to it says it all, and docs/brand.md allows one per screen.
 */
export function Mascot({ variant, height = 240, alt = '', className, ...props }: MascotProps) {
  const { file, ratio } = MASCOTS[variant];
  return (
    <img
      className={['ui-mascot', className].filter(Boolean).join(' ')}
      src={`/brand/${file}.webp`}
      srcSet={`/brand/${file}.webp 1x, /brand/${file}@2x.webp 2x`}
      width={Math.round(height * ratio)}
      height={height}
      alt={alt}
      {...props}
    />
  );
}
