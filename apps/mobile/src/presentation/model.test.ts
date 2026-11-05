import { describe, expect, it } from 'vitest';
import { presentationModel, syntheticHistory, train } from './model';
import { billingReducer, initialBilling } from './billing';
import { presentationRoute } from './route';

describe('synthetic model for the academic presentation', () => {
  it('keeps the holdout separate and predicts contrasting operational scenarios', () => {
    const result = presentationModel();
    expect(syntheticHistory()).toEqual(syntheticHistory());
    expect(result.training).toHaveLength(72);
    expect(result.heldOut).toHaveLength(24);
    expect(result.heldOut.every((sample) => !result.training.some((row) => row.id === sample.id))).toBe(true);
    expect(result.model.predict({ days: 12, pending: 1, revisions: 0 }).late).toBe(false);
    expect(result.model.predict({ days: 1, pending: 9, revisions: 4 }).late).toBe(true);
    expect(result.model.predict(result.heldOut[0]).neighbors.every((sample) => sample.id <= 72)).toBe(true);
    expect(result.accuracy).toBe(result.correct / 24);
    expect(result.correct).toBeGreaterThan(12);
  });
  it('uses labels from training rather than a fixed risk rule and copies the training set', () => {
    const samples = syntheticHistory().slice(0, 5).map((sample) => ({ ...sample, late: false }));
    const model = train(samples);
    samples.forEach((sample) => { sample.late = true; });
    expect(model.predict({ days: 0, pending: 10, revisions: 5 }).lateVotes).toBe(0);
    expect(train(samples).predict({ days: 14, pending: 0, revisions: 0 }).lateVotes).toBe(5);
  });
  it('rejects insufficient training and non-finite or out-of-range controls', () => {
    expect(() => train([])).toThrow();
    const model = presentationModel().model;
    for (const input of [{ days: NaN, pending: 1, revisions: 1 }, { days: 15, pending: 1, revisions: 1 }, { days: 1, pending: -1, revisions: 1 }, { days: 1, pending: 1, revisions: 6 }]) expect(() => model.predict(input)).toThrow();
  });
});

describe('fictional billing lifecycle', () => {
  const now = '2026-11-05T10:00:00Z';
  it('does not activate a declined plan and preserves an already active subscription', () => {
    const declined = billingReducer(initialBilling, { type: 'payment', planId: 'agencia', outcome: 'declined', now });
    expect(declined.active).toBeNull();
    expect(declined.receipts[0]).toMatchObject({ id: 'DEMO-0001', status: 'declined', cents: 39700 });
    const paid = billingReducer(declined, { type: 'payment', planId: 'essencial', outcome: 'approved', now });
    const failedUpgrade = billingReducer(paid, { type: 'payment', planId: 'profissional', outcome: 'declined', now });
    expect(failedUpgrade.active).toBe('essencial');
    expect(failedUpgrade.receipts[0].id).toBe('DEMO-0003');
  });
  it('cancels and reactivates without erasing receipts or changing plan limits', () => {
    expect(billingReducer(initialBilling, { type: 'cancel' })).toBe(initialBilling);
    const paid = billingReducer(initialBilling, { type: 'payment', planId: 'profissional', outcome: 'approved', now });
    const cancelled = billingReducer(paid, { type: 'cancel' });
    expect(cancelled.active).toBe('profissional'); expect(cancelled.cancelAtEnd).toBe(true);
    expect(billingReducer(cancelled, { type: 'reactivate' })).toEqual(paid);
  });
});

it('only opens the presentation at its explicit enabled web path', () => {
  expect(presentationRoute('/apresentacao/', 'true')).toBe(true);
  expect(presentationRoute('/apresentacao', 'true')).toBe(true);
  for (const path of ['/', '/app-mobile/', '/apresentacao-extra', '/apresentacao/secret']) expect(presentationRoute(path, 'true')).toBe(false);
  expect(presentationRoute('/apresentacao/', undefined)).toBe(false);
  expect(presentationRoute('/apresentacao/', 'false')).toBe(false);
});
