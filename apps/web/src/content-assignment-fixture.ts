import {
  CreateContentTaskRequestSchema,
  ReturnContentTaskRequestSchema,
  UpdateContentRequestSchema,
  UpdateContentTaskRequestSchema,
  CONTENT_TASKS_MAX_PER_CONTENT
} from '@ageniza/contracts';

import { AGENCY, detailOf, failure, json, ROSTER, sessionBody, type Call, type Scenario, type Stored } from './content-modal-fixture.js';

/**
 * The people and subtasks of a content, and the routes that move them, answering as the API does (`apps/api/src/modules/contents`):
 * the three moves of a subtask are the person in charge's, a delivered subtask is judged by the owner of the content or by who holds
 * `conteudo.aprovar_pela_agencia`, a change of owner is `conteudo.aprovar_pela_agencia` too, and nothing here ever shows a user id.
 * It sits in front of the shared fake of the modal (`override`) and only answers what is about people and subtasks.
 */

export const ANA = { membershipId: 'e0e0e0e0-0000-4000-8000-000000000001', name: 'Ana Souza' };
export const BRUNO = { membershipId: 'e0e0e0e0-0000-4000-8000-000000000002', name: 'Bruno Lima' };
export const CARLA = { membershipId: 'e0e0e0e0-0000-4000-8000-000000000003', name: 'Carla Dias' };
/** A collaborator who exists but cannot be put in charge: the API refuses her with the one answer for every reason. */
export const DIOGO = { membershipId: 'e0e0e0e0-0000-4000-8000-000000000004', name: 'Diogo Reis' };
export type Person = typeof ANA;

export interface WorldTask {
  id: string;
  title: string;
  description: string | null;
  assignee: Person | null;
  dueOn: string;
  status: 'pending' | 'delivered' | 'approved';
  returnComment: string | null;
}

export interface World {
  owner: Person | null;
  tasks: WorldTask[];
  /** The next write of this kind is answered with this failure, once. */
  failNext: { match: RegExp; response: () => Response } | undefined;
  /** The creation of a subtask is refused with the limit, whatever the list says (the screen was stale). */
  refuseLimit: boolean;
  /** Holds the answer of the writes whose path matches. */
  hold: { match: RegExp; promise: Promise<void> } | undefined;
}

