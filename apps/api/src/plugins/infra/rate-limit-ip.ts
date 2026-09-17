/**
 * Normalizes a client IP for rate-limit bucketing (B7, partial).
 *
 * IPv4 addresses (and IPv4-mapped IPv6 addresses such as `::ffff:203.0.113.10`) are returned
 * unchanged as plain IPv4. Real IPv6 addresses are collapsed to their /64 prefix so a single
 * client that rotates addresses within its own /64 (the normal case for consumer and mobile
 * IPv6 allocations) is still counted as one bucket. This never changes any configured rate-limit
 * number, only the key the count is stored under.
 */
export const normalizeRateLimitIp = (ip: string): string => {
  const trimmed = ip.trim();

  const ipv4MappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(trimmed);
  if (ipv4MappedMatch?.[1] !== undefined) return ipv4MappedMatch[1];

  // Plain IPv4 (or anything that is not a bracketed/colon-bearing IPv6 literal): unchanged.
  if (!trimmed.includes(':')) return trimmed;

  return toIpv6Slash64(trimmed);
};

/** Expands an IPv6 address to its 8 hextets, then re-collapses to the first 4 (the /64 prefix). */
const toIpv6Slash64 = (address: string): string => {
  // Strip a zone id (`fe80::1%eth0`) and brackets (`[::1]`), neither of which affect the prefix.
  const withoutZone = address.split('%')[0] ?? address;
  const unbracketed = withoutZone.replace(/^\[/, '').replace(/\]$/, '');

  const [head, tail] = unbracketed.split('::');
  const headParts = head === undefined || head === '' ? [] : head.split(':');
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':');

  if (!unbracketed.includes('::')) {
    // Fully expanded address already: just take the first four hextets.
    const parts = unbracketed.split(':');
    return formatPrefix(parts.slice(0, 4));
  }

  const missing = 8 - (headParts.length + tailParts.length);
  const expanded = [...headParts, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tailParts];
  return formatPrefix(expanded.slice(0, 4));
};

const formatPrefix = (hextets: readonly string[]): string => {
  const normalized = Array.from({ length: 4 }, (_, index) => hextets[index] ?? '0');
  return `${normalized.map((part) => part === '' ? '0' : part).join(':')}::/64`;
};
