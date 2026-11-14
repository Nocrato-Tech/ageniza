import { describe, expect, it } from 'vitest';

import { cardDataSnapshot } from './test-support/card-data-snapshot.js';

// What may be kept of a card (decision 2026-11-11): the last four digits, the expiry and the brand `test`, in `agency_test_cards` and nowhere else.
// This evidence is about everywhere else (the charges, the subscription, the audit): nothing that looks like a card may show up there.
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

describe('the audit event of saving a test card', () => {
  it('is the one name allowed to carry the word, and only as an action', () => {
    expect(cardDataSnapshot([{ action: 'subscription.test_card_saved', target_type: 'agency' }])).not.toMatch(forbidden);
  });

  it.each([
    { action: 'subscription.test_card_saved', last4: '4242', note: 'card' },
    { action: 'subscription.test_card_saved', target_type: 'card' },
    { action: 'subscription.card_saved' },
    { action: 'subscription.test_card_saved_with_number' },
    { note: 'subscription.test_card_saved 4111' },
    { number: '4111111111111111', action: 'subscription.test_card_saved' }
  ])('still exposes card data next to it, or an action that is not that one: %j', (value) => {
    expect(cardDataSnapshot(value)).toMatch(forbidden);
  });
});
