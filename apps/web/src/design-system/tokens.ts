import primitivesCss from '../styles/tokens/primitives.css?raw';
import semanticCss from '../styles/tokens/semantic.css?raw';
import typographyCss from '../styles/tokens/typography.css?raw';
import motionCss from '../styles/tokens/motion.css?raw';
import darkCss from '../styles/themes/dark.css?raw';

export interface Token {
  readonly name: string;
  readonly value: string;
}

/** Every `--name: value;` declaration of a stylesheet, in file order; the page shows what the CSS says, never a copy. */
export const parseTokens = (css: string): Token[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => ({ name: match[1]!, value: match[2]!.trim() }));

export const groupTokens = (tokens: readonly Token[], keyOf: (token: Token) => string): Array<{ key: string; tokens: Token[] }> => {
  const groups = new Map<string, Token[]>();
  for (const token of tokens) groups.set(keyOf(token), [...(groups.get(keyOf(token)) ?? []), token]);
  return [...groups].map(([key, grouped]) => ({ key, tokens: grouped }));
};

const primitives = parseTokens(primitivesCss);
const semantic = parseTokens(semanticCss);
const typography = parseTokens(typographyCss);

const startsWith = (prefix: string) => (token: Token) => token.name.startsWith(prefix);

export const designTokens = {
  colors: primitives.filter(startsWith('--color-')),
  spacing: primitives.filter(startsWith('--space-')),
  radius: primitives.filter(startsWith('--radius-')),
  semantic: semantic.filter((token) => !token.name.startsWith('--shadow-')),
  darkOverrides: new Set(parseTokens(darkCss).map((token) => token.name)),
  fonts: typography.filter(startsWith('--font-')),
  typeScale: typography.filter((token) => !token.name.startsWith('--font-')),
  motion: parseTokens(motionCss),
  elevation: semantic.filter(startsWith('--shadow-'))
};

/** The family of a colour primitive: `--color-indigo-600` belongs to `indigo`. */
export const colorFamily = (token: Token): string => token.name.slice('--color-'.length).split('-')[0]!;

/** The group of a semantic token: `--text-muted` belongs to `text`. */
export const semanticGroup = (token: Token): string => token.name.slice(2).split('-')[0]!;
