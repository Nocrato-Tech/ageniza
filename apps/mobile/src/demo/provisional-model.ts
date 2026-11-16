import type { ContentFormat } from '@ageniza/contracts';
import type { Post } from '../product/types';

export type DemoScenario = 'content' | 'early' | 'on_track' | 'late';
export type ProvisionalInput = Pick<Post, 'format' | 'status' | 'date' | 'time' | 'caption' | 'revision' | 'tasks'>;
export type ProvisionalPrediction = {
  source: 'synthetic_demo'; asOf: string; scenario: DemoScenario; planningAt: string; simulatedPlanning: boolean;
  assumptions: { agencyPaceDays: number; clientPaceDays: number; referenceReachSource: 'synthetic_demo' };
  history: { trainingCount: number; testCount: number; samples: Array<Pick<ProvisionalObservation, 'id' | 'pendingTasks' | 'agencyDays' | 'clientDays' | 'remainingDays' | 'relativeReach'>> };
  flow: { applicability: 'estimated' | 'already_ready' | 'cancelled'; trend: 'early' | 'on_track' | 'late'; remainingDays: number; estimatedReadyAt: string; agencyDays: number; clientDays: number; pendingTasks: number };
  social: { trend: 'below' | 'typical' | 'above'; relativeReach: number; referenceReach: number; estimatedReach: number; windowDays: 7; format: ContentFormat };
};

export type ProvisionalSignals = {
  format: ContentFormat;
  pendingTasks: number;
  revisions: number;
  captionLength: number;
  agencyPaceDays: number;
  clientPaceDays: number;
};
export type ProvisionalObservation = ProvisionalSignals & {
  id: string;
  agencyDays: number;
  clientDays: number;
  remainingDays: number;
  relativeReach: number;
};
const formats: ContentFormat[] = ['image', 'carousel', 'reels', 'long_video', 'vsl'];
const complexity: Record<ContentFormat, number> = { image: 1, carousel: 1.35, reels: 1.5, long_video: 2, vsl: 2.4 };
const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1_000_000;
function validateSignals(value: ProvisionalSignals) {
  if (!formats.includes(value.format) || ![value.pendingTasks, value.revisions, value.captionLength, value.agencyPaceDays, value.clientPaceDays].every(finiteNonnegative)) throw new Error('Invalid provisional prediction signals.');
}

export function provisionalHistory(): ProvisionalObservation[] {
  let seed = 20261109;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  return Array.from({ length: 240 }, (_, index) => {
    const format = formats[index % formats.length];
    const pendingTasks = Math.floor(random() * 10);
    const revisions = Math.floor(random() * 5);
    const captionLength = Math.floor(random() * 900);
    const agencyPaceDays = 0.4 + random() * 2.8;
    const clientPaceDays = 0.3 + random() * 3.2;
    const agencyDays = 0.4 + pendingTasks * agencyPaceDays * 0.65 + complexity[format] * 0.6 + revisions * 0.3;
    const clientDays = clientPaceDays * (1 + revisions * 0.12);
    const remainingDays = agencyDays + clientDays + (random() - 0.5) * 0.3;
    const relativeReach = 0.45 + Math.min(captionLength, 600) / 600 * 0.85 + complexity[format] * 0.12 + (random() - 0.5) * 0.16;
    return { id: `synthetic-${index + 1}`, format, pendingTasks, revisions, captionLength, agencyPaceDays, clientPaceDays, agencyDays, clientDays, remainingDays, relativeReach };
  });
}

