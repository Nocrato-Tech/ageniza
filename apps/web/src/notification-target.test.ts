import { describe, expect, it } from 'vitest';

import { notificationPath } from './notification-target.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

describe('notificationPath', () => {
  it('opens a content on the calendar of its client', () => {
    expect(notificationPath(AGENCY, { type: 'content', clientId: CLIENT, contentId: OTHER })).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT}/${OTHER}`);
  });

  it('opens the Visão geral of the client for a request for material', () => {
    expect(notificationPath(AGENCY, { type: 'material-request', clientId: CLIENT, threadId: OTHER })).toBe(`/agencia/${AGENCY}/clientes/${CLIENT}/geral`);
  });

  it('opens the Equipe for an accepted invitation', () => {
    expect(notificationPath(AGENCY, { type: 'collaborators' })).toBe(`/agencia/${AGENCY}/colaboradores`);
  });
});
