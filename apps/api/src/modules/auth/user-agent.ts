import type { AuthSessionBrowser, AuthSessionSystem } from '@ageniza/contracts';

export interface DescribedUserAgent {
  readonly browser: AuthSessionBrowser | null;
  readonly os: AuthSessionSystem | null;
}

/** The product token that names the browser comes first, and a header can be long: only the start is read. */
const MAX_USER_AGENT_CHARACTERS = 512;

// The first token that matches wins, so the order is the rule: Edge, Opera and Samsung Internet carry "Chrome/" and
// "Safari/" too, and every Chromium browser carries "Safari/".
const BROWSERS: readonly (readonly [AuthSessionBrowser, readonly string[]])[] = [
  ['Edge', ['Edg/', 'EdgA/', 'EdgiOS/', 'Edge/']],
  ['Opera', ['OPR/', 'Opera']],
  ['Samsung Internet', ['SamsungBrowser/']],
  ['Firefox', ['Firefox/', 'FxiOS/']],
  ['Chrome', ['Chrome/', 'CriOS/', 'Chromium/']]
];

// Android before Linux (its agent says both), the phone and the tablet before macOS (their agent says "like Mac OS X").
const SYSTEMS: readonly (readonly [AuthSessionSystem, readonly string[]])[] = [
  ['Windows', ['Windows']],
  ['Android', ['Android']],
  ['iOS', ['iPhone', 'iPad', 'iPod']],
  ['ChromeOS', ['CrOS']],
  ['macOS', ['Macintosh', 'Mac OS X']],
  ['Linux', ['Linux', 'X11']]
];

const firstMatch = <TName extends string>(text: string, table: readonly (readonly [TName, readonly string[]])[]): TName | null =>
  table.find(([, tokens]) => tokens.some((token) => text.includes(token)))?.[0] ?? null;

/**
 * The browser and the system a `User-Agent` names, from a closed list, or `null` for what it does not say. Nothing of the
 * header is copied: the answer is one of the names above, so a hostile header can only choose between them.
 */
export const describeUserAgent = (userAgent: string | null | undefined): DescribedUserAgent => {
  const text = (userAgent ?? '').slice(0, MAX_USER_AGENT_CHARACTERS);
  // Safari sends "Version/" and "Safari/" and nothing that names another browser.
  const browser = firstMatch(text, BROWSERS) ?? (text.includes('Safari/') && text.includes('Version/') ? 'Safari' : null);
  return { browser, os: firstMatch(text, SYSTEMS) };
};
