import { execFileSync } from 'node:child_process';

// docs/business/structural-changes.md asks a structural change to be recorded before it is written.
// An instruction alone does not hold: this turns it into a gate, so the expensive decisions cannot
// be settled quietly inside a pull request that was about something else.
const DECISIONS_FILE = 'docs/business/decisions.md';
// A decision may also live in a file of its own (the record is moving to one file per decision).
const DECISIONS_DIRECTORY = 'docs/business/decisions/';

/** SQL that reaches something already deployed, as opposed to creating new objects. */
const STRUCTURAL_SQL = [
  { pattern: /\bdrop\s+policy\b/i, reason: 'replaces an existing RLS policy' },
  { pattern: /\bdrop\s+table\b/i, reason: 'drops a table' },
  { pattern: /\bdrop\s+column\b/i, reason: 'drops a column' },
  { pattern: /\brevoke\b/i, reason: 'revokes a privilege' },
  { pattern: /\bdrop\s+function\b/i, reason: 'replaces an existing function' }
];

const qualifiedName = String.raw`(?:[a-z_][a-z0-9_$]*\.)?[a-z_][a-z0-9_$]*`;
const createdTables = new RegExp(String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(${qualifiedName})`, 'gi');
const alteredTables = new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(${qualifiedName})`, 'gi');

/**
 * Reports why a migration counts as structural, or an empty list when it only adds new objects.
 * A new table alters itself to enable RLS, so `alter table` only counts for a table this migration
 * did not create.
 */
export const structuralReasons = (sql) => {
  const withoutComments = sql.replace(/--[^\n]*/g, '');
  const created = new Set([...withoutComments.matchAll(createdTables)].map(([, name]) => name.toLowerCase()));
  const reasons = STRUCTURAL_SQL
    .filter(({ pattern }) => pattern.test(withoutComments))
    .map(({ reason }) => reason);
  const touchesExisting = [...withoutComments.matchAll(alteredTables)]
    .some(([, name]) => !created.has(name.toLowerCase()));
  return touchesExisting ? ['alters an existing table', ...reasons] : reasons;
};

/** True when the change records a decision alongside the migration: in the file, or in a file of its own. */
export const recordsDecision = (changedFiles) =>
  changedFiles.includes(DECISIONS_FILE) ||
  changedFiles.some((file) => file.startsWith(DECISIONS_DIRECTORY) && file.endsWith('.md'));

export const evaluate = (migrations, changedFiles) => {
  const structural = migrations
    .map((migration) => ({ file: migration.file, reasons: structuralReasons(migration.sql) }))
    .filter((migration) => migration.reasons.length > 0);
  return { structural, satisfied: structural.length === 0 || recordsDecision(changedFiles) };
};

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

if (process.argv[1]?.endsWith('verify-structural-decisions.mjs')) {
  const base = argument('base', 'origin/develop');
  const head = argument('head', 'HEAD');
  const changedFiles = git(['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
  const migrations = changedFiles
    .filter((file) => file.startsWith('packages/database/migrations/') && file.endsWith('.mjs'))
    .map((file) => ({ file, sql: git(['show', `${head}:${file}`]) }));

  const { structural, satisfied } = evaluate(migrations, changedFiles);

  if (structural.length === 0) {
    console.log('No structural migration in this change.');
  } else {
    for (const migration of structural) console.log(`structural  ${migration.file} — ${migration.reasons.join(', ')}`);
  }

  if (!satisfied) {
    console.error(
      `\nThis change carries a structural migration but does not touch ${DECISIONS_FILE} or add a file under ${DECISIONS_DIRECTORY}.\n` +
      'Read docs/business/structural-changes.md, then record the decision — context, decision and\n' +
      'consequence — in the same change. If this is a false positive, say so in the entry and keep it:\n' +
      'a recorded non-decision costs one paragraph, an unrecorded one costs a retrofit.'
    );
    process.exitCode = 1;
  } else if (structural.length > 0) {
    console.log('\nStructural change recorded in the decisions record.');
  }
}