export function trainProvisionalModel(history: readonly ProvisionalObservation[]) {
  if (history.length < 5 || new Set(history.map((sample) => sample.id)).size !== history.length) throw new Error('At least five unique provisional observations are required.');
  for (const sample of history) {
    validateSignals(sample);
    if (![sample.agencyDays, sample.clientDays, sample.remainingDays, sample.relativeReach].every(finiteNonnegative)) throw new Error('Invalid provisional training labels.');
  }
  const samples = history.map((sample) => ({ ...sample }));
  const flowVector = (value: ProvisionalSignals) => [value.pendingTasks / 4, value.revisions / 4, complexity[value.format] / 2, value.agencyPaceDays, value.clientPaceDays];
  const socialVector = (value: ProvisionalSignals) => [Math.min(value.captionLength, 900) / 300];
  const neighbors = (input: ProvisionalSignals, social: boolean) => {
    const vector = social ? socialVector : flowVector;
    const current = vector(input);
    return samples.filter((sample) => !social || sample.format === input.format)
      .map((sample) => ({ sample, distance: Math.sqrt(vector(sample).reduce((sum, value, index) => sum + (value - current[index]) ** 2, 0)) }))
      .sort((left, right) => left.distance - right.distance || left.sample.id.localeCompare(right.sample.id)).slice(0, 5);
  };
  return {
    trainingCount: samples.length,
    trainingIds: samples.map((sample) => sample.id),
    predict(input: ProvisionalSignals) {
      validateSignals(input);
      const flow = neighbors(input, false);
      const social = neighbors(input, true);
      if (social.length < 5) throw new Error('Insufficient provisional history for this format.');
      const average = (rows: typeof flow, label: 'remainingDays' | 'agencyDays' | 'clientDays' | 'relativeReach') => {
        const weight = (distance: number) => 1 / (0.01 + distance ** 2);
        return rows.reduce((sum, row) => sum + row.sample[label] * weight(row.distance), 0) / rows.reduce((sum, row) => sum + weight(row.distance), 0);
      };
      return {
        remainingDays: average(flow, 'remainingDays'), agencyDays: average(flow, 'agencyDays'), clientDays: average(flow, 'clientDays'),
        relativeReach: average(social, 'relativeReach'), neighborIds: flow.map((row) => row.sample.id), socialNeighborIds: social.map((row) => row.sample.id)
      };
    }
  };
}

const day = 86_400_000;
const synthetic = provisionalHistory();
const training = synthetic.slice(0, 192);
const fitted = trainProvisionalModel(training);
const referenceReach: Record<ContentFormat, number> = { image: 1800, carousel: 2400, reels: 4200, long_video: 1600, vsl: 1200 };
const localDay = (date: Date) => Math.floor((date.getTime() - 3 * 3_600_000) / day);

export function predictProvisionalContent(post: ProvisionalInput, scenario: DemoScenario = 'content', now: Date = new Date()): ProvisionalPrediction {
  const profiles = {
    content: { pendingTasks: post.tasks.filter((task) => task.status !== 'approved').length, agencyPaceDays: 1.4, clientPaceDays: 1.7 },
    early: { pendingTasks: 1, agencyPaceDays: 0.5, clientPaceDays: 0.5 },
    on_track: { pendingTasks: 4, agencyPaceDays: 1.4, clientPaceDays: 1.7 },
    late: { pendingTasks: 8, agencyPaceDays: 2.8, clientPaceDays: 3.2 }
  };
  const profile = profiles[scenario];
  const signals: ProvisionalSignals = { ...profile, format: post.format, revisions: scenario === 'content' ? post.revision - 1 : 1, captionLength: post.caption.length };
  const prediction = fitted.predict(signals);
  const time = post.time || '23:59';
  const planning = scenario === 'content' ? new Date(`${post.date}T${time.length === 5 ? `${time}:00` : time}-03:00`) : new Date(now.getTime() + 7 * day);
  const applicability = scenario !== 'content' ? 'estimated' : post.status === 'cancelled' ? 'cancelled' : ['approved', 'published'].includes(post.status) ? 'already_ready' : 'estimated';
  const clientOnly = scenario === 'content' && post.status === 'awaiting_approval';
  const remainingDays = applicability === 'estimated' ? Math.max(0, Math.round(clientOnly ? prediction.clientDays : prediction.remainingDays)) : 0;
  const ready = new Date(now.getTime() + remainingDays * day);
  const delta = localDay(ready) - localDay(planning);
  return {
    source: 'synthetic_demo', asOf: now.toISOString(), scenario, planningAt: planning.toISOString(), simulatedPlanning: scenario !== 'content',
    assumptions: { agencyPaceDays: profile.agencyPaceDays, clientPaceDays: profile.clientPaceDays, referenceReachSource: 'synthetic_demo' },
    history: { trainingCount: training.length, testCount: synthetic.length - training.length, samples: training.slice(0, 5).map(({ id, pendingTasks, agencyDays, clientDays, remainingDays, relativeReach }) => ({ id, pendingTasks, agencyDays, clientDays, remainingDays, relativeReach })) },
    flow: { applicability, trend: delta < 0 ? 'early' : delta > 0 ? 'late' : 'on_track', remainingDays, estimatedReadyAt: ready.toISOString(), agencyDays: applicability === 'estimated' && !clientOnly ? Math.round(prediction.agencyDays) : 0, clientDays: applicability === 'estimated' ? Math.round(prediction.clientDays) : 0, pendingTasks: profile.pendingTasks },
    social: { trend: prediction.relativeReach < 0.9 ? 'below' : prediction.relativeReach > 1.1 ? 'above' : 'typical', relativeReach: prediction.relativeReach, referenceReach: referenceReach[post.format], estimatedReach: prediction.relativeReach * referenceReach[post.format], windowDays: 7, format: post.format }
  };
}
