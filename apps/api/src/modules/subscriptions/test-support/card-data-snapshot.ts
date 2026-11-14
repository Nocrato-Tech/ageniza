const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// The one audit action allowed to carry the word: it records that a test card was saved, with the agency as its target and none of its values.
const testCardSavedAction = /"subscription\.test_card_saved"/g;

// Generated identifiers can contain the forbidden card prefix by chance, including inside provider references.
export const cardDataSnapshot = (value: unknown): string => JSON.stringify(value).replace(uuid, '[uuid]').replace(testCardSavedAction, '"[saved-action]"');
