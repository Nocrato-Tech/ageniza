/**
 * Finds SQL that works out a calendar day, or a time zone, on its own (issues #499 and #509). The day
 * of a contract comes from `app_private.sao_paulo_date`; anything else that turns the clock into a day
 * is the same defect again. The scan reads the SQL by form and does not prove absence: a form nobody
 * wrote a probe for can still pass, which is why every form it knows has a probe in
 * `own-day-scan.test.ts` and in the catalog test.
 *
 * A definition keeps its own day when, outside comments, string contents and calls of `sao_paulo_date`:
 *  - it names `current_date`, `current_time`, `localtime`, `localtimestamp` or `at time zone`;
 *  - it casts the clock, through any chain of casts and arithmetic, to date, timestamp, time or text;
 *  - it hands the clock to `date`, `date_trunc`, `date_bin`, `to_char`, or `extract`/`date_part` of
 *    any field but epoch and the seconds;
 *  - it calls `timezone(...)` on anything that is not made of literals alone.
 * A literal such as 'today' or 'now' is the clock.
 */

const CLOCK = /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(\s*\)|\bcurrent_timestamp\b/i;
const ZONED_KEYWORDS = /\bcurrent_date\b|\bcurrent_time\b|\blocaltime(stamp)?\b|\bat\s+time\s+zone\b/i;
const DAY_CASTS = /::\s*(pg_catalog\.)?(date|timestamp|time|timetz|text|varchar|char|character|bpchar|name)\b(?!\s+with\s+time\s+zone)/gi;
const CLOCK_TO_DAY_FUNCTIONS = /\b(date|date_trunc|date_bin|to_char)\s*\(/gi;
const SPECIAL_CLOCK_LITERAL = /^\s*(now|today|tomorrow|yesterday)\s*$/i;
const FIELDS_WITHOUT_A_ZONE = new Set(['epoch', 'second', 'seconds', 'sec', 'secs', 'millisecond', 'milliseconds', 'msec', 'msecs', 'ms', 'microsecond', 'microseconds', 'usec', 'usecs', 'us']);

const matchingClose = (code: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '(') depth += 1;
    else if (code[index] === ')' && (depth -= 1) === 0) return index;
  }
  return -1;
};

const matchingOpen = (code: string, close: number): number => {
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    if (code[index] === ')') depth += 1;
    else if (code[index] === '(' && (depth -= 1) === 0) return index;
  }
  return -1;
};

const blanked = (length: number): string => ' '.repeat(length);

/** Same length as the input: comments and string contents are blanked, and a literal that names the clock becomes `now()`. */
const maskLiteralsAndComments = (sql: string): string => {
  let code = '';
  let index = 0;
  while (index < sql.length) {
    const two = sql.slice(index, index + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      code += blanked(stop - index);
      index = stop;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      code += blanked(stop - index);
      index = stop;
    } else if (sql[index] === "'") {
      let stop = index + 1;
      while (stop < sql.length && !(sql[stop] === "'" && sql[stop + 1] !== "'")) stop += sql[stop] === "'" ? 2 : 1;
      stop = Math.min(stop + 1, sql.length);
      const content = sql.slice(index + 1, stop - 1);
      code += SPECIAL_CLOCK_LITERAL.test(content) ? `now()${blanked(stop - index - 5)}` : `'${blanked(stop - index - 2)}'`;
      index = stop;
    } else {
      code += sql[index];
      index += 1;
    }
  }
  return code;
};

