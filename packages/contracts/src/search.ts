import { z } from 'zod';

/** Longest free-text filter a listing accepts before a route tightens it further. */
export const SEARCH_TEXT_MAX_LENGTH = 320;

/**
 * Free-text filter of a listing: trimmed, never empty, capped, and free of control characters
 * (U+0000-U+001F and U+007F). A NUL byte reaches the driver fine as a JavaScript string but the
 * PostgreSQL backend rejects the parameter (`invalid byte sequence for encoding "UTF8": 0x00`,
 * 22021), turning a filter into a 500 with a logged error. Rejecting control characters here, as
 * 400, is the one shared rule every current and future listing reuses (issue #95 security review).
 *
 * The schema is a plain `ZodString`, so a route may still tighten the length with `.max(...)`.
 */
export const SearchTextSchema = z.string()
  .trim()
  .min(1)
  .max(SEARCH_TEXT_MAX_LENGTH)
  // eslint-disable-next-line no-control-regex -- the control range is exactly what this rule rejects
  .regex(/^[^\u0000-\u001F\u007F]*$/, 'Search text cannot contain control characters');
