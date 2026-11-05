const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Generated identifiers can contain the forbidden card prefix by chance, including inside provider references.
export const cardDataSnapshot = (value: unknown): string => JSON.stringify(value).replace(uuid, '[uuid]');
