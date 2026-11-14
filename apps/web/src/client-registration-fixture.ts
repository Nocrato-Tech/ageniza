/** The day every fixture client was registered: a fixed one, so a screen that prints "cliente desde" prints the same text on any run. */
export const CLIENT_CREATED_AT = '2026-09-02T12:00:00.000Z';

/** What the API returns on every registered client beyond the fields a test names (decision 2026-11-11): its city and the day it was created. */
export const clientRegistrationExtras = { city: null, createdAt: CLIENT_CREATED_AT } as const;

export interface PersonaProfileFixture {
  age: number | null;
  occupation: string | null;
  location: string | null;
  traits: string[];
  whereTheyAre: string | null;
  toneThatWorks: string | null;
}

/** The profile of a persona that never filled it: the API answers `null` for each field and an empty list for the traits. */
export const emptyPersonaProfile = (): PersonaProfileFixture => ({
  age: null, occupation: null, location: null, traits: [], whereTheyAre: null, toneThatWorks: null
});
