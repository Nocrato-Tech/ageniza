import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STYLES = __dirname;

/** `globals.css` with every sheet it imports from `base.css`, `ui/` and `screens/` written where its `@import` stands, so the text is the cascade the build serves. Token and font imports stay as they are. */
export const readGlobalCss = (): string =>
  readFileSync(join(STYLES, 'globals.css'), 'utf8').replace(/@import '\.\/((?:base|ui\/[\w-]+|screens\/[\w-]+)\.css)';\r?\n/g, (_import, sheet: string) =>
    readFileSync(join(STYLES, sheet), 'utf8')
  );
