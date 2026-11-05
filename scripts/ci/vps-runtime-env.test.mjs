import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { functionsOf, posix, preamble, removeTemporaryDirectories, run, temporaryDirectory } from './vps-bash-harness.mjs';

// The validator of each entrypoint has a closed list of keys. The example file is what the operator copies, so the real example
// goes through the real validator: a key added to the example and left out of the list would kill the next deploy.
afterEach(removeTemporaryDirectories);

const root = join(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
// Checked out with CRLF on Windows, where bash would read the carriage return as part of the value: the files are LF in the repository.
const lf = (text) => text.replaceAll('\r\n', '\n');

const linesOf = (path) => lf(read(path)).split('\n').filter((line) => line !== '' && !line.startsWith('#'));

const productionScript = lf(read('infra/vps/ageniza-deploy.sh'));
const devScript = lf(read('infra/vps/ageniza-deploy-dev.sh'));
const devDomain = lf(devScript).split('\n').find((line) => line.startsWith('readonly DEV_DOMAIN='));

const validator = (script, extra = '') => (lines) => {
  const file = join(temporaryDirectory(), 'runtime.env');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return run(`${preamble}${extra}\nRUNTIME_ENV="${posix(file)}"\nrequire_root_file() { :; }\n${functionsOf(script, 'die', 'read_value', 'validate_runtime_env')}\nvalidate_runtime_env`);
};

describe.each([
  ['production', productionScript, 'infra/vps/runtime.env.example', ''],
  ['dev', devScript, 'infra/vps/dev-runtime.env.example', devDomain]
])('the %s entrypoint takes the media processing keys of its own example', (_name, script, examplePath, extra) => {
  const validate = validator(script, extra);
  const example = () => linesOf(examplePath);
  const replacing = (key, value) => example().map((line) => (line.startsWith(`${key}=`) ? `${key}=${value}` : line));

  it('accepts the committed example as it is', () => {
    const result = validate(example());
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('has the two keys that grow the timeout with the duration, in the example and in the list', () => {
    expect(example()).toContain('MEDIA_PROCESSING_TIMEOUT_PER_MEDIA_SECOND=0.5');
    expect(example()).toContain('MEDIA_PROCESSING_MAX_TIMEOUT_SECONDS=1200');
  });

  it.each(['0.5', '1', '2.25', '0'])('accepts MEDIA_PROCESSING_TIMEOUT_PER_MEDIA_SECOND=%s', (value) => {
    expect(validate(replacing('MEDIA_PROCESSING_TIMEOUT_PER_MEDIA_SECOND', value)).status).toBe(0);
  });

  it.each(['', '.5', '0.', 'abc', '-1', '1e3', '0,5', '0.5.1'])('refuses MEDIA_PROCESSING_TIMEOUT_PER_MEDIA_SECOND=%j', (value) => {
    const result = validate(replacing('MEDIA_PROCESSING_TIMEOUT_PER_MEDIA_SECOND', value));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MEDIA_PROCESSING_TIMEOUT_PER_MEDIA_SECOND must be a number');
  });

  it.each(['0.5', 'abc', '', '-3'])('keeps the integer rule for MEDIA_PROCESSING_MAX_TIMEOUT_SECONDS=%j', (value) => {
    const result = validate(replacing('MEDIA_PROCESSING_MAX_TIMEOUT_SECONDS', value));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MEDIA_PROCESSING_MAX_TIMEOUT_SECONDS must be a positive integer');
  });

  it('does not take a decimal where the neighbours are integers', () => {
    expect(validate(replacing('MEDIA_PROCESSING_TIMEOUT_SECONDS', '240.5')).status).toBe(1);
  });

  it('still refuses a key nobody declared', () => {
    const result = validate([...example(), 'MEDIA_PROCESSING_SOMETHING_ELSE=1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not allowed');
  });
});
