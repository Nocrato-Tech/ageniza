import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STYLES = __dirname;

/** A stylesheet of the app with comments removed and line endings normalised, so a CRLF checkout reads the same. */
export const readStyles = (file: string): string =>
  readFileSync(join(STYLES, file), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

const customProperties = (css: string, selector: string): Map<string, string> => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const));
};

const light = new Map([
  ...customProperties(readStyles('tokens/primitives.css'), ':root'),
  ...customProperties(readStyles('tokens/semantic.css'), ":root,\n[data-theme='light']")
]);
const dark = new Map([...light, ...customProperties(readStyles('themes/dark.css'), "[data-theme='dark']")]);

export const themes = { light, dark } as const;

type Rgb = [number, number, number];

const resolve = (value: string, tokens: Map<string, string>): Rgb => {
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) {
    const target = tokens.get(ref[1]!);
    if (target === undefined) throw new Error(`unknown ${ref[1]}`);
    return resolve(target, tokens);
  }
  const mix = /^color-mix\(in srgb, (.+) (\d+)%, (.+)\)$/.exec(value);
  if (mix) {
    const [a, b] = [resolve(mix[1]!, tokens), resolve(mix[3]!, tokens)];
    const share = Number(mix[2]) / 100;
    return a.map((v, i) => v * share + b[i]! * (1 - share)) as Rgb;
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as Rgb;
  throw new Error(`cannot resolve ${value}`);
};

const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((v) => {
    const c = Math.round(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The sRGB channels of a token reference such as `var(--border-control)`, in the given theme. */
export const rgbOf = (value: string, theme: keyof typeof themes): number[] => resolve(value, themes[theme]);

/** WCAG contrast of two token references such as `var(--text-secondary)`, in the given theme. */
export const contrastOf = (theme: keyof typeof themes, fg: string, bg: string): number => {
  const [x, y] = [luminance(resolve(fg, themes[theme])), luminance(resolve(bg, themes[theme]))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The declarations of every rule whose selector list names exactly `selector`, later rules winning. Comments are ignored, so one above a rule never sticks to its first selector. */
export const declarationsFor = (css: string, selector: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = block[1]!.split(',').map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    for (const declaration of block[2]!.matchAll(/([\w-]+):\s*([^;]+);/g)) found.set(declaration[1]!, declaration[2]!.trim());
  }
  return found;
};
