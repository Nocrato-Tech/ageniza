import { describe, expect, it } from 'vitest';

import { forbidden, notificationNotFound, translateDatabaseError } from './errors.js';

const raised = (code: string): Error => Object.assign(new Error('internal detail of the database'), { code });

describe('translateDatabaseError', () => {
  it.each([['40P01'], ['40001']])('answers a lost race (%s) with "try again", 409', (code) => {
    expect(translateDatabaseError(raised(code))).toMatchObject({ statusCode: 409, code: 'TRY_AGAIN' });
  });

  it('answers the refusal of the database barrier (42501) with the 403 of the guard', () => {
    expect(translateDatabaseError(raised('42501'))).toEqual(forbidden());
    expect(forbidden()).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it.each([['22P02'], ['A0042'], ['A0001'], ['A0099']])('answers %s with the 404 of a notification that is not there', (code) => {
    expect(translateDatabaseError(raised(code))).toEqual(notificationNotFound());
    expect(notificationNotFound()).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: 'Notification not found.' });
  });

  it.each([['A0090'], ['A0091'], ['A0092'], ['A0095']])('leaves the refusal of the plan (%s) to the global handler, which has its own answer', (code) => {
    expect(translateDatabaseError(raised(code))).toBeUndefined();
  });

  it.each([['XX000'], ['23505'], ['A0100'], ['B0001']])('does not invent an answer for %s: it stays an unexpected error', (code) => {
    expect(translateDatabaseError(raised(code))).toBeUndefined();
  });

  it.each([[new Error('no code')], [undefined], [null], ['text'], [{ code: undefined }]])('ignores what carries no SQLSTATE, %j', (error) => {
    expect(translateDatabaseError(error)).toBeUndefined();
  });

  it('never carries the detail of the database into the answer', () => {
    for (const code of ['40P01', '42501', '22P02', 'A0042']) {
      expect(JSON.stringify(translateDatabaseError(raised(code))?.message)).not.toContain('internal detail');
    }
  });
});
