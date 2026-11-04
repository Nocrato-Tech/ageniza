import type { Post } from './types';

// Synthetic observations are restricted to the demonstrator, never production predictions.
const observations = [
  { x: [1, 0, 0], late: 0 }, { x: [0.8, 0, 0], late: 0 }, { x: [0.7, 0.2, 0], late: 0 },
  { x: [0.5, 0.3, 0.1], late: 0 }, { x: [0.1, 0.9, 0.5], late: 1 }, { x: [0.05, 1, 1], late: 1 },
  { x: [0.2, 0.8, 0.6], late: 1 }, { x: [0.3, 0.6, 0.7], late: 1 }, { x: [0.4, 0.3, 0], late: 0 },
  { x: [0.1, 0.6, 0.8], late: 1 }, { x: [0.9, 0.8, 0], late: 0 }, { x: [0.15, 0.7, 0.6], late: 1 }
];
export function estimate(post: Post, today: string) {
  const remaining = Math.max(0, Math.min(1, (Date.parse(`${post.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000 / 14));
  const pending = post.tasks.length ? post.tasks.filter((task) => task.status !== 'approved').length / post.tasks.length : post.mediaIds.length ? 0 : 1;
  const revisions = Math.min(1, post.comments.filter((comment) => comment.side === 'client').length / 3);
  const x = [remaining, pending, revisions];
  const neighbors = observations.map((item) => ({ late: item.late, distance: item.x.reduce((sum, value, index) => sum + (value - x[index]) ** 2, 0) })).sort((a, b) => a.distance - b.distance).slice(0, 3);
  const votes = neighbors.reduce((sum, item) => sum + item.late, 0);
  return { risk: votes >= 2 ? 'Risco elevado' : 'Risco moderado', votes, pending: post.tasks.filter((task) => task.status !== 'approved').length, remainingDays: Math.round(remaining * 14) };
}
