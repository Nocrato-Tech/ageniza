import { describe, expect, it } from 'vitest';
import { flowModel, syntheticHistory, train } from './model';

describe('synthetic model for the academic presentation', () => {
  it('keeps the holdout separate and predicts contrasting operational scenarios', () => {
    const result = flowModel();
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
    const model = flowModel().model;
    for (const input of [{ days: NaN, pending: 1, revisions: 1 }, { days: 15, pending: 1, revisions: 1 }, { days: 1, pending: -1, revisions: 1 }, { days: 1, pending: 1, revisions: 6 }]) expect(() => model.predict(input)).toThrow();
  });
});