const withoutPureCalls = (code: string): string => {
  let result = code;
  for (const match of [...code.matchAll(/\bsao_paulo_date\s*\(/gi)]) {
    const open = match.index + match[0].length - 1;
    const close = matchingClose(code, open);
    if (close === -1) continue;
    result = result.slice(0, match.index) + blanked(close + 1 - match.index) + result.slice(close + 1);
  }
  return result;
};

/** Start of the expression that ends at `end`, following parenthesised groups, calls and chains of `::` casts. */
const operandStart = (code: string, end: number): number => {
  let index = end;
  for (;;) {
    while (index > 0 && /\s/.test(code[index - 1]!)) index -= 1;
    if (code[index - 1] === ')') {
      const open = matchingOpen(code, index - 1);
      if (open === -1) return 0;
      index = open;
      while (index > 0 && /[\w.]/.test(code[index - 1]!)) index -= 1;
    } else if (/[\w.]/.test(code[index - 1] ?? ' ')) {
      while (index > 0 && /[\w.]/.test(code[index - 1]!)) index -= 1;
    } else {
      return index;
    }
    let before = index;
    while (before > 0 && /\s/.test(code[before - 1]!)) before -= 1;
    if (code.slice(before - 2, before) !== '::') return index;
    index = before - 2;
  }
};

const isMadeOfLiterals = (text: string): boolean =>
  !/[a-z_]/i.test(
    text
      .replace(/::\s*[\w.]+(\s+with(out)?\s+time\s+zone)?/gi, ' ')
      .replace(/\b(date|time|timetz|timestamp|timestamptz|interval|null|true|false)\b/gi, ' ')
  );

const argumentsOf = (code: string, match: RegExpMatchArray): { readonly start: number; readonly end: number } | undefined => {
  const open = match.index! + match[0].length - 1;
  const close = matchingClose(code, open);
  return close === -1 ? undefined : { start: open + 1, end: close };
};

/** What in `sql` works out a day or a zone on its own; empty when nothing does. */
export const ownDayFindings = (sql: string): readonly string[] => {
  const code = withoutPureCalls(maskLiteralsAndComments(sql));
  const findings: string[] = [];

  const keyword = ZONED_KEYWORDS.exec(code);
  if (keyword !== null) findings.push(keyword[0].replace(/\s+/g, ' ').toLowerCase());

  for (const match of code.matchAll(DAY_CASTS)) {
    if (CLOCK.test(code.slice(operandStart(code, match.index), match.index))) findings.push(`the clock cast ${match[0].replace(/\s+/g, '')}`);
  }

  for (const match of code.matchAll(/\bcast\s*\(/gi)) {
    const span = argumentsOf(code, match);
    if (span === undefined) continue;
    const inside = code.slice(span.start, span.end);
    const as = inside.search(/\bas\s+(pg_catalog\.)?(date|timestamp|time|timetz|text|varchar|char|character|bpchar|name)\b(?!\s+with\s+time\s+zone)[^()]*$/i);
    if (as !== -1 && CLOCK.test(inside.slice(0, as))) findings.push('the clock in a cast to a day');
  }

  for (const match of code.matchAll(CLOCK_TO_DAY_FUNCTIONS)) {
    const span = argumentsOf(code, match);
    if (span !== undefined && CLOCK.test(code.slice(span.start, span.end))) findings.push(`${match[1]!.toLowerCase()} of the clock`);
  }

  for (const match of code.matchAll(/\b(extract|date_part)\s*\(/gi)) {
    const span = argumentsOf(code, match);
    if (span === undefined || !CLOCK.test(code.slice(span.start, span.end))) continue;
    const field = match[1]!.toLowerCase() === 'extract'
      ? /^\s*(\w+)\s+from\b/i.exec(code.slice(span.start, span.end))?.[1]
      : /^\s*'([^']*)'/.exec(sql.slice(span.start, span.end))?.[1];
    if (field === undefined || !FIELDS_WITHOUT_A_ZONE.has(field.trim().toLowerCase())) findings.push(`${match[1]!.toLowerCase()} of the clock`);
  }

  for (const match of code.matchAll(/\btimezone\s*\(/gi)) {
    const span = argumentsOf(code, match);
    if (span !== undefined && !isMadeOfLiterals(code.slice(span.start, span.end))) findings.push('timezone() of a value');
  }

  return findings;
};

export const keepsItsOwnDay = (sql: string): boolean => ownDayFindings(sql).length > 0;
