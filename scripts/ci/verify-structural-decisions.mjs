import { execFileSync } from 'node:child_process';

// docs/business/structural-changes.md asks a structural change to be recorded before it is written.
// An instruction alone does not hold: this turns it into a gate, so the expensive decisions cannot
// be settled quietly inside a pull request that was about something else.
const DECISIONS_DIRECTORY = 'docs/business/decisions/';
// Only an added file registers a decision: editing or deleting an existing one must not satisfy the
// gate, or the "never edit another decision's file" rule would have no enforcement at all.
const DECISION_FILE = /^docs\/business\/decisions\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

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

/** Files with git status `A` (added) in a `git diff --name-status` output. */
export const addedFilesFrom = (nameStatus) =>
  nameStatus
    .split('\n')
    .filter((line) => line.startsWith('A\t'))
    .map((line) => line.slice(2).trim());

/** True when the change adds a decision file alongside the migration. */
export const recordsDecision = (addedFiles) => addedFiles.some((file) => DECISION_FILE.test(file));

export const evaluate = (migrations, addedFiles) => {
  const structural = migrations
    .map((migration) => ({ file: migration.file, reasons: structuralReasons(migration.sql) }))
    .filter((migration) => migration.reasons.length > 0);
  return { structural, satisfied: structural.length === 0 || recordsDecision(addedFiles) };
};

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

if (process.argv[1]?.endsWith('verify-structural-decisions.mjs')) {
  const base = argument('base', 'origin/develop');
  const head = argument('head', 'HEAD');
  const nameStatus = git(['diff', '--name-status', `${base}...${head}`]);
  const changedFiles = nameStatus.split('\n').filter(Boolean).map((line) => line.split('\t').pop());
  const migrations = changedFiles
    .filter((file) => file.startsWith('packages/database/migrations/') && file.endsWith('.mjs'))
    .map((file) => ({ file, sql: git(['show', `${head}:${file}`]) }));

  const { structural, satisfied } = evaluate(migrations, addedFilesFrom(nameStatus));

  if (structural.length === 0) {
    console.log('No structural migration in this change.');
  } else {
    for (const migration of structural) console.log(`structural  ${migration.file} — ${migration.reasons.join(', ')}`);
  }

  if (!satisfied) {
    console.error(
      `\nThis change carries a structural migration but adds no decision file in ${DECISIONS_DIRECTORY}\n` +
      '(an added `AAAA-MM-DD-<slug>.md`, never an edit to an existing one).\n' +
      'Read docs/business/structural-changes.md, then record the decision — context, decision and\n' +
      'consequence — in the same change. If this is a false positive, say so in the entry and keep it:\n' +
      'a recorded non-decision costs one paragraph, an unrecorded one costs a retrofit.'
    );
    process.exitCode = 1;
  } else if (structural.length > 0) {
    console.log(`\nStructural change recorded in an added file under ${DECISIONS_DIRECTORY}.`);
  }
}
