import { describe, expect, it } from 'vitest';

import { cardDataSnapshot } from './test-support/card-data-snapshot.js';

const forbidden = /4111|card|cart/i;
const identifier = '021f6146-ddcd-4111-90b7-d179d9e747e2';

describe('card-data evidence excludes generated UUIDs only', () => {
  it('does not mistake actor IDs or simulated provider references for card data', () => {
    expect(cardDataSnapshot({ requested_by_user_id: identifier, actor_user_id: identifier.toUpperCase(), provider_ref: `sim:${identifier}` })).not.toMatch(forbidden);
  });

  it.each([
    { number: '4111111111111111' },
    { prefix: '4111' },
    { metadata: { card: identifier } },
    { cartao: identifier },
    { reference: `sim:${identifier}:4111` },
    { prefix: '4111-not-a-uuid' }
  ])('still exposes forbidden card data and fields: %j', (value) => {
    expect(cardDataSnapshot(value)).toMatch(forbidden);
  });
});
