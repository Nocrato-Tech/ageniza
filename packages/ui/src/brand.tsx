import { type ImgHTMLAttributes } from 'react';

export type LogoVariant = 'on-light' | 'on-dark' | 'mono-ink' | 'mono-white';
export type BrandSymbolVariant = 'color' | 'ink' | 'white';

const LOGO_FILES: Record<LogoVariant, string> = {
  'on-light': 'logo-para-fundo-claro.svg',
  'on-dark': 'logo-para-fundo-escuro.svg',
  'mono-ink': 'logo-mono-ink.svg',
  'mono-white': 'logo-mono-branco.svg'
};

const SYMBOL_FILES: Record<BrandSymbolVariant, string> = {
  color: 'simbolo-colorido.svg',
  ink: 'simbolo-ink.svg',
  white: 'simbolo-branco.svg'
};

// The artboard of the exported logo (apps/web/public/brand), so the box is reserved before the SVG loads.
const LOGO_RATIO = 989 / 200;

type BrandImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'width' | 'height'>;

export interface LogoProps extends BrandImageProps {
  /** `on-light`/`on-dark` name the background the full-colour logo goes on; `mono-*` are the one-colour prints. */
  variant?: LogoVariant;
  /** Height in px; the width follows the logo's proportion. */
  height?: number;
}

/** The full logo, named "Ageniza" for assistive technology (docs/brand.md). */
export function Logo({ variant = 'on-light', height = 40, className, ...props }: LogoProps) {
  return (
    <img
      className={['ui-logo', className].filter(Boolean).join(' ')}
      src={`/brand/${LOGO_FILES[variant]}`}
      alt="Ageniza"
      width={Math.round(height * LOGO_RATIO)}
      height={height}
      {...props}
    />
  );
}

export interface BrandSymbolProps extends BrandImageProps {
  /** `ink` for light backgrounds and `white` for dark ones; `color` is for 48 px or more (docs/brand.md). */
  variant?: BrandSymbolVariant;
  /** Side in px. */
  size?: number;
  /** Accessible name. Leave it out when the name "Ageniza" is next to the symbol: the image is then decorative. */
  label?: string;
}

/** The owl mark. Decorative (`alt=""`) unless a `label` names it. */
export function BrandSymbol({ variant = 'ink', size = 32, label, className, ...props }: BrandSymbolProps) {
  return (
    <img
      className={['ui-symbol', className].filter(Boolean).join(' ')}
      src={`/brand/${SYMBOL_FILES[variant]}`}
      alt={label ?? ''}
      width={size}
      height={size}
      {...props}
    />
  );
}
