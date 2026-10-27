/**
 * An address kept in the browser (session storage, router state) is followed only when it is an address of this app: it starts
 * with one slash, is not protocol-relative (`//host`) and has no backslash, which browsers read as a slash. Anything else is
 * not followed.
 */
export const ownPathOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : null;
