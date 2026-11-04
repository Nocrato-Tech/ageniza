import type { FastifyInstance } from 'fastify';

import { HttpError } from '@ageniza/core';

/**
 * The deepest nesting of lists and objects a JSON request body may have. The contracts nest four levels at most.
 *
 * `JSON.parse` of a body of `[[[[...` allocates one list per byte and keeps all of it alive until the handler finishes, which on a
 * route that first waits for the session is long enough for a few requests of 1 MiB to exhaust a container. The body is refused
 * by a linear scan of its text, before it is parsed.
 */
export const MAX_JSON_NESTING = 64;

/**
 * The most lists and objects a JSON request body may hold in total. The largest legitimate body is the completion of a multipart
 * upload: 10 000 parts, each an object, in a list inside the root object, which is 10 002; the rest is margin.
 */
export const MAX_JSON_CONTAINERS = 10_100;

/**
 * The most commas and colons outside strings a JSON request body may hold: one per value and one per key, which is what `JSON.parse`
 * allocates for when the body is a single object of a million keys (`{"0":1.5,"1":1.5,...}`), invisible to the limit of containers.
 * The largest legitimate body is again the completion of 10 000 parts. Each part is `{"partNumber":1,"eTag":"..."}`: two colons and
 * one comma inside it, one comma after it (but the last), 4 per part less one, plus the colon of `"parts"` at the root: 40 000 in all; the rest is margin.
 */
export const MAX_JSON_SEPARATORS = 40_100;

const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const QUOTE = 34;
const BACKSLASH = 92;
const COMMA = 44;
const COLON = 58;

const tooBig = (message: string): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: '', code: 'too_big', message }] }
});

/**
 * Reads the text of a JSON body once, without allocating, and names the first limit it goes past. Brackets inside a string, an
 * escaped quote and an escaped backslash before the closing quote are not structure. Text that is not JSON passes: the parser says so.
 */
export const findJsonOverreach = (text: string): HttpError | undefined => {
  let depth = 0;
  let containers = 0;
  let separators = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === BACKSLASH) escaped = true;
      else if (code === QUOTE) inString = false;
    } else if (code === QUOTE) {
      inString = true;
    } else if (code === OPEN_BRACKET || code === OPEN_BRACE) {
      depth += 1;
      containers += 1;
      if (depth > MAX_JSON_NESTING) return tooBig(`Nesting must be at most ${MAX_JSON_NESTING} levels`);
      if (containers > MAX_JSON_CONTAINERS) return tooBig(`The body must have at most ${MAX_JSON_CONTAINERS} lists and objects`);
    } else if (code === COMMA || code === COLON) {
      separators += 1;
      if (separators > MAX_JSON_SEPARATORS) return tooBig(`The body must have at most ${MAX_JSON_SEPARATORS} values and keys`);
    } else if ((code === CLOSE_BRACKET || code === CLOSE_BRACE) && depth > 0) {
      depth -= 1;
    }
  }
  return undefined;
};

/**
 * Replaces Fastify's JSON parser by one that scans the text first and then hands it to Fastify's own default parser, so the empty
 * body, the invalid JSON and the `__proto__`/`constructor` poisoning (both refused, as in Fastify's defaults) answer as before.
 * The body limit stays Fastify's, per route.
 */
export const registerBoundedJsonParser = (app: FastifyInstance): void => {
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const overreach = findJsonOverreach(body as string);
    if (overreach !== undefined) {
      done(overreach, undefined);
      return;
    }
    parseJson(request, body as string, done);
  });
};
