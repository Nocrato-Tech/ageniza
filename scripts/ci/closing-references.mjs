// GitHub closes a referenced issue only when the pull request lands on the *default* branch, which
// here is `main`. Every working pull request targets `develop`, so `Closes #123` never fires and a
// finished task stays open until a release weeks later -- long enough for the board to stop being
// trusted. This extracts the references so a workflow can close them on merge into `develop`.

// Both languages on purpose: code and commits are English, pull request bodies are Portuguese.
const keywords = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved', 'fecha', 'fecham', 'encerra', 'encerram'];
const reference = new RegExp(String.raw`\b(?:${keywords.join('|')})\b[:\s]+#(\d{1,7})\b`, 'giu');

/**
 * Issue numbers a pull request body says it closes, in order of first appearance and without
 * repeats. A number inside a fenced code block is ignored: examples in documentation are not intent.
 */
export const collectClosingReferences = (body) => {
  if (typeof body !== 'string' || body.length === 0) return [];
  const withoutFences = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const found = [];
  for (const [, number] of withoutFences.matchAll(reference)) {
    const parsed = Number(number);
    if (parsed > 0 && !found.includes(parsed)) found.push(parsed);
  }
  return found;
};

const isDirectRun = () => process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isDirectRun()) {
  // The body arrives through the environment, never as an argument: a pull request body is
  // attacker-controlled text and must not reach a shell as code.
  const numbers = collectClosingReferences(process.env.PULL_REQUEST_BODY);
  process.stdout.write(numbers.join('\n'));
}
