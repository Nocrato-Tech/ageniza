import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// `CI / PostgreSQL local database` takes ~14 minutes and proves nothing about a change that cannot reach the database, the
// API or the worker (issue #789). The decision is a fixed ALLOW list of what may skip it, never a list of what needs it
// (issue #511): a file nobody thought of, in a place nobody thought of, falls outside the list and runs the whole job.
//
// The job is skipped only when EVERY changed path is allowed. Verified when this was written: nothing under these
// paths is read by the job (the API only writes `docs/api`, and `packages/ui` names `apps/web/public` in comments).
// Add to the list only after checking that the same holds for the new path.
export const ALLOWED = [
  // The SPA. The API, worker and packages do not import it.
  (file) => file.startsWith("apps/web/"),
  // Documentation, whatever its extension (`docs/api` is generated and checked by the quality gates).
  (file) => file.startsWith("docs/"),
  // Markdown at the repository root only: a `.md` inside a code folder (packages/database/README.md) is not on the list.
  (file) => /^[^/]+\.md$/.test(file),
];

export const isAllowed = (file) => ALLOWED.some((matches) => matches(file));

// Control characters would break the one-line step output, so a name is always shown quoted and escaped.
const shown = (file) => JSON.stringify(file);

/**
 * @param {{ eventName: string | undefined, files: string[] | undefined }} input `files` is undefined when the diff
 * could not be computed.
 * @returns {{ run: boolean, reason: string }}
 */
export function decide({ eventName, files }) {
  // What landed on develop is what gets deployed: it always gets the full job.
  if (eventName !== "pull_request") {
    return { run: true, reason: `the event is ${shown(eventName ?? "")}, not a pull request, so the job always runs` };
  }
  if (files === undefined) {
    return { run: true, reason: "the list of changed files could not be computed, so the job runs" };
  }
  // A pull request with no changed path is not something a change set explains: do not trust it.
  if (files.length === 0) {
    return { run: true, reason: "the diff is empty, so the job runs" };
  }
  const outside = files.find((file) => !isAllowed(file));
  if (outside !== undefined) {
    return { run: true, reason: `${shown(outside)} is outside the list of paths that may skip the job, so it runs` };
  }
  return {
    run: false,
    reason: `all ${files.length} changed file(s) are under apps/web, under docs or Markdown at the repository root, which neither the database, the API nor the worker read`,
  };
}

/** Changed paths of the pull request, from git itself. Renames are split into a delete and an add: both paths count. */
export function changedFiles(base, head) {
  const output = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`], {
    encoding: "buffer",
  });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const isDirectRun = () =>
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

function run() {
  const eventName = argument("--event");
  const base = argument("--base");
  const head = argument("--head");

  let files;
  if (base && head) {
    try {
      files = changedFiles(base, head);
    } catch (error) {
      console.error(`Could not compare ${base}...${head}: ${error.message}`);
    }
  }

  const { run: needed, reason } = decide({ eventName, files });
  console.log(`${needed ? "Running" : "Skipping"} the PostgreSQL local database job: ${reason}.`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${needed}\nreason=${reason}\n`);
  }
}

if (isDirectRun()) run();
