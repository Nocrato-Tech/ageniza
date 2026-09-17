import { describe, expect, it } from 'vitest';

import { normalizeRateLimitIp } from './rate-limit-ip.js';

describe('normalizeRateLimitIp (B7)', () => {
  it('leaves IPv4 addresses unchanged', () => {
    expect(normalizeRateLimitIp('203.0.113.10')).toBe('203.0.113.10');
    expect(normalizeRateLimitIp('127.0.0.1')).toBe('127.0.0.1');
  });

  it('maps IPv4-mapped IPv6 addresses to the plain IPv4 address', () => {
    expect(normalizeRateLimitIp('::ffff:203.0.113.10')).toBe('203.0.113.10');
    expect(normalizeRateLimitIp('::FFFF:203.0.113.10')).toBe('203.0.113.10');
  });

  it('collapses IPv6 addresses to their /64 prefix', () => {
    expect(normalizeRateLimitIp('2001:db8:1234:5678:abcd:ef01:2345:6789')).toBe('2001:db8:1234:5678::/64');
    expect(normalizeRateLimitIp('2001:db8:1234:5678::1')).toBe('2001:db8:1234:5678::/64');
  });

  it('treats two addresses in the same /64 as the same bucket', () => {
    const first = normalizeRateLimitIp('2001:db8:1234:5678::1');
    const second = normalizeRateLimitIp('2001:db8:1234:5678:ffff:ffff:ffff:ffff');
    expect(first).toBe(second);
  });

  it('treats addresses in different /64s as different buckets', () => {
    const first = normalizeRateLimitIp('2001:db8:1234:5678::1');
    const second = normalizeRateLimitIp('2001:db8:1234:5679::1');
    expect(first).not.toBe(second);
  });

  it('handles the unspecified and loopback IPv6 addresses', () => {
    expect(normalizeRateLimitIp('::1')).toBe('0:0:0:0::/64');
    expect(normalizeRateLimitIp('::')).toBe('0:0:0:0::/64');
  });

  it('strips a zone id before collapsing', () => {
    expect(normalizeRateLimitIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });
});
