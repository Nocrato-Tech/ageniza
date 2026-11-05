export const plans = [
  { id: 'essencial', name: 'Essencial', cents: 9700, clients: 10, storage: 20 },
  { id: 'profissional', name: 'Profissional', cents: 19700, clients: 30, storage: 100 },
  { id: 'agencia', name: 'Agência', cents: 39700, clients: 60, storage: 300 }
] as const;
export type PlanId = typeof plans[number]['id'];
export type Receipt = { id: string; planId: PlanId; cents: number; status: 'approved' | 'declined'; createdAt: string };
export type BillingState = { active: PlanId | null; cancelAtEnd: boolean; receipts: Receipt[]; sequence: number };
export const initialBilling: BillingState = { active: null, cancelAtEnd: false, receipts: [], sequence: 0 };
export type BillingEvent = { type: 'payment'; planId: PlanId; outcome: 'approved' | 'declined'; now: string } | { type: 'cancel' | 'reactivate' };
export function billingReducer(state: BillingState, event: BillingEvent): BillingState {
  if (event.type === 'cancel') return state.active ? { ...state, cancelAtEnd: true } : state;
  if (event.type === 'reactivate') return state.active ? { ...state, cancelAtEnd: false } : state;
  if (event.type !== 'payment') return state;
  const plan = plans.find((item) => item.id === event.planId);
  if (!plan) throw new Error('Unknown presentation plan.');
  const sequence = state.sequence + 1;
  const receipt: Receipt = { id: `DEMO-${String(sequence).padStart(4, '0')}`, planId: plan.id, cents: plan.cents, status: event.outcome, createdAt: event.now };
  return { active: event.outcome === 'approved' ? plan.id : state.active, cancelAtEnd: event.outcome === 'approved' ? false : state.cancelAtEnd, receipts: [receipt, ...state.receipts].slice(0, 20), sequence };
}
