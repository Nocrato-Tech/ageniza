import { describe, expect, it } from 'vitest';
import { predictProvisionalContent, provisionalHistory, trainProvisionalModel, type ProvisionalInput } from './provisional-model';

const now = new Date('2026-11-09T12:00:00Z');
const post: ProvisionalInput = { format: 'image', status: 'in_production', date: '2026-11-16', time: '09:00', caption: 'Exemplo da agência', revision: 1, tasks: [] };

describe('provisional demonstration models', () => {
  it('trains deterministically on a separate historical partition', () => {
    const history = provisionalHistory();
    expect(history).toEqual(provisionalHistory());
    expect(history).toHaveLength(240);
    const model = trainProvisionalModel(history.slice(0, 192));
    expect(model.trainingCount).toBe(192);
    expect(history.slice(192).every((sample) => !model.trainingIds.includes(sample.id))).toBe(true);
  });
  it('learns both targets from copied training labels and never includes held-out rows', () => {
    const samples = provisionalHistory().slice(0, 192);
    const input = samples[0];
    const model = trainProvisionalModel(samples);
    const original = model.predict(input);
    samples.forEach((sample) => { sample.remainingDays += 20; sample.relativeReach += 3; });
    expect(model.predict(input)).toEqual(original);
    const changed = trainProvisionalModel(samples).predict(input);
    expect(changed.remainingDays - original.remainingDays).toBeCloseTo(20);
    expect(changed.relativeReach - original.relativeReach).toBeCloseTo(3);
    expect(model.predict(provisionalHistory()[239]).neighborIds.every((id) => model.trainingIds.includes(id))).toBe(true);
    expect(original.socialNeighborIds.every((id) => samples.find((sample) => sample.id === id)?.format === input.format)).toBe(true);
  });
  it('exposes provisional assumptions and computes all three scenarios against an explicit seven-day plan', () => {
    const outputs = (['early', 'on_track', 'late'] as const).map((scenario) => predictProvisionalContent(post, scenario, now));
    expect(outputs.map((output) => output.flow.trend)).toEqual(['early', 'on_track', 'late']);
    for (const output of outputs) {
      expect(output.source).toBe('synthetic_demo');
      expect(output.asOf).toBe(now.toISOString());
      expect(output.planningAt).toBe('2026-11-16T12:00:00.000Z');
      expect(output.simulatedPlanning).toBe(true);
      expect(output.history.trainingCount).toBe(192);
      expect(output.history.testCount).toBe(48);
      expect(output.assumptions.referenceReachSource).toBe('synthetic_demo');
      expect(Number.isFinite(output.flow.remainingDays)).toBe(true);
      expect(output.social.windowDays).toBe(7);
      expect(output.social.format).toBe(post.format);
    }
    expect(outputs[0].flow.remainingDays).toBeLessThan(outputs[1].flow.remainingDays);
    expect(outputs[1].flow.remainingDays).toBeLessThan(outputs[2].flow.remainingDays);
  });
  it('rejects unusable training sets, corrupt labels and non-finite signals', () => {
    expect(() => trainProvisionalModel([])).toThrow();
    const history = provisionalHistory().slice(0, 192);
    expect(() => trainProvisionalModel([...history, { ...history[0], id: 'corrupt', remainingDays: NaN }])).toThrow();
    expect(() => trainProvisionalModel([...history, history[0]])).toThrow();
    const model = trainProvisionalModel(history);
    for (const signals of [{ ...history[0], pendingTasks: -1 }, { ...history[0], agencyPaceDays: Infinity }, { ...history[0], clientPaceDays: NaN }]) expect(() => model.predict(signals)).toThrow();
  });
  it('uses the current content without mutating it and treats completed or client-only stages explicitly', () => {
    const busy: ProvisionalInput = { ...post, tasks: Array.from({ length: 8 }, (_, index) => ({ id: String(index), title: 'Tarefa', assigneeId: 'demo', dueOn: post.date, status: 'pending' })) };
    const before = JSON.stringify(busy);
    const quiet = predictProvisionalContent(post, 'content', now);
    const loaded = predictProvisionalContent(busy, 'content', now);
    expect(loaded.flow.remainingDays).toBeGreaterThan(quiet.flow.remainingDays);
    expect(loaded.flow.pendingTasks).toBe(8);
    expect(loaded.simulatedPlanning).toBe(false);
    expect(loaded.planningAt).toBe('2026-11-16T12:00:00.000Z');
    expect(predictProvisionalContent({ ...busy, date: '2026-11-10' }, 'content', now).flow.trend).toBe('late');
    expect(predictProvisionalContent({ ...busy, date: '2026-12-10' }, 'content', now).flow.trend).toBe('early');
    expect(JSON.stringify(busy)).toBe(before);
    for (const status of ['approved', 'published'] as const) {
      const ready = predictProvisionalContent({ ...busy, status }, 'content', now);
      expect(ready.flow.applicability).toBe('already_ready');
      expect(ready.flow.remainingDays).toBe(0);
    }
    expect(predictProvisionalContent({ ...busy, status: 'cancelled' }, 'content', now).flow.applicability).toBe('cancelled');
    const awaiting = predictProvisionalContent({ ...busy, status: 'awaiting_approval' }, 'content', now);
    expect(awaiting.flow.agencyDays).toBe(0);
    expect(awaiting.flow.remainingDays).toBe(awaiting.flow.clientDays);
    expect(predictProvisionalContent({ ...busy, status: 'cancelled' }, 'late', now).flow.applicability).toBe('estimated');
  });
  it('keeps finite social forecasts responsive to the caption for every format and accepts stored time seconds', () => {
    for (const format of ['image', 'carousel', 'reels', 'long_video', 'vsl'] as const) {
      const short = predictProvisionalContent({ ...post, format, caption: '', time: '09:00:00' }, 'content', now);
      const long = predictProvisionalContent({ ...post, format, caption: 'Conteúdo demonstrativo '.repeat(40) }, 'content', now);
      expect(long.social.relativeReach).toBeGreaterThan(short.social.relativeReach);
      expect(short.social.trend).toBe('below');
      expect(long.social.trend).toBe('above');
      for (const value of [short, long]) {
        expect(value.social.estimatedReach).toBeCloseTo(value.social.referenceReach * value.social.relativeReach);
        expect([value.social.relativeReach, value.social.referenceReach, value.social.estimatedReach, value.flow.remainingDays, value.flow.agencyDays, value.flow.clientDays].every(Number.isFinite)).toBe(true);
      }
    }
  });
  it('retains three scenario trends across content formats and times of day', () => {
    for (const format of ['image', 'carousel', 'reels', 'long_video', 'vsl'] as const) {
      for (const hour of [4, 12, 23]) {
        const instant = new Date(`2026-11-09T${String(hour).padStart(2, '0')}:00:00Z`);
        const predictions = (['early', 'on_track', 'late'] as const).map((scenario) => predictProvisionalContent({ ...post, format }, scenario, instant));
        expect(predictions.map((value) => value.flow.trend), `${format} ${hour}: ${predictions.map((value) => value.flow.remainingDays)}`).toEqual(['early', 'on_track', 'late']);
      }
    }
  });
});
