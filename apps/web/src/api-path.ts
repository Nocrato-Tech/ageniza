/**
 * Builds an API path from a template and its values. Every value is percent-encoded as a single
 * path segment, and empty, `.` and `..` are refused outright: `encodeURIComponent('..')` is still
 * `..`, which the URL parser would resolve as a parent segment. Screens use this instead of
 * interpolating a route parameter by hand (security review of PR #190).
 */
const placeholderPattern = /:([A-Za-z0-9_]+)/g;

export const apiPath = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(placeholderPattern, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value.length === 0) throw new Error(`apiPath requires a value for :${name}.`);
    if (value === '.' || value === '..') throw new Error(`apiPath refuses a relative value for :${name}.`);
    return encodeURIComponent(value);
  });