let sequence = 0;
export const task = (overrides: Partial<WorldTask> = {}): WorldTask => {
  sequence += 1;
  return {
    id: `b0b0b0b0-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    title: `Subtarefa ${sequence}`,
    description: null,
    assignee: ANA,
    dueOn: '2026-10-20',
    status: 'pending',
    returnComment: null,
    ...overrides
  };
};

export interface AssignmentOptions {
  readonly permissions: readonly string[];
  /** The membership of the person in the session; `null` for an owner by possession, who has no link. */
  readonly self: string | null;
  readonly owner?: Person | null;
  readonly tasks?: readonly WorldTask[];
  readonly team?: readonly Person[];
  readonly teamStatus?: number;
  /** Holds the answer of the team until it resolves. */
  readonly teamGate?: Promise<void>;
}

const VISUALIZE = 'conteudo.visualizar';
const OPERATE = 'conteudo.operar';
const APPROVE = 'conteudo.aprovar_pela_agencia';

const collaborator = (person: Person, self: string | null) => ({
  membershipId: person.membershipId, name: person.name, email: `${person.name.split(' ')[0]!.toLowerCase()}@example.test`, photoUrl: null,
  jobTitle: null, role: { key: 'custom', name: 'Papel' }, isOwner: false, isSelf: person.membershipId === self, status: 'active', joinedAt: '2026-01-01T00:00:00.000Z'
});

export const assignmentWorld = (options: AssignmentOptions) => {
  const world: World = { owner: options.owner === undefined ? ANA : options.owner, tasks: options.tasks === undefined ? [] : options.tasks.map((item) => ({ ...item })), failNext: undefined, refuseLimit: false, hold: undefined };
  const holds = (permission: string): boolean => options.permissions.includes(permission);
  const team = options.team ?? [ANA, BRUNO, CARLA];
  const invalidAssignee = (membershipId: string): boolean => ![ANA, BRUNO, CARLA].some((person) => person.membershipId === membershipId);

  const detail = (row: Stored) => ({
    ...detailOf(row),
    owner: world.owner,
    tasks: world.tasks.map((item) => ({ ...item, approvedBy: item.status === 'approved' ? { name: 'Ana Souza', side: 'agency' } : null, approvedAt: item.status === 'approved' ? '2026-10-10T12:00:00.000Z' : null }))
  });

  const override = async (call: Call, _calls: readonly Call[], rows: readonly Stored[]): Promise<Response | undefined> => {
    const path = call.path.split('?')[0]!;
    if (path.endsWith('/auth/session')) return json(sessionBody);
    if (/\/agencies\/[^/]+\/me$/.test(path)) {
      return json({ agencyId: AGENCY, agencyName: 'Agência Um', isOwner: false, role: { key: 'custom', name: 'Papel' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: options.permissions, membershipId: options.self });
    }
    if (/\/agencies\/[^/]+\/collaborators$/.test(path)) {
      if (!holds('colaborador.visualizar')) return failure(403, 'FORBIDDEN');
      await options.teamGate;
      if (options.teamStatus !== undefined) return failure(options.teamStatus, 'INTERNAL');
      return json({ data: team.map((person) => collaborator(person, options.self)), meta: { page: 1, pageSize: 100, totalItems: team.length, totalPages: 1 } });
    }
    const content = /\/agencies\/[^/]+\/clients\/([^/]+)\/contents\/([^/]+)(\/tasks(?:\/([^/]+)(?:\/(deliver|approve|return))?)?)?$/.exec(path);
    if (content === null) return undefined;
    const row = rows.find((candidate) => candidate.id === content[2] && candidate.clientId === content[1]);
    if (row === undefined) return undefined;
    const write = call.method !== 'GET';
    if (write && world.hold?.match.test(path) === true) await world.hold.promise;
    if (write && world.failNext?.match.test(path) === true) {
      const { response } = world.failNext;
      world.failNext = undefined;
      return response();
    }
    if (!holds(VISUALIZE)) return failure(403, 'FORBIDDEN');
    const clientArchived = ROSTER.find((client) => client.id === row.clientId)?.status === 'archived';
    const closed = row.status === 'published' || row.status === 'cancelled';

    if (content[3] === undefined) {
      if (call.method === 'GET') return json(detail(row));
      if (call.method !== 'PATCH' || (call.body as { ownerMembershipId?: unknown } | undefined)?.ownerMembershipId === undefined) return undefined;
      if (!holds(OPERATE) || !holds(APPROVE)) return failure(403, 'FORBIDDEN');
      if (clientArchived) return failure(409, 'CLIENT_ARCHIVED');
      const parsed = UpdateContentRequestSchema.safeParse(call.body);
      if (!parsed.success) return failure(400, 'VALIDATION_ERROR');
      if (closed) return failure(409, 'CONTENT_NOT_EDITABLE');
      const chosen = parsed.data.ownerMembershipId!;
      if (invalidAssignee(chosen)) return failure(400, 'CONTENT_OWNER_INVALID');
      world.owner = team.find((person) => person.membershipId === chosen) ?? null;
      return json(detail(row));
    }

    if (content[4] === undefined) {
      if (call.method !== 'POST') return undefined;
      if (!holds(OPERATE)) return failure(403, 'FORBIDDEN');
      if (clientArchived) return failure(409, 'CLIENT_ARCHIVED');
      const parsed = CreateContentTaskRequestSchema.safeParse(call.body);
      if (!parsed.success) return failure(400, 'VALIDATION_ERROR');
      if (invalidAssignee(parsed.data.assigneeMembershipId)) return failure(400, 'CONTENT_TASK_ASSIGNEE_INVALID');
      if (closed) return failure(409, 'CONTENT_TASK_STATE');
      if (world.refuseLimit || world.tasks.length >= CONTENT_TASKS_MAX_PER_CONTENT) return failure(409, 'CONTENT_TASK_LIMIT');
      const made = task({
        title: parsed.data.title, description: parsed.data.description ?? null, dueOn: parsed.data.dueOn,
        assignee: team.find((person) => person.membershipId === parsed.data.assigneeMembershipId) ?? null
      });
      world.tasks.push(made);
      return json({ ...made, approvedBy: null, approvedAt: null }, 201);
    }

    const found = world.tasks.find((item) => item.id === content[4]);
    if (found === undefined) return failure(404, 'NOT_FOUND');
    if (content[5] === undefined) {
      if (call.method !== 'PATCH') return undefined;
      if (!holds(OPERATE)) return failure(403, 'FORBIDDEN');
      if (clientArchived) return failure(409, 'CLIENT_ARCHIVED');
      const parsed = UpdateContentTaskRequestSchema.safeParse(call.body);
      if (!parsed.success) return failure(400, 'VALIDATION_ERROR');
      if (closed || found.status === 'approved') return failure(409, 'CONTENT_TASK_STATE');
      const chosen = parsed.data.assigneeMembershipId;
      if (chosen !== undefined && invalidAssignee(chosen)) return failure(400, 'CONTENT_TASK_ASSIGNEE_INVALID');
      if (parsed.data.title !== undefined) found.title = parsed.data.title;
      if (parsed.data.dueOn !== undefined) found.dueOn = parsed.data.dueOn;
      if (chosen !== undefined) found.assignee = team.find((person) => person.membershipId === chosen) ?? null;
      return json({ ...found, approvedBy: null, approvedAt: null });
    }
    if (clientArchived) return failure(409, 'CLIENT_ARCHIVED');
    const move = content[5];
    // Who may: a value of the row, not of the role (the owner is read at the moment of the call).
    if (move === 'deliver' && found.assignee?.membershipId !== options.self) return failure(403, 'FORBIDDEN');
    if (move !== 'deliver' && !(world.owner?.membershipId === options.self && options.self !== null) && !holds(APPROVE)) return failure(403, 'FORBIDDEN');
    if (move === 'return' && !ReturnContentTaskRequestSchema.safeParse(call.body).success) return failure(400, 'VALIDATION_ERROR');
    if (closed) return failure(409, 'CONTENT_TASK_STATE');
    if (move === 'deliver') {
      if (found.status === 'approved') return failure(409, 'CONTENT_TASK_STATE');
      if (found.status === 'pending') { found.status = 'delivered'; found.returnComment = null; }
    } else {
      if (found.status === 'pending') return failure(409, 'CONTENT_TASK_STATE');
      if (move === 'approve') found.status = 'approved';
      else if (found.status === 'delivered') {
        found.status = 'pending';
        found.returnComment = (call.body as { comment: string }).comment.trim();
      } else return failure(409, 'CONTENT_TASK_STATE');
    }
    return json({ ...found, approvedBy: null, approvedAt: null });
  };

  /** The scenario for `openContent(row, ...)`: `rows` are the contents the routes above answer for. */
  const scenario = (rows: readonly Stored[], extra: Partial<Scenario> = {}): Scenario => ({
    permissions: options.permissions,
    ...extra,
    override: (async (call, calls) => (await override(call, calls, rows)) ?? extra.override?.(call, calls)) as Scenario['override']
  });
  return { world, scenario };
};
