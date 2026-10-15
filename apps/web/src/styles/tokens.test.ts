import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STYLES = __dirname;
const FONTS = join(STYLES, '..', '..', 'node_modules', '@fontsource-variable');
const read = (file: string) => readFileSync(join(STYLES, file), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

const declarations = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const));
};

const primitives = declarations(read('tokens/primitives.css'), ':root');
const darkOverrides = declarations(read('themes/dark.css'), "[data-theme='dark']");
const light = new Map([...primitives, ...declarations(read('tokens/semantic.css'), ":root,\n[data-theme='light']")]);
const dark = new Map([...light, ...darkOverrides]);
const themes = { light, dark } as const;

type Rgb = [number, number, number];

const channels = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

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
  if (/^#[0-9a-f]{6}$/i.test(value)) return channels(value);
  throw new Error(`cannot resolve ${value}`);
};

const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = Math.round(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const contrast = (theme: keyof typeof themes, fg: string, bg: string) =>
  ratio(resolve(`var(--${fg})`, themes[theme]), resolve(`var(--${bg})`, themes[theme]));

const themed = (names: Iterable<string>) => [...names].filter((name) => /^--(status|format)-/.test(name)).sort();

const themedValues = (tokens: Map<string, string>) => Object.fromEntries(themed(tokens.keys()).map((name) => [name, tokens.get(name)]));

const fontFaces = (css: string) =>
  [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((face) => {
    const property = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(face[1]!)?.[1]?.trim();
    return {
      family: property('font-family')?.replace(/'/g, ''),
      stretch: property('font-stretch'),
      weight: property('font-weight'),
      src: property('src')
    };
  });

describe('Pauta tokens', () => {
  it('keeps hex colours in primitives.css only, with violet/400 and teal/700 as the only new primitives', () => {
    const offenders = ['globals.css', 'tokens/semantic.css', 'tokens/typography.css', 'tokens/motion.css', 'tokens/fonts.css', 'themes/dark.css', 'themes/light.css'].filter(
      (file) => /#[0-9a-f]{3,8}\b/i.test(read(file))
    );
    expect(offenders).toEqual([]);
    expect(primitives.get('--color-violet-400')).toBe('#a78bfa');
    expect(primitives.get('--color-teal-700')).toBe('#0f766e');
    expect([...primitives.keys()].filter((name) => name.startsWith('--color-')).sort()).toEqual(
      [
        'ink-900', 'ink-800', 'ink-700', 'ink-600', 'indigo-600', 'indigo-550', 'indigo-400', 'violet-600', 'violet-400', 'teal-500', 'teal-700',
        'slate-600', 'slate-500', 'slate-400', 'slate-300', 'mist-200', 'mist-100', 'cloud-50', 'white', 'red-700', 'red-400'
      ]
        .map((name) => `--color-${name}`)
        .sort()
    );
  });

  it('sets the radius scale, the easing and the floating shadow', () => {
    expect(['sm', 'md', 'lg', 'xl'].map((size) => primitives.get(`--radius-${size}`))).toEqual(['0.375rem', '0.625rem', '0.875rem', '1.25rem']);
    expect(declarations(read('tokens/motion.css'), ':root').get('--motion-easing-standard')).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(light.get('--shadow-floating')).toBe('0 24px 48px -12px rgb(0 0 0 / 0.55), 0 2px 6px rgb(0 0 0 / 0.35)');
  });

  it('sets the type scale on Archivo for titles and Geist for the interface', () => {
    const type = declarations(read('tokens/typography.css'), ':root');
    expect(type.get('--display-lg')).toBe('800 3rem/3.25rem var(--font-brand)');
    expect(type.get('--heading-xl')).toBe('800 2rem/2.375rem var(--font-brand)');
    expect(type.get('--heading-lg')).toBe('700 1.375rem/1.75rem var(--font-brand-md)');
    expect(type.get('--title-md')).toBe('600 1rem/1.5rem var(--font-ui)');
    expect(type.get('--body-md')).toBe('400 0.875rem/1.3125rem var(--font-ui)');
    expect(type.get('--caption')).toBe('500 0.75rem/1rem var(--font-ui)');
    const globals = read('globals.css');
    expect(globals).toContain("@import '@fontsource-variable/geist/wght.css'");
    expect(globals).not.toMatch(/fontsource\/(sora|inter)/);
  });

  it('names the Geist family the way the package declares it', () => {
    expect(declarations(read('tokens/typography.css'), ':root').get('--font-ui')).toBe("'Geist Variable', system-ui, sans-serif");
    expect(fontFaces(readFileSync(join(FONTS, 'geist', 'wght.css'), 'utf8')).map((face) => face.family)).toContain('Geist Variable');
  });

  it.each([
    { token: '--font-brand', family: 'Archivo Expanded', stretch: '118%' },
    { token: '--font-brand-md', family: 'Archivo Semi Expanded', stretch: '112%' }
  ])('serves $family from the width-axis files of Archivo', ({ token, family, stretch }) => {
    expect(declarations(read('tokens/typography.css'), ':root').get(token)).toBe(`'${family}', 'Archivo Variable', sans-serif`);
    const faces = fontFaces(read('tokens/fonts.css')).filter((face) => face.family === family);
    const files = ['archivo-latin-ext-wdth-normal.woff2', 'archivo-latin-wdth-normal.woff2'];
    expect(faces.map((face) => face.src).sort()).toEqual(
      files.map((file) => `url('@fontsource-variable/archivo/files/${file}') format('woff2-variations')`)
    );
    expect(faces.map((face) => [face.stretch, face.weight])).toEqual([
      [stretch, '100 900'],
      [stretch, '100 900']
    ]);
    for (const file of files) expect(existsSync(join(FONTS, 'archivo', 'files', file))).toBe(true);
  });

  it('declares every status and format token in both themes with a dark value of its own', () => {
    const lightNames = themed(light.keys());
    expect(themed(darkOverrides.keys())).toEqual(lightNames);
    expect(lightNames.filter((name) => dark.get(name) === light.get(name))).toEqual([]);
    expect(darkOverrides.has('--calendar-today-bg')).toBe(true);
  });

  it('pins the status and format tokens of the canvas in the light theme', () => {
    expect(themedValues(light)).toEqual({
      '--status-ready-fg': 'var(--color-teal-700)',
      '--status-waiting-fg': 'var(--color-violet-600)',
      '--status-adjust-fg': 'var(--color-indigo-600)',
      '--status-late-fg': 'var(--color-red-700)',
      '--status-published-fg': 'var(--color-slate-600)',
      '--status-production-fg': 'var(--color-slate-500)',
      '--format-carousel-bg': 'color-mix(in srgb, var(--color-teal-500) 10%, var(--color-white))',
      '--format-carousel-fg': 'var(--color-teal-700)',
      '--format-carousel-tag-bg': 'var(--color-teal-700)',
      '--format-carousel-tag-fg': 'var(--color-white)',
      '--format-reels-bg': 'color-mix(in srgb, var(--color-violet-600) 7%, var(--color-white))',
      '--format-reels-fg': 'var(--color-violet-600)',
      '--format-reels-tag-bg': 'var(--color-violet-600)',
      '--format-reels-tag-fg': 'var(--color-white)',
      '--format-static-bg': 'var(--color-mist-100)',
      '--format-static-fg': 'var(--color-ink-900)',
      '--format-static-tag-bg': 'var(--color-slate-600)',
      '--format-static-tag-fg': 'var(--color-white)'
    });
  });

  it('pins the status and format tokens of the canvas in the dark theme', () => {
    expect(themedValues(dark)).toEqual({
      '--status-ready-fg': 'var(--color-teal-500)',
      '--status-waiting-fg': 'var(--color-violet-400)',
      '--status-adjust-fg': 'var(--color-indigo-400)',
      '--status-late-fg': 'var(--color-red-400)',
      '--status-published-fg': 'var(--color-slate-400)',
      '--status-production-fg': 'var(--color-slate-400)',
      '--format-carousel-bg': 'color-mix(in srgb, var(--color-teal-500) 12%, var(--color-ink-800))',
      '--format-carousel-fg': 'color-mix(in srgb, var(--color-teal-500) 70%, var(--color-cloud-50))',
      '--format-carousel-tag-bg': 'var(--color-teal-500)',
      '--format-carousel-tag-fg': 'var(--color-ink-900)',
      '--format-reels-bg': 'color-mix(in srgb, var(--color-violet-400) 12%, var(--color-ink-800))',
      '--format-reels-fg': 'color-mix(in srgb, var(--color-violet-400) 70%, var(--color-cloud-50))',
      '--format-reels-tag-bg': 'var(--color-violet-400)',
      '--format-reels-tag-fg': 'var(--color-ink-900)',
      '--format-static-bg': 'color-mix(in srgb, var(--color-slate-400) 8%, var(--color-ink-800))',
      '--format-static-fg': 'var(--color-slate-300)',
      '--format-static-tag-bg': 'var(--color-slate-300)',
      '--format-static-tag-fg': 'var(--color-ink-900)'
    });
  });

  const STATUS = ['ready', 'waiting', 'adjust', 'late', 'published', 'production'];
  const FORMATS = ['carousel', 'reels', 'static'];

  for (const theme of ['light', 'dark'] as const) {
    describe(`contrast in ${theme}`, () => {
      for (const status of STATUS) {
        for (const surface of ['bg-canvas', 'bg-surface']) {
          it(`status ${status} icon is 3:1 on ${surface}`, () => {
            expect(contrast(theme, `status-${status}-fg`, surface)).toBeGreaterThanOrEqual(3);
          });
        }
      }

      for (const format of FORMATS) {
        it(`format ${format} title is AA on its card`, () => {
          expect(contrast(theme, `format-${format}-fg`, `format-${format}-bg`)).toBeGreaterThanOrEqual(4.5);
        });
        it(`format ${format} tag text is AA on its fill`, () => {
          expect(contrast(theme, `format-${format}-tag-fg`, `format-${format}-tag-bg`)).toBeGreaterThanOrEqual(4.5);
        });
        it(`secondary text is AA on the ${format} card`, () => {
          expect(contrast(theme, 'text-secondary', `format-${format}-bg`)).toBeGreaterThanOrEqual(4.5);
        });
      }

      it('primary text is AA on the today cell', () => {
        expect(contrast(theme, 'text-primary', 'calendar-today-bg')).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it('keeps the new primitives at the contrast the canvas states', () => {
    expect(contrast('dark', 'color-violet-400', 'bg-surface')).toBeGreaterThanOrEqual(5.3);
    expect(contrast('light', 'color-teal-700', 'bg-surface')).toBeGreaterThanOrEqual(5.4);
  });

  it('derives the badge fade and the today cell from existing tokens', () => {
    expect(light.get('--client-badge-fade-start')).toBe('color-mix(in srgb, var(--color-indigo-600) 60%, var(--color-ink-900))');
    expect(light.get('--client-badge-fade-end')).toBe('color-mix(in srgb, var(--color-violet-600) 60%, var(--color-ink-900))');
    expect(light.get('--calendar-today-bg')).toBe('color-mix(in srgb, var(--action-primary-bg) 14%, var(--bg-surface))');
    expect(darkOverrides.get('--calendar-today-bg')).toBe(light.get('--calendar-today-bg'));
  });

  it('keeps white text on both ends of the client badge fade at 9.5:1 or more', () => {
    for (const end of ['start', 'end']) {
      expect(contrast('dark', 'color-white', `client-badge-fade-${end}`)).toBeGreaterThanOrEqual(9.5);
    }
  });
});

describe('contrast table of docs/design-system.md 20.1', () => {
  const doc = readFileSync(join(STYLES, '..', '..', '..', '..', 'docs', 'design-system.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = doc.slice(doc.indexOf('### 20.1'), doc.indexOf('\n## 21.'));

  const tokenName = (cell: string) => cell.replace(/`/g, '').replace(/\//g, '-');
  const expand = (name: string): string[] => {
    const group = /\{([^}]+)\}/.exec(name);
    return group ? group[1]!.split(',').flatMap((option) => expand(name.replace(group[0], option))) : [name];
  };

  // A pair is a cell that starts with the foreground token, or names it in parentheses ("Anel ... (`status/late/fg`) sobre"), or says "branco".
  const foreground = (pair: string) => {
    const match = /^(?:`([^`]+)`|[^`|]*\(`([^`]+)`\)|(branco)) sobre (.+)$/.exec(pair);
    return match && { fg: match[3] ? 'color-white' : tokenName((match[1] ?? match[2])!), backgrounds: match[4]! };
  };

  // "`client-badge/fade/start` / `end`": a token with no path continues the one before it.
  const backgroundsOf = (cell: string) => {
    let previous = '';
    return [...cell.matchAll(/`([^`]+)`/g)].flatMap((token) =>
      expand(tokenName(token[1]!)).map((name) => (previous = name.includes('-') ? name : previous.replace(/[^-]+$/, name))),
    );
  };

  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .flatMap(([pair, lightCell, darkCell]) => {
      const match = foreground(pair!);
      if (!match) return [];
      const backgrounds = backgroundsOf(match.backgrounds);
      return (['light', 'dark'] as const).map((theme) => {
        const cell = (theme === 'light' ? lightCell : darkCell)!;
        const stated = [...cell.matchAll(/(\d+\.\d+):1/g)].map((value) => Number(value[1]));
        return { pair: pair!, theme, fg: match.fg, backgrounds, stated };
      });
    })
    .filter((row) => row.stated.length > 0);

  it('reads the pairs of every table', () => {
    expect(rows).toHaveLength(68);
  });

  it.each(rows)('states for $pair in $theme the ratio the stylesheets give', ({ theme, fg, backgrounds, stated }) => {
    expect(stated).toHaveLength(backgrounds.length);
    backgrounds.forEach((background, index) => {
      expect(contrast(theme, fg, background), `${fg} on ${background}`).toBeCloseTo(stated[index]!, 2);
    });
  });
});
