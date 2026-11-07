import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

/** The text of `.github/workflows/ci.yml` with LF line endings. */
export const readCiWorkflow = () => readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

/** A job of ci.yml: its text up to the next job, split into the header (before `steps:`) and the steps. */
export const ciJob = (id) => {
  const workflow = readCiWorkflow();
  const start = workflow.indexOf(`\n  ${id}:\n`);
  if (start === -1) throw new Error(`ci.yml has no job "${id}"`);
  const rest = workflow.slice(start + 1);
  const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1));
  const job = next ? rest.slice(0, next.index + 1) : rest;
  const marker = '\n    steps:';
  const header = job.slice(0, job.indexOf(marker));
  const steps = job
    .slice(job.indexOf(marker) + marker.length)
    .split(/\n {6}- /)
    .slice(1)
    .map((step) => step.trimEnd());
  return { id, text: job, header, steps };
};

/** The first `name:` (or `uses:`) line of a step, which is how the tests find it. */
export const stepName = (step) => /^(?:name|uses): (.+)$/m.exec(step)?.[1];
