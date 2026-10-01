import type { Context } from '@ageniza/contracts';

/** Stable identity of a context, used as a list key and for the highlighted comparison. */
export const contextKey = (context: Context): string =>
  context.type === 'agency' ? `agency:${context.agencyId}` : `client:${context.clientId}`;

/** The context's own name: the agency name, or the client's name in the portal. */
export const contextTitle = (context: Context): string =>
  context.type === 'agency' ? context.agencyName : context.clientName;

// The two kinds are different products, so the distinction is the item's second line (specs/auth.md
// section 7): role for an agency, owning agency for a client portal. The /contextos screen and the
// account-menu switcher show the same thing, in different spaces.
export const contextDescription = (context: Context): string =>
  context.type === 'agency' ? `Área da agência · ${context.roleName}` : `Portal do cliente · ${context.agencyName}`;
