import { execFileSync } from "node:child_process";
import path from "node:path";

// Knex owns the one canonical append-only migration and policy history (ADR 0011).
const migrationRoots = ["packages/database/migrations"];
const versionedMigration = /^\d{8,}[_-][A-Za-z0-9][A-Za-z0-9_.-]*\.mjs$/;

const versionOf = (filename) => /^\d+/.exec(filename)?.[0];

/** Newest version among migration file names, or undefined when none is versioned. */
export function latestVersion(filenames) {
  let latest;
  for (const filename of filenames) {
    const digits = versionOf(filename);
    if (digits !== undefined && (latest === undefined || BigInt(digits) > latest)) latest = BigInt(digits);
  }
  return latest;
}

/** Added migrations whose version does not come after the newest one already on the base. */
export function outOfOrder(addedFilenames, baseFilenames) {
  const baseLatest = latestVersion(baseFilenames);
  if (baseLatest === undefined) return [];
  return addedFilenames.filter((filename) => {
    const digits = versionOf(filename);
    return digits !== undefined && BigInt(digits) <= baseLatest;
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  console.error(`Migration policy failed: ${message}`);
  process.exitCode = 1;
}

const isDirectRun = () =>
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

function run() {
  const base = argument("--base");
  const head = argument("--head");

  if (!base || !head) {
    fail("both --base <commit> and --head <commit> are required.");
    return;
  }

  let output;
  try {
    output = execFileSync(
      "git",
      [
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        `${base}...${head}`,
        "--",
        ...migrationRoots,
      ],
      { encoding: "buffer" },
    );
  } catch (error) {
    fail(`could not compare ${base}...${head}: ${error.message}`);
    return;
  }

  const fields = output.toString("utf8").split("\0").filter(Boolean);
  const changes = [];

  for (let index = 0; index < fields.length; index += 2) {
    changes.push({ status: fields[index], file: fields[index + 1] });
  }

  if (changes.length === 0) {
    console.log("No migration changes found in guarded migration roots.");
    return;
  }

  // The base tip, not the merge base: a migration merged after the branch was cut still counts.
  let baseFilenames;
  try {
    baseFilenames = execFileSync(
      "git",
      ["ls-tree", "--name-only", "-z", base, `${migrationRoots[0]}/`],
      { encoding: "buffer" },
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((file) => path.posix.basename(file));
  } catch (error) {
    fail(`could not list the migrations on ${base}: ${error.message}`);
    return;
  }

  const added = changes.filter(({ status }) => status === "A").map(({ file }) => path.posix.basename(file));
  const late = new Set(outOfOrder(added, baseFilenames));
  const baseLatest = latestVersion(baseFilenames);

  for (const { status, file } of changes) {
    const filename = path.posix.basename(file);
    if (status !== "A") {
      fail(
        `${status} ${file}. Existing migrations are immutable; create a new versioned migration instead.`,
      );
    } else if (!versionedMigration.test(filename)) {
      fail(
        `A ${file}. New migrations must be .mjs files starting with an 8+ digit version followed by _ or -.`,
      );
    } else if (late.has(filename)) {
      const name = filename.replace(/^\d+[_-]/, "");
      fail(
        `A ${file}. Its version ${versionOf(filename)} is not newer than ${baseLatest}, the newest migration already on ${base}, so a fresh database would apply it in a different order than an existing one. Rename it with: git mv ${file} ${migrationRoots[0]}/<version greater than ${baseLatest}>_${name}. Only rename a migration that is not on the base yet.`,
      );
    } else {
      console.log(`Accepted new versioned migration: ${file}`);
    }
  }
}

if (isDirectRun()) run();
