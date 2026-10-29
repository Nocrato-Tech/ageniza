/**
 * The native app has no web origin: it identifies itself by the scheme of its deep links (`ageniza://`). The scheme list
 * comes from `MOBILE_APP_ORIGINS` and is empty unless the environment opted in, in which case nothing here matches.
 */
export type MobileAppOrigins = readonly string[];

const ORIGIN_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/\/?$/i;

/** `ageniza://` for what an app sends as its origin (`ageniza://` or Expo's `ageniza:///`); undefined for anything else. */
export const mobileAppOriginOf = (value: string, allowed: MobileAppOrigins): string | undefined => {
  const match = ORIGIN_PATTERN.exec(value);
  if (match === null) return undefined;
  const origin = `${match[1]!.toLowerCase()}://`;
  return allowed.includes(origin) ? origin : undefined;
};

/**
 * A deep link the app asked to be sent back to, valid only when its scheme is listed. Anything that is not a plain
 * link (credentials, a fragment, a web scheme) is refused, so this can never become an open redirect to a website.
 */
export const mobileAppRedirectOf = (value: string, allowed: MobileAppOrigins): URL | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!allowed.includes(`${url.protocol}//`) || url.username !== '' || url.password !== '' || url.hash !== '' || value.includes('#')) return undefined;
  return url;
};
