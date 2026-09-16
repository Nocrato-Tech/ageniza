import { execFileSync } from "node:child_process";
import path from "node:path";

// Supabase CLI owns the one canonical append-only migration and policy history.
const migrationRoots = ["supabase/migrations"];
const versionedSqlMigration = /^\d{8,}[_-][A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  console.error(`Migration policy failed: ${message}`);
  process.exitCode = 1;
}

const base = argument("--base");
const head = argument("--head");

if (!base || !head) {
  fail("both --base <commit> and --head <commit> are required.");
} else {
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
  }

  if (output) {
    const fields = output.toString("utf8").split("\0").filter(Boolean);
    const changes = [];

    for (let index = 0; index < fields.length; index += 2) {
      changes.push({ status: fields[index], file: fields[index + 1] });
    }

    if (changes.length === 0) {
      console.log("No SQL migration changes found in guarded migration roots.");
    } else {
      for (const { status, file } of changes) {
        const filename = path.posix.basename(file);
        if (status !== "A") {
          fail(
            `${status} ${file}. Existing migrations are immutable; create a new versioned SQL migration instead.`,
          );
        } else if (!versionedSqlMigration.test(filename)) {
          fail(
            `A ${file}. New SQL migrations must start with an 8+ digit version followed by _ or -.`,
          );
        } else {
          console.log(`Accepted new versioned SQL migration: ${file}`);
        }
      }
    }
  }
}
