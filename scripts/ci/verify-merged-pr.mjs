// GitHub Free cannot enforce branch protection on this private repository, so workflows
// verify instead that a pushed commit is the merge result of a pull request.
const headMatches = (ref, patterns) =>
  patterns.some((pattern) => (pattern.endsWith('*') ? ref.startsWith(pattern.slice(0, -1)) : ref === pattern));

export const isMergedPullRequestCommit = (pulls, { sha, base, heads = ['*'] }) =>
  Array.isArray(pulls) &&
  pulls.some(
    (pull) =>
      pull?.merged_at != null &&
      pull.merge_commit_sha === sha &&
      pull.base?.ref === base &&
      typeof pull.head?.ref === 'string' &&
      headMatches(pull.head.ref, heads)
  );

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const fetchAssociatedPulls = async ({ apiUrl, repository, sha, token }) => {
  const response = await fetch(`${apiUrl}/repos/${repository}/commits/${sha}/pulls`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for commit ${sha}.`);
  return response.json();
};

if (process.argv[1] && new URL(`file:${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url) {
  const sha = argument('--sha');
  const base = argument('--base');
  const heads = (argument('--heads') ?? '*').split(',').map((head) => head.trim()).filter(Boolean);
  const { GITHUB_API_URL: apiUrl = 'https://api.github.com', GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env;
  try {
    if (!sha || !base) throw new Error('--sha and --base are required.');
    if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
    let accepted = false;
    // The pull request association of a merge commit can lag the push by a few seconds.
    for (let attempt = 1; attempt <= 4 && !accepted; attempt += 1) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 10_000));
      accepted = isMergedPullRequestCommit(await fetchAssociatedPulls({ apiUrl, repository, sha, token }), { sha, base, heads });
    }
    if (!accepted) throw new Error(`${sha} on ${base} is not the merge commit of a pull request from ${heads.join(' or ')}.`);
    console.log(`${sha} on ${base} came from a merged pull request.`);
  } catch (error) {
    console.error(`Merged pull request check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
