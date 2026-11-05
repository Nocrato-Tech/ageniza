export type Signals = { days: number; pending: number; revisions: number };
export type Observation = Signals & { id: number; late: boolean };

export function syntheticHistory(): Observation[] {
  let seed = 20261105;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  return Array.from({ length: 96 }, (_, index) => {
    const days = Math.floor(random() * 15);
    const pending = Math.floor(random() * 11);
    const revisions = Math.floor(random() * 6);
    const pressure = pending / 10 * 0.65 + revisions / 5 * 0.25 + (14 - days) / 14 * 0.4;
    return { id: index + 1, days, pending, revisions, late: pressure + (random() - 0.5) * 0.16 > 0.65 };
  });
}

const vector = (value: Signals) => [value.days / 14, value.pending / 10, value.revisions / 5];
export function train(history: readonly Observation[]) {
  if (history.length < 5) throw new Error('At least five observations are required.');
  const samples = history.map((value) => ({ ...value }));
  return {
    predict(input: Signals) {
      if (!Number.isInteger(input.days) || input.days < 0 || input.days > 14 || !Number.isInteger(input.pending) || input.pending < 0 || input.pending > 10 || !Number.isInteger(input.revisions) || input.revisions < 0 || input.revisions > 5) throw new Error('Invalid prediction signals.');
      const current = vector(input);
      const neighbors = samples.map((sample) => ({ ...sample, distance: Math.sqrt(vector(sample).reduce((sum, value, index) => sum + (value - current[index]) ** 2, 0)) })).sort((a, b) => a.distance - b.distance || a.id - b.id).slice(0, 5);
      const lateVotes = neighbors.filter((value) => value.late).length;
      return { late: lateVotes >= 3, lateVotes, neighbors };
    }
  };
}

export function presentationModel() {
  const history = syntheticHistory();
  const training = history.slice(0, 72);
  const heldOut = history.slice(72);
  const model = train(training);
  const correct = heldOut.filter((sample) => model.predict(sample).late === sample.late).length;
  return { model, training, heldOut, correct, accuracy: correct / heldOut.length };
}
