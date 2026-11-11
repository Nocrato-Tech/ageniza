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
const light = new Map([...primitives, ...declarations(read('tokens/semantic.css'), ':root')]);
const themes = { light } as const;

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

describe('design tokens (one light theme)', () => {
  it('keeps hex colours in primitives.css only', () => {
    const offenders = ['globals.css', 'tokens/semantic.css', 'tokens/typography.css', 'tokens/motion.css', 'tokens/fonts.css'].filter(
      (file) => /#[0-9a-f]{3,8}\b/i.test(read(file))
    );
    expect(offenders).toEqual([]);
    expect([...primitives.keys()].filter((name) => name.startsWith('--color-')).sort()).toEqual(
      [
        'ink-900', 'ink-600', 'slate-700', 'slate-600', 'slate-500', 'slate-400', 'slate-300', 'slate-100',
        'mist-200', 'mist-100', 'cloud-100', 'white',
        'indigo-50', 'indigo-100', 'indigo-200', 'indigo-600', 'indigo-700', 'indigo-800',
        'violet-100', 'violet-600', 'violet-800', 'teal-100', 'teal-500', 'teal-700', 'teal-800',
        'sky-100', 'sky-600', 'sky-800', 'red-100', 'red-700', 'red-800', 'orange-400', 'pink-500',
        'stage-indigo', 'stage-indigo-deep', 'stage-violet', 'stage-violet-deep', 'stage-teal', 'stage-teal-deep',
        'stage-sky', 'stage-sky-deep', 'stage-red', 'stage-red-deep'
      ]
        .map((name) => `--color-${name}`)
        .sort()
    );
  });

  it('has no dark theme left: no stylesheet, no override, no attribute selector', () => {
    expect(existsSync(join(STYLES, 'themes', 'dark.css'))).toBe(false);
    for (const file of ['globals.css', 'tokens/semantic.css', 'tokens/primitives.css']) expect(read(file), file).not.toContain('data-theme');
    expect(readFileSync(join(STYLES, 'globals.css'), 'utf8')).not.toContain('themes/');
  });

  it('sets the radius scale, the easing and the two shadows', () => {
    expect(['sm', 'md', 'lg', 'xl'].map((size) => primitives.get(`--radius-${size}`))).toEqual(['0.5rem', '0.75rem', '1.25rem', '1.75rem']);
    expect(declarations(read('tokens/motion.css'), ':root').get('--motion-easing-standard')).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(light.get('--shadow-floating')).toBe('0 24px 48px -16px rgb(17 24 39 / 0.22), 0 2px 8px rgb(17 24 39 / 0.08)');
    expect(light.get('--shadow-raised')).toBe('0 1px 2px rgb(17 24 39 / 0.04), 0 8px 24px -12px rgb(55 48 163 / 0.18)');
  });

  it('sets the type scale on Archivo for titles and Geist for the interface', () => {
    const type = declarations(read('tokens/typography.css'), ':root');
    expect(type.get('--display-lg')).toBe('800 3rem/3.25rem var(--font-brand)');
    expect(type.get('--heading-xl')).toBe('800 2rem/2.375rem var(--font-brand)');
    expect(type.get('--heading-lg')).toBe('700 1.375rem/1.75rem var(--font-brand-md)');
    expect(type.get('--stat-lg')).toBe('800 2.25rem/2.5rem var(--font-brand)');
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

  it('gives every status a soft fill and a text, besides the icon colour, and every format its own pair', () => {
    for (const status of ['production', 'adjust', 'waiting', 'ready', 'scheduled', 'late']) {
      for (const part of ['fg', 'bg', 'text']) expect(light.has(`--status-${status}-${part}`), `${status} ${part}`).toBe(true);
    }
    for (const format of ['carousel', 'reels', 'static']) {
      for (const part of ['bg', 'fg', 'tag-bg', 'tag-fg']) expect(light.has(`--format-${format}-${part}`), `${format} ${part}`).toBe(true);
    }
  });

  it('pins the status families of the board: violet waits for the client, teal is approved, sky is scheduled, red is late, indigo is the agency', () => {
    expect(themedValues(light)).toMatchObject({
      '--status-waiting-bg': 'var(--color-violet-100)',
      '--status-waiting-text': 'var(--color-violet-800)',
      '--status-ready-bg': 'var(--color-teal-100)',
      '--status-ready-text': 'var(--color-teal-800)',
      '--status-scheduled-bg': 'var(--color-sky-100)',
      '--status-scheduled-text': 'var(--color-sky-800)',
      '--status-late-bg': 'var(--color-red-700)',
      '--status-late-text': 'var(--color-white)',
      '--status-adjust-bg': 'var(--color-indigo-100)',
      '--status-adjust-text': 'var(--color-indigo-800)',
      '--status-production-bg': 'var(--color-slate-100)',
      '--status-production-text': 'var(--color-slate-700)',
      '--status-ready-fg': 'var(--color-teal-700)',
      '--status-waiting-fg': 'var(--color-violet-600)',
      '--status-adjust-fg': 'var(--color-indigo-600)',
      '--status-scheduled-fg': 'var(--color-sky-600)',
      '--status-late-fg': 'var(--color-red-700)',
      '--status-published-fg': 'var(--color-slate-600)',
      '--status-production-fg': 'var(--color-slate-500)',
      '--format-carousel-bg': 'var(--color-teal-100)',
      '--format-carousel-fg': 'var(--color-teal-800)',
      '--format-carousel-tag-bg': 'var(--color-teal-700)',
      '--format-reels-bg': 'var(--color-violet-100)',
      '--format-reels-fg': 'var(--color-violet-800)',
      '--format-reels-tag-bg': 'var(--color-violet-600)',
      '--format-static-bg': 'var(--color-slate-100)',
      '--format-static-fg': 'var(--color-slate-700)',
      '--format-static-tag-bg': 'var(--color-slate-600)'
    });
  });

  it('maps the board palette on the semantic tokens that already existed, with no parallel names', () => {
    expect(light.get('--bg-canvas')).toBe('var(--color-cloud-100)');
    expect(light.get('--bg-surface')).toBe('var(--color-white)');
    expect(light.get('--bg-hover')).toBe('var(--color-indigo-50)');
    expect(light.get('--bg-tint')).toBe('var(--color-indigo-100)');
    expect(light.get('--action-primary-bg')).toBe('var(--color-indigo-600)');
    expect(light.get('--action-primary-hover')).toBe('var(--color-indigo-700)');
    expect(light.get('--action-secondary-bg')).toBe('var(--color-indigo-100)');
    expect(light.get('--action-secondary-fg')).toBe('var(--color-indigo-800)');
    expect(light.get('--action-disabled-bg')).toBe('var(--color-mist-100)');
    expect(light.get('--focus-ring')).toBe('var(--color-indigo-600)');
  });

  it('declares the stage of the 3D icon: a tone and a deeper tone per family, four sizes, a tilt and a float', () => {
    for (const family of ['indigo', 'violet', 'teal', 'sky', 'red', 'slate']) {
      expect(light.has(`--stage-${family}-tone`), family).toBe(true);
      expect(light.has(`--stage-${family}-deep`), family).toBe(true);
    }
    expect(['sm', 'md', 'lg', 'xl'].map((size) => light.get(`--stage-size-${size}`))).toEqual(['2.75rem', '4.5rem', '6.25rem', '8.5rem']);
    expect(light.get('--stage-tilt')).toBe('-6deg');
    expect(light.get('--stage-float-duration')).toBe('4.2s');
  });

  const STATUS = ['ready', 'waiting', 'adjust', 'late', 'published', 'production'];
  const FORMATS = ['carousel', 'reels', 'static'];

  for (const theme of ['light'] as const) {
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

  it('keeps the teal of the ready state at the contrast the canvas states', () => {
    expect(contrast('light', 'color-teal-700', 'bg-surface')).toBeGreaterThanOrEqual(5.4);
  });

  it('is AA for every soft tag and every summary block, text on its own fill', () => {
    for (const status of ['production', 'adjust', 'waiting', 'ready', 'scheduled', 'late']) {
      expect(contrast('light', `status-${status}-text`, `status-${status}-bg`), status).toBeGreaterThanOrEqual(4.5);
    }
    for (const family of ['indigo', 'violet', 'teal', 'sky', 'red', 'slate']) {
      expect(contrast('light', `block-${family}-fg`, `block-${family}-bg`), family).toBeGreaterThanOrEqual(4.5);
      expect(contrast('light', 'text-primary', `block-${family}-bg`), `primary on ${family}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is AA for the actions on their fill and on their hover', () => {
    expect(contrast('light', 'action-primary-fg', 'action-primary-bg')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('light', 'action-primary-fg', 'action-primary-hover')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('light', 'action-secondary-fg', 'action-secondary-bg')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('light', 'action-secondary-fg', 'action-secondary-hover')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('light', 'action-danger-fg', 'action-danger-bg')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('light', 'action-disabled-fg', 'action-disabled-bg')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps text, link and the control edge readable on the surfaces they sit on: canvas, surface and hover', () => {
    for (const surface of ['bg-canvas', 'bg-surface', 'bg-hover']) {
      expect(contrast('light', 'text-secondary', surface), `secondary on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast('light', 'text-muted', surface), `muted on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast('light', 'text-link', surface), `link on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast('light', 'text-danger', surface), `danger on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast('light', 'focus-ring', surface), `ring on ${surface}`).toBeGreaterThanOrEqual(3);
      expect(contrast('light', 'border-control', surface), `edge on ${surface}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast('light', 'text-secondary', 'bg-tint')).toBeGreaterThanOrEqual(4.5);
  });

  it('derives the badge fade and the today cell from existing tokens', () => {
    expect(light.get('--client-badge-fade-start')).toBe('color-mix(in srgb, var(--color-indigo-600) 60%, var(--color-ink-900))');
    expect(light.get('--client-badge-fade-end')).toBe('color-mix(in srgb, var(--color-violet-600) 60%, var(--color-ink-900))');
    expect(light.get('--calendar-today-bg')).toBe('color-mix(in srgb, var(--action-primary-bg) 14%, var(--bg-surface))');
  });

  it('keeps white text on both ends of the client badge fade at 9.5:1 or more', () => {
    for (const end of ['start', 'end']) {
      expect(contrast('light', 'color-white', `client-badge-fade-${end}`)).toBeGreaterThanOrEqual(9.5);
    }
  });

  it('keeps the handle on the client badge fade and the content numbers on the canvas readable', () => {
    for (const end of ['start', 'end']) {
      expect(contrast('light', 'color-slate-300', `client-badge-fade-${end}`)).toBeGreaterThanOrEqual(6.3);
    }
    for (const theme of ['light'] as const) {
      expect(contrast(theme, 'text-muted', 'bg-canvas')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme, 'text-danger', 'bg-canvas')).toBeGreaterThanOrEqual(4.5);
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
    .flatMap(([pair, cell]) => {
      const match = foreground(pair!);
      if (!match) return [];
      const backgrounds = backgroundsOf(match.backgrounds);
      const stated = [...cell!.matchAll(/(\d+\.\d+):1/g)].map((value) => Number(value[1]));
      return [{ pair: pair!, theme: 'light' as const, fg: match.fg, backgrounds, stated }];
    })
    .filter((row) => row.stated.length > 0);

  it('reads the pairs of every table', () => {
    expect(rows).toHaveLength(46);
  });

  it.each(rows)('states for $pair in $theme the ratio the stylesheets give', ({ theme, fg, backgrounds, stated }) => {
    expect(stated).toHaveLength(backgrounds.length);
    backgrounds.forEach((background, index) => {
      expect(contrast(theme, fg, background), `${fg} on ${background}`).toBeCloseTo(stated[index]!, 2);
    });
  });
});
