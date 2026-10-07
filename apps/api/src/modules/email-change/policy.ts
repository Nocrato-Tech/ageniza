/** How long the link sent to the new address stays valid once the operation approves the request. */
export const EMAIL_CHANGE_LINK_TTL_HOURS = 48;
export const EMAIL_CHANGE_LINK_TTL_MINUTES = EMAIL_CHANGE_LINK_TTL_HOURS * 60;

/**
 * Per signed-in account, not per IP: the route checks the current password, so the ceiling has to
 * follow the account whoever the caller is, or a stolen session could guess it from many addresses.
 */
export const EMAIL_CHANGE_REQUEST_RATE_LIMIT = { max: 5, windowMs: 60 * 60 * 1_000 } as const;

/** Per IP: the link token is 256 random bits, so this only bounds noise on a public route. */
export const EMAIL_CHANGE_CONFIRM_RATE_LIMIT = { max: 20, windowMs: 15 * 60 * 1_000 } as const;
