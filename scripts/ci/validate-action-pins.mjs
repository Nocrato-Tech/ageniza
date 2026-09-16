import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A workflow that runs rarely (production release, branch guard) can carry an action pinned to a
// SHA that does not exist, and nothing notices until the day it runs. This resolves every pin.
const pinnedUse = /uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([0-9a-f]{40})\b/g;
const anyUse = /uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([^\s#]+)/g;

/** Collects `owner/repo@<40-hex>` pins from workflow text. Local `./.github/...` uses are skipped. */
export const collectActionPins = (content) => {
  const pins = [];
  for (const [, repository, sha] of content.matchAll(pinnedUse)) pins.push({ repository, sha });
  return pins;
};

/** Collects third-party uses that are not pinned to a commit SHA, for reporting only. */
export const collectUnpinnedUses = (content) => {
  const uses = [];
  for (const [, repository, ref] of content.matchAll(anyUse)) {
    if (!/^[0-9a-f]{40}$/.test(ref)) uses.push({ repository, ref });
  }
  return uses;
};

const workflowFiles = (root) => {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ya?ml$/.test(entry)) files.push(path);
    }
  };
  walk(join(root, '.github', 'workflows'));
  const actions = join(root, '.github', 'actions');
  try {
    walk(actions);
  } catch {
    // No composite actions in this repository.
  }
  return files;
};

if (process.argv[1] && new URL(`file:${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url) {
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const token = process.env.GITHUB_TOKEN;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ageniza-ci' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const seen = new Map();
  const unpinned = new Set();
  for (const file of workflowFiles(process.cwd())) {
    const content = readFileSync(file, 'utf8');
    for (const pin of collectActionPins(content)) {
      const key = `${pin.repository}@${pin.sha}`;
      if (!seen.has(key)) seen.set(key, { ...pin, files: new Set() });
      seen.get(key).files.add(file);
    }
    for (const use of collectUnpinnedUses(content)) unpinned.add(`${use.repository}@${use.ref}`);
  }

  const invalid = [];
  for (const [key, pin] of seen) {
    const response = await fetch(`${apiUrl}/repos/${pin.repository}/commits/${pin.sha}`, { headers });
    if (response.ok) {
      console.log(`ok       ${key}`);
    } else {
      invalid.push(`${key} (${response.status}) in ${[...pin.files].join(', ')}`);
      console.error(`INVALID  ${key} -> HTTP ${response.status}`);
    }
  }

  if (unpinned.size > 0) console.log(`\nNot pinned to a commit SHA (allowed, not verified): ${[...unpinned].join(', ')}`);

  if (invalid.length > 0) {
    console.error(`\nAction pin validation failed:\n- ${invalid.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${seen.size} pinned actions resolve.`);
  }
}
