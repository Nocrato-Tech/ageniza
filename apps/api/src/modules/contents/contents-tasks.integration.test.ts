import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { createTaskFixtures, type TaskMove } from './test-support/task-fixtures.js';
import { createTransitionFixtures, type TransitionPerson } from './test-support/transition-fixtures.js';
import { createContentsWorld, type PersonKey, type Reply } from './test-support/world.js';

// Issue #255 (specs/conteudo.md sections 2, 3, 4 and 6). Every person below holds the permissions of one thing and nothing else, so a
// guard on the wrong key does not hide behind an admin, and the person in charge of a task or of a content is chosen by the test.
// Each test names the mutation of the code that turns it red.
const w = createContentsWorld('tasks');
const f = createTransitionFixtures(w);
const t = createTaskFixtures(w);
const { people } = w;

const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|42501|pg_|relation|process|constraint/i;
const TASK_STATEMENT = /content_tasks|public\.contents\b/;

type Person = PersonKey | TransitionPerson;
const cookieOf = (person: Person): string => (person in people ? people[person as PersonKey].cookie : f.people[person as TransitionPerson].cookie);

let clientA: string;
let clientA2: string;
let clientB: string;

const move = (person: Person, action: TaskMove, ids: { contentId: string; taskId: string }, body?: unknown, clientId = clientA): Promise<Reply> =>
  w.call('POST', cookieOf(person), t.taskUrl(clientId, ids.contentId, ids.taskId, action), body);

const patch = (person: Person, ids: { contentId: string; taskId: string }, payload: unknown, clientId = clientA): Promise<Reply> =>
  w.call('PATCH', cookieOf(person), t.taskUrl(clientId, ids.contentId, ids.taskId), payload);

const create = (person: Person, contentId: string, payload: unknown, clientId = clientA): Promise<Reply> =>
  w.call('POST', cookieOf(person), t.tasksUrl(clientId, contentId), payload);

const error = (reply: Reply, status: number, code: string): void => {
  expect(reply.statusCode).toBe(status);
  expect(reply.json().error.code).toBe(code);
  expect(JSON.stringify(reply.json().error)).not.toMatch(NO_DATABASE_DETAIL);
};

const statusOf = async (taskId: string): Promise<string> => (await t.taskRow(taskId)).status as string;

const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
};

/** The whole body, keys and values: a key that names a user id, or any user id of the world, anywhere in it, is a leak. */
const expectNoUserId = (reply: Reply): void => {
  expect(keysOf(reply.json()).filter((key) => /user_?id/i.test(key))).toEqual([]);
  const text = JSON.stringify(reply.json());
  for (const person of Object.values(people)) expect(text).not.toContain(person.id);
  for (const person of Object.values(f.people)) expect(text).not.toContain(person.id);
};

const validTask = async (assignee: PersonKey = 'production') => ({
  title: 'Gravar o vídeo',
  description: 'Gravar em 4K.',
  assigneeMembershipId: await t.linkOf(assignee),
  dueOn: '2026-10-15'
});

const mentionsTasks = (): boolean => w.statements.some((statement) => TASK_STATEMENT.test(statement));

beforeAll(async () => {
  await w.setup();
  await f.setup();
  clientA = await w.newClient('a');
  clientA2 = await w.newClient('a2');
  clientB = await w.newClient('b', { agencyId: w.agencyB });
}, 90_000);

afterAll(async () => {
  await f.cleanup();
  await w.teardown();
}, 60_000);

describe('who delivers a task: only the person in charge of the task (issue #255, rule 10)', () => {
  it('lets the person in charge deliver with nothing but conteudo.visualizar, and the task is left delivered', async () => {
    const ids = await t.scenario(clientA, { assignee: 'reader', status: 'pending' });

    const reply = await move('reader', 'deliver', ids);

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ id: ids.taskId, status: 'delivered', returnComment: null, approvedBy: null, approvedAt: null });
    expect(await statusOf(ids.taskId)).toBe('delivered');
  });

  // The permission is not the question: an admin, the owner of the agency and the person in charge of the content are all refused.
  it.each<PersonKey | TransitionPerson>(['admin', 'manager', 'production', 'owner', 'approver', 'approveRead', 'operateRead'])(
    'refuses %s, who is not the person in charge of the task, and the task stays pending',
    async (person) => {
      const ids = await t.scenario(clientA, { owner: 'production', assignee: 'reader', status: 'pending' });

      const reply = await move(person, 'deliver', ids);

      error(reply, 403, 'FORBIDDEN');
      expect(await statusOf(ids.taskId)).toBe('pending');
    }
  );

  it.each<PersonKey | TransitionPerson>(['sales', 'finance', 'noContent', 'operateOnly', 'approveOnly'])(
    'answers 403 to %s, who cannot read Conteúdo, before any statement of the module',
    async (person) => {
      const ids = await t.scenario(clientA, { assignee: 'reader', status: 'pending' });
      w.statements.length = 0;

      const reply = await move(person, 'deliver', ids);

      error(reply, 403, 'FORBIDDEN');
      expect(mentionsTasks()).toBe(false);
      expect(await statusOf(ids.taskId)).toBe('pending');
    }
  );

  it('answers 401 without a session, and delivers nothing', async () => {
    const ids = await t.scenario(clientA, { assignee: 'reader', status: 'pending' });

    const reply = await w.getApp().app.inject({ method: 'POST', url: t.taskUrl(clientA, ids.contentId, ids.taskId, 'deliver'), headers: { origin: TEST_APP_PUBLIC_URL } });

    expect(reply.statusCode).toBe(401);
    expect(await statusOf(ids.taskId)).toBe('pending');
  });

  it('delivers a task that was returned, and the comment of the return goes away with it', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });
    const taskId = await t.seedTask(contentId, { status: 'pending', assignee: 'reader', returnComment: 'Falta a legenda.' });

    const reply = await move('reader', 'deliver', { contentId, taskId });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'delivered', returnComment: null });
    expect((await t.taskRow(taskId)).return_comment).toBeNull();
  });

  it('answers 200 without change to a task that was already delivered', async () => {
    const ids = await t.scenario(clientA, { assignee: 'reader', status: 'delivered' });

    const reply = await move('reader', 'deliver', ids);

    expect(reply.statusCode).toBe(200);
    expect(reply.json().status).toBe('delivered');
  });

  it('refuses a task that was already approved, with 409 CONTENT_TASK_STATE', async () => {
    const ids = await t.scenario(clientA, { assignee: 'reader', status: 'approved' });

    const reply = await move('reader', 'deliver', ids);

    error(reply, 409, 'CONTENT_TASK_STATE');
    expect(await statusOf(ids.taskId)).toBe('approved');
  });
});

describe.each<TaskMove>(['approve', 'return'])('who %ss a task: the person in charge of the content, or who approves for the agency (issue #255, rule 10)', (action) => {
  const bodyOf = (): unknown => (action === 'return' ? { comment: 'Falta a legenda em português.' } : undefined);
  const after = action === 'approve' ? 'approved' : 'pending';

  it(`lets the person in charge of the content ${action} it with nothing but conteudo.visualizar`, async () => {
    const ids = await t.scenario(clientA, { owner: 'reader', assignee: 'production' });

    const reply = await move('reader', action, ids, bodyOf());

    expect(reply.statusCode).toBe(200);
    expect(reply.json().status).toBe(after);
    expect(await statusOf(ids.taskId)).toBe(after);
  });

  // `approveRead` holds only conteudo.aprovar_pela_agencia and the read: the permission that replaces the person in charge.
  it.each<PersonKey | TransitionPerson>(['approveRead', 'approver', 'admin', 'manager', 'owner'])(
    `lets %s ${action} it for the agency, though they are not in charge of the content`,
    async (person) => {
      const ids = await t.scenario(clientA, { owner: 'production', assignee: 'reader' });

      const reply = await move(person, action, ids, bodyOf());

      expect(reply.statusCode).toBe(200);
      expect(await statusOf(ids.taskId)).toBe(after);
    }
  );

  it.each<PersonKey | TransitionPerson>(['reader', 'production', 'operateRead'])(
    `refuses %s, who reads and is not in charge of the content, and the task stays delivered`,
    async (person) => {
      const ids = await t.scenario(clientA, { owner: 'manager', assignee: 'production' });

      const reply = await move(person, action, ids, bodyOf());

      error(reply, 403, 'FORBIDDEN');
      expect(await statusOf(ids.taskId)).toBe('delivered');
    }
  );

  it(`refuses the person in charge of the task when they are not in charge of the content: nobody ${action}s their own delivery`, async () => {
    const ids = await t.scenario(clientA, { owner: 'manager', assignee: 'reader' });

    const reply = await move('reader', action, ids, bodyOf());

    error(reply, 403, 'FORBIDDEN');
    expect(await statusOf(ids.taskId)).toBe('delivered');
  });

  it.each<PersonKey | TransitionPerson>(['sales', 'finance', 'noContent', 'operateOnly', 'approveOnly'])(
    `answers 403 to %s, who cannot read Conteúdo, before any statement of the module`,
    async (person) => {
      const ids = await t.scenario(clientA, { owner: 'manager', assignee: 'production' });
      w.statements.length = 0;

      const reply = await move(person, action, ids, bodyOf());

      error(reply, 403, 'FORBIDDEN');
      expect(mentionsTasks()).toBe(false);
      expect(await statusOf(ids.taskId)).toBe('delivered');
    }
  );

  it('follows the person in charge of the content as it is when the request arrives, not as it was when the task was made', async () => {
    const ids = await t.scenario(clientA, { owner: 'production', assignee: 'reader' });
    // The way a person does it: the route of the content, by link, which asks for conteudo.aprovar_pela_agencia.
    const changed = await w.call('PATCH', people.admin.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/${ids.contentId}`, { ownerMembershipId: await t.linkOf('reader') });
    expect(changed.statusCode).toBe(200);

    const former = await move('production', action, ids, bodyOf());
    const current = await move('reader', action, ids, bodyOf());

    error(former, 403, 'FORBIDDEN');
    expect(current.statusCode).toBe(200);
  });

  it('answers 401 without a session, and moves nothing', async () => {
    const ids = await t.scenario(clientA);

    const reply = await w.getApp().app.inject({
      method: 'POST',
      url: t.taskUrl(clientA, ids.contentId, ids.taskId, action),
      headers: { origin: TEST_APP_PUBLIC_URL },
      ...(action === 'return' ? { payload: { comment: 'Falta a legenda.' } } : {})
    });

    expect(reply.statusCode).toBe(401);
    expect(await statusOf(ids.taskId)).toBe('delivered');
  });

  it('refuses a task that was not delivered, with 409 CONTENT_TASK_STATE', async () => {
    const ids = await t.scenario(clientA, { owner: 'manager', status: 'pending' });

    const reply = await move('manager', action, ids, bodyOf());

    error(reply, 409, 'CONTENT_TASK_STATE');
    expect(await statusOf(ids.taskId)).toBe('pending');
  });
});

describe('approving a task (issue #255)', () => {
  it('fixes who approved and when from the session, and names them by name and side, never by id', async () => {
    const ids = await t.scenario(clientA, { owner: 'manager', assignee: 'production' });

    const reply = await move('manager', 'approve', ids);

    expect(reply.statusCode).toBe(200);
    expect(reply.json().approvedBy).toEqual({ name: 'Pessoa manager', side: 'agency' });
    expect(Number.isNaN(Date.parse(reply.json().approvedAt))).toBe(false);
    expect((await t.taskRow(ids.taskId)).approved_by).toBe(people.manager.id);
    expectNoUserId(reply);
  });

  it('keeps who approved first when the task is approved again by someone else', async () => {
    const ids = await t.scenario(clientA, { owner: 'manager', assignee: 'production' });
    await move('manager', 'approve', ids);

    const again = await move('admin', 'approve', ids);

    expect(again.statusCode).toBe(200);
    expect(again.json().approvedBy).toEqual({ name: 'Pessoa manager', side: 'agency' });
    expect((await t.taskRow(ids.taskId)).approved_by).toBe(people.manager.id);
  });
});

describe('returning a task: a comment, kept on the task (issue #255, rule 11)', () => {
  it('sends the task back to pending with the comment, and the detail of the content shows it', async () => {
    const ids = await t.scenario(clientA, { owner: 'manager' });

    const reply = await move('manager', 'return', ids, { comment: 'Falta a legenda em português.' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'pending', returnComment: 'Falta a legenda em português.', approvedBy: null });
    const detail = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/${ids.contentId}`);
    expect(detail.json().tasks).toEqual([reply.json()]);
  });

  it('keeps the comment on the task and out of the conversation of the content, which is the client\'s', async () => {
    const ids = await t.scenario(clientA, { owner: 'manager' });

    await move('manager', 'return', ids, { comment: 'Falta a legenda em português.' });

    const detail = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/${ids.contentId}`);
    expect(detail.json().conversation).toEqual({ threadId: null, commentCount: 0, lastCommentAt: null });
    expect(await w.getOwner().knex('client_threads').where({ content_id: ids.contentId }).count<Array<{ count: string }>>('id as count')).toEqual([{ count: '0' }]);
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['no comment', { reason: 'x' }],
    ['an empty comment', { comment: '' }],
    ['a blank comment', { comment: '   ' }],
    ['a comment of only a zero width space', { comment: '​' }],
    ['a comment of only a zero width joiner', { comment: '‍' }],
    ['a comment of only a word joiner', { comment: '⁠' }],
    ['a comment of only a byte order mark', { comment: '﻿' }],
    ['a comment of only a soft hyphen', { comment: '­' }],
    ['a comment of only a control character', { comment: '\u0001' }],
    ['a comment with an invisible character inside', { comment: 'Falta​a legenda' }],
    ['a comment that is not text', { comment: 7 }],
    ['a comment of 5001 bytes', { comment: 'a'.repeat(5001) }],
    ['a field the body does not have', { comment: 'Falta a legenda.', status: 'approved' }]
  ])('answers 400 VALIDATION_ERROR to %s, and the task stays delivered', async (_label, body) => {
    const ids = await t.scenario(clientA, { owner: 'manager' });

    const reply = await move('manager', 'return', ids, body);

    error(reply, 400, 'VALIDATION_ERROR');
    expect(await statusOf(ids.taskId)).toBe('delivered');
    expect((await t.taskRow(ids.taskId)).return_comment).toBeNull();
  });

  it('takes a comment of exactly 5000 bytes, with line breaks, and keeps it whole', async () => {
    const ids = await t.scenario(clientA, { owner: 'manager' });
    const comment = `Linha um\nLinha dois ${'a'.repeat(4_980)}`;
    expect(Buffer.byteLength(comment)).toBeLessThanOrEqual(5000);

    const reply = await move('manager', 'return', ids, { comment });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().returnComment).toBe(comment);
  });
});

describe('who creates and who edits a task: conteudo.operar, and the read (issue #255, specs/conteudo.md section 2)', () => {
  const ALLOWED: ReadonlyArray<Person> = ['admin', 'manager', 'production', 'owner', 'operateRead', 'approver'];
  const DENIED: ReadonlyArray<Person> = ['sales', 'finance', 'noContent', 'reader', 'operateOnly', 'approveRead', 'approveOnly'];

  it.each(ALLOWED)('lets %s create a task, answers 201 with the person by link and name, and writes it pending', async (person) => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });

    const reply = await create(person, contentId, await validTask());

    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({
      title: 'Gravar o vídeo',
      description: 'Gravar em 4K.',
      assignee: { membershipId: await t.linkOf('production'), name: 'Pessoa production' },
      dueOn: '2026-10-15',
      status: 'pending',
      returnComment: null,
      approvedBy: null,
      approvedAt: null
    });
    expect(await t.countTasks(contentId)).toBe(1);
    expectNoUserId(reply);
  });

  it.each(DENIED)('answers 403 to %s on create, before any statement of the module, and writes nothing', async (person) => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });
    w.statements.length = 0;

    const reply = await create(person, contentId, await validTask());

    error(reply, 403, 'FORBIDDEN');
    expect(mentionsTasks()).toBe(false);
    expect(await t.countTasks(contentId)).toBe(0);
  });

  it.each(ALLOWED)('lets %s edit a task', async (person) => {
    const ids = await t.scenario(clientA, { status: 'pending' });

    const reply = await patch(person, ids, { dueOn: '2026-10-17', title: 'Gravar o vídeo de novo' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ id: ids.taskId, dueOn: '2026-10-17', title: 'Gravar o vídeo de novo', status: 'pending' });
    expect((await t.taskRow(ids.taskId)).due_on).toBeDefined();
    expectNoUserId(reply);
  });

  it.each(DENIED)('answers 403 to %s on edit, before any statement of the module, and writes nothing', async (person) => {
    const ids = await t.scenario(clientA, { status: 'pending' });
    const before = await t.taskRow(ids.taskId);
    w.statements.length = 0;

    const reply = await patch(person, ids, { title: 'Outro título' });

    error(reply, 403, 'FORBIDDEN');
    expect(mentionsTasks()).toBe(false);
    expect(await t.taskRow(ids.taskId)).toEqual(before);
  });

  it('answers 401 without a session on create and on edit', async () => {
    const ids = await t.scenario(clientA, { status: 'pending' });

    const created = await w.getApp().app.inject({ method: 'POST', url: t.tasksUrl(clientA, ids.contentId), headers: { origin: TEST_APP_PUBLIC_URL }, payload: await validTask() });
    const edited = await w.getApp().app.inject({ method: 'PATCH', url: t.taskUrl(clientA, ids.contentId, ids.taskId), headers: { origin: TEST_APP_PUBLIC_URL }, payload: { title: 'Outro' } });

    expect(created.statusCode).toBe(401);
    expect(edited.statusCode).toBe(401);
    expect(await t.countTasks(ids.contentId)).toBe(1);
  });

  it('keeps the approval of an approved content when a subtask changes (the SPEC: subtasks keep the approval)', async () => {
    const ids = await t.scenario(clientA, { status: 'pending', content: { status: 'approved' } });
    const before = await w.contentRow(ids.contentId);

    const reply = await patch('production', ids, { title: 'Título novo', dueOn: '2026-10-30' });

    expect(reply.statusCode).toBe(200);
    const after = await w.contentRow(ids.contentId);
    expect(after.status).toBe('approved');
    expect(after.revision).toBe(before.revision);
  });
});

describe('the person in charge of a task: an active collaborator of this agency who sees Conteúdo, and nothing is said of why not (issue #255, rule 10)', () => {
  const INVALID = { code: 'CONTENT_TASK_ASSIGNEE_INVALID', message: 'O responsável precisa ser um colaborador ativo que vê Conteúdo.' };

  /** Every reason a link cannot be the person in charge, each as the link to send; they must all be told as one. */
  const invalidLinks = async (): Promise<ReadonlyArray<readonly [string, string]>> => {
    const portalUser = await f.portalMember(clientA);
    const portalLink = await w.getOwner().knex('client_memberships').where({ client_id: clientA, user_id: portalUser }).first('id');
    return [
      ['a link that does not exist', randomUUID()],
      ['a link of another agency', await t.linkOf('adminB', w.agencyB)],
      ['the link of a person of two agencies, in the other agency', await t.linkOf('dual', w.agencyB)],
      ['a link of a client\'s portal', portalLink?.id as string],
      ['a link of a person who does not see Conteúdo (Vendas)', await t.linkOf('sales')],
      ['a link of a person who sees only Clientes', await t.linkOf('noContent')]
    ];
  };

  it('answers the same 400 on create for every reason, and writes nothing', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });
    const replies: Reply[] = [];

    for (const [, membershipId] of await invalidLinks()) {
      const reply = await create('admin', contentId, { ...await validTask(), assigneeMembershipId: membershipId });
      expect(reply.statusCode).toBe(400);
      replies.push(reply);
    }
    await t.withRemovedLink('production', async () => {
      replies.push(await create('admin', contentId, await validTask('production')));
    });

    expect(replies).toHaveLength(7);
    for (const reply of replies) expect(reply.json().error).toEqual(INVALID);
    expect(await t.countTasks(contentId)).toBe(0);
  });

  it('answers the same 400 on edit for every reason, and the task keeps its person in charge', async () => {
    const ids = await t.scenario(clientA, { status: 'pending', assignee: 'production' });
    const before = await t.taskRow(ids.taskId);
    const replies: Reply[] = [];

    for (const [, membershipId] of await invalidLinks()) {
      replies.push(await patch('admin', ids, { assigneeMembershipId: membershipId, title: 'Outro título' }));
    }
    await t.withRemovedLink('manager', async () => {
      replies.push(await patch('admin', ids, { assigneeMembershipId: await t.linkOf('manager'), title: 'Outro título' }));
    });

    expect(replies).toHaveLength(7);
    for (const reply of replies) {
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error).toEqual(INVALID);
    }
    expect(await t.taskRow(ids.taskId)).toEqual(before);
  });

  it('answers 403 before looking at the link, so a person who cannot write learns nothing about which links are valid', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });
    const valid = await validTask();

    const withValid = await create('reader', contentId, valid);
    const withInvalid = await create('reader', contentId, { ...valid, assigneeMembershipId: randomUUID() });

    expect(withValid.statusCode).toBe(403);
    expect(withInvalid.statusCode).toBe(403);
    expect(withInvalid.json().error).toEqual(withValid.json().error);
  });

  // Called as the person of two agencies: an admin of agency A cannot see the link of agency B, so the admin would pass a filter that is
  // missing. Issue #579: without the agency filter in `resolveCollaboratorLink`, the link of agency B is named and this one turns red.
  it('names the person in charge by the link of this agency, once, for a person of two agencies', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });

    const reply = await create('dual', contentId, await validTask('dual'));

    expect(reply.statusCode).toBe(201);
    expect(reply.json().assignee).toEqual({ membershipId: await t.linkOf('dual', w.agencyA), name: 'Pessoa dual' });
  });

  it('refuses, to the person of two agencies, their own link in the other agency, and writes nothing', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });

    const reply = await create('dual', contentId, { ...await validTask(), assigneeMembershipId: await t.linkOf('dual', w.agencyB) });

    expect(reply.statusCode).toBe(400);
    expect(reply.json().error).toEqual(INVALID);
    expect(await t.countTasks(contentId)).toBe(0);
  });

  it('refuses, to the person of two agencies, an edit to their own link in the other agency, and the task keeps its person in charge', async () => {
    const ids = await t.scenario(clientA, { status: 'pending', assignee: 'production' });
    const before = await t.taskRow(ids.taskId);

    const reply = await patch('dual', ids, { assigneeMembershipId: await t.linkOf('dual', w.agencyB), title: 'Outro título' });

    expect(reply.statusCode).toBe(400);
    expect(reply.json().error).toEqual(INVALID);
    expect(await t.taskRow(ids.taskId)).toEqual(before);
  });

  it('writes no subtask when the link of the person in charge is removed, and answers the same 400', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });

    await t.withRemovedLink('production', async () => {
      const reply = await create('admin', contentId, await validTask('production'));
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error).toEqual(INVALID);
    });

    expect(await t.countTasks(contentId)).toBe(0);
  });

  it('keeps the task as it was when the link of the new person in charge is removed', async () => {
    const ids = await t.scenario(clientA, { status: 'pending', assignee: 'production' });
    const before = await t.taskRow(ids.taskId);

    await t.withRemovedLink('manager', async () => {
      const reply = await patch('admin', ids, { assigneeMembershipId: await t.linkOf('manager'), title: 'Outro título' });
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error).toEqual(INVALID);
    });

    expect(await t.taskRow(ids.taskId)).toEqual(before);
  });

  it('changes the person in charge by link, and a person who is now the assignee delivers', async () => {
    const ids = await t.scenario(clientA, { status: 'pending', assignee: 'production' });

    const reply = await patch('admin', ids, { assigneeMembershipId: await t.linkOf('reader') });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().assignee).toEqual({ membershipId: await t.linkOf('reader'), name: 'Pessoa reader' });
    expect((await move('production', 'deliver', ids)).statusCode).toBe(403);
    expect((await move('reader', 'deliver', ids)).statusCode).toBe(200);
  });

  it('answers 409 CLIENT_ARCHIVED before it looks at the link', async () => {
    const archived = await w.newClient('archived-before-link', { status: 'archived' });
    const contentId = await w.seedContent(archived, { ownerUserId: people.manager.id });

    const reply = await create('admin', contentId, { ...await validTask(), assigneeMembershipId: randomUUID() }, archived);

    error(reply, 409, 'CLIENT_ARCHIVED');
  });

  it('answers 409 CLIENT_ARCHIVED before it looks at the link, on edit too', async () => {
    const archived = await w.newClient('archived-edit-before-link', { status: 'archived' });
    const contentId = await w.seedContent(archived, { ownerUserId: people.manager.id });
    const taskId = await t.seedTask(contentId, { status: 'pending' });

    const reply = await patch('admin', { contentId, taskId }, { assigneeMembershipId: randomUUID() }, archived);

    error(reply, 409, 'CLIENT_ARCHIVED');
  });
});

describe('what a task is made of: the one rule of free text, and nothing the caller does not own (issue #255)', () => {
  const HIDDEN: ReadonlyArray<readonly [string, string]> = [
    ['a zero width space', '​'],
    ['a zero width joiner', '‍'],
    ['a word joiner', '⁠'],
    ['a byte order mark', '﻿'],
    ['a soft hyphen', '­'],
    ['a control character', '\u0001']
  ];

  it.each(HIDDEN)('refuses a title that is only %s, on create and on edit', async (_label, hidden) => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });
    const ids = await t.scenario(clientA, { status: 'pending' });

    expect((await create('admin', contentId, { ...await validTask(), title: hidden })).statusCode).toBe(400);
    expect((await create('admin', contentId, { ...await validTask(), title: `Gravar${hidden}vídeo` })).statusCode).toBe(400);
    expect((await patch('admin', ids, { title: hidden })).statusCode).toBe(400);
    expect(await t.countTasks(contentId)).toBe(0);
  });

  it.each(HIDDEN)('refuses a description that is only %s, or has it inside, on create and on edit', async (_label, hidden) => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });
    const ids = await t.scenario(clientA, { status: 'pending' });

    expect((await create('admin', contentId, { ...await validTask(), description: hidden })).statusCode).toBe(400);
    expect((await create('admin', contentId, { ...await validTask(), description: `Gravar${hidden}vídeo` })).statusCode).toBe(400);
    expect((await patch('admin', ids, { description: hidden })).statusCode).toBe(400);
    expect(await t.countTasks(contentId)).toBe(0);
    expect((await t.taskRow(ids.taskId)).description).toBeNull();
  });

  it.each([
    ['a title with a line break', { title: 'Gravar\no vídeo' }],
    ['a blank title', { title: '   ' }],
    ['a title of 121 characters', { title: 'a'.repeat(121) }],
    ['a description of 20001 bytes', { description: 'a'.repeat(20_001) }],
    ['a date that does not exist', { dueOn: '2026-02-30' }],
    ['a date with a time', { dueOn: '2026-10-15T10:00:00Z' }],
    ['no date', { dueOn: undefined }],
    ['no person in charge', { assigneeMembershipId: undefined }],
    ['a user id as the person in charge', { assigneeMembershipId: undefined, assigneeUserId: randomUUID() }],
    ['a person in charge that is not a uuid', { assigneeMembershipId: 'ana' }],
    ['a state', { status: 'approved' }],
    ['who approved', { approvedBy: randomUUID() }],
    ['the comment of a return', { returnComment: 'x' }]
  ])('answers 400 VALIDATION_ERROR to %s on create, and writes nothing', async (_label, override) => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });

    const reply = await create('admin', contentId, { ...await validTask(), ...override });

    error(reply, 400, 'VALIDATION_ERROR');
    expect(await t.countTasks(contentId)).toBe(0);
  });

  it.each([
    ['an empty body', {}],
    ['a title with a line break', { title: 'Gravar\no vídeo' }],
    ['a date that does not exist', { dueOn: '2026-02-30' }],
    ['a state', { status: 'approved' }],
    ['a user id as the person in charge', { assigneeUserId: randomUUID() }],
    ['who approved', { approvedBy: randomUUID() }],
    ['the comment of a return', { returnComment: 'x' }]
  ])('answers 400 VALIDATION_ERROR to %s on edit, and the task stays as it was', async (_label, payload) => {
    const ids = await t.scenario(clientA, { status: 'pending' });
    const before = await t.taskRow(ids.taskId);

    const reply = await patch('admin', ids, payload);

    error(reply, 400, 'VALIDATION_ERROR');
    expect(await t.taskRow(ids.taskId)).toEqual(before);
  });

  it('trims the title, takes a blank description as none, keeps its line breaks, and a null description clears it on edit', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });

    const blank = await create('admin', contentId, { ...await validTask(), title: '  Gravar o vídeo  ', description: '   ' });
    const multiline = await create('admin', contentId, { ...await validTask(), description: 'Linha um\nLinha dois' });
    const cleared = await patch('admin', { contentId, taskId: multiline.json().id }, { description: null });

    expect(blank.statusCode).toBe(201);
    expect(blank.json()).toMatchObject({ title: 'Gravar o vídeo', description: null });
    expect(multiline.json().description).toBe('Linha um\nLinha dois');
    expect(cleared.json().description).toBeNull();
  });

  it.each([
    ['create', 'POST'],
    ['edit', 'PATCH'],
    ['return', 'POST']
  ] as const)('answers 400, without an echo of the body, to a body that is not JSON on %s', async (name, method) => {
    const ids = await t.scenario(clientA, { owner: 'manager', status: 'delivered' });
    const url = name === 'create' ? t.tasksUrl(clientA, ids.contentId) : t.taskUrl(clientA, ids.contentId, ids.taskId, name === 'return' ? 'return' : undefined);

    const reply = await w.getApp().app.inject({
      method,
      url,
      headers: { origin: TEST_APP_PUBLIC_URL, cookie: people.manager.cookie, 'content-type': 'application/json' },
      payload: '{"comment": "segredo-no-corpo'
    });

    expect(reply.statusCode).toBe(400);
    expect(reply.body).not.toContain('segredo-no-corpo');
    expect(await statusOf(ids.taskId)).toBe('delivered');
  });

  it.each([
    ['a title that is a number', { title: 7 }],
    ['a description that is a list', { description: ['a'] }],
    ['a person in charge that is an object', { assigneeMembershipId: {} }],
    ['a due date that is a number', { dueOn: 20261015 }]
  ])('answers 400 VALIDATION_ERROR to %s, on create and on edit', async (_label, override) => {
    const ids = await t.scenario(clientA, { status: 'pending' });

    error(await create('admin', ids.contentId, { ...await validTask(), ...override }), 400, 'VALIDATION_ERROR');
    error(await patch('admin', ids, override), 400, 'VALIDATION_ERROR');
  });

  it('takes a description of exactly 20000 bytes', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });

    const reply = await create('admin', contentId, { ...await validTask(), description: 'a'.repeat(20_000) });

    expect(reply.statusCode).toBe(201);
  });
});

describe('the state of the task and of the content (issue #255, section 4)', () => {
  it('does not edit an approved task: 409 CONTENT_TASK_STATE, and it keeps what it had', async () => {
    const ids = await t.scenario(clientA, { status: 'approved' });
    const before = await t.taskRow(ids.taskId);

    const reply = await patch('admin', ids, { title: 'Outro título' });

    error(reply, 409, 'CONTENT_TASK_STATE');
    expect(await t.taskRow(ids.taskId)).toEqual(before);
  });

  it.each(['published', 'cancelled'] as const)('does nothing to the tasks of a %s content: 409 CONTENT_TASK_STATE for every route', async (status) => {
    const { contentId, taskIds: [pending, delivered] } = await t.endedContentWithTasks(clientA, status, [
      { status: 'pending', assignee: 'reader' },
      { status: 'delivered', assignee: 'reader' }
    ]) as { contentId: string; taskIds: [string, string] };

    error(await create('admin', contentId, await validTask()), 409, 'CONTENT_TASK_STATE');
    error(await patch('admin', { contentId, taskId: pending }, { title: 'Outro' }), 409, 'CONTENT_TASK_STATE');
    error(await move('reader', 'deliver', { contentId, taskId: pending }), 409, 'CONTENT_TASK_STATE');
    error(await move('manager', 'approve', { contentId, taskId: delivered }), 409, 'CONTENT_TASK_STATE');
    error(await move('manager', 'return', { contentId, taskId: delivered }, { comment: 'Falta algo.' }), 409, 'CONTENT_TASK_STATE');

    expect(await statusOf(pending)).toBe('pending');
    expect(await statusOf(delivered)).toBe('delivered');
    expect(await t.countTasks(contentId)).toBe(2);
  });

  it('walks the whole cycle: pending, delivered, returned, delivered again, approved', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });
    const created = await create('production', contentId, { ...await validTask('reader') });
    const ids = { contentId, taskId: created.json().id as string };

    expect((await move('reader', 'deliver', ids)).json().status).toBe('delivered');
    const returned = await move('manager', 'return', ids, { comment: 'Falta a legenda.' });
    expect(returned.json()).toMatchObject({ status: 'pending', returnComment: 'Falta a legenda.' });
    expect((await move('reader', 'deliver', ids)).json()).toMatchObject({ status: 'delivered', returnComment: null });
    const approved = await move('manager', 'approve', ids);

    expect(approved.json()).toMatchObject({ status: 'approved', approvedBy: { name: 'Pessoa manager', side: 'agency' } });
  });
});

describe('the percentage of a content follows the approved subtasks (issue #255, specs/conteudo.md section 3)', () => {
  const listOf = async (clientId: string, day: string): Promise<Array<{ id: string; tasksTotal: number; tasksApproved: number }>> => {
    const reply = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientId}/contents?from=${day}&to=${day}`);
    expect(reply.statusCode).toBe(200);
    return reply.json().data.contents;
  };

  it('counts the tasks made, the ones approved, and only the ones of this content', async () => {
    const clientId = await w.newClient('percentage');
    const day = '2026-10-12';
    const contentId = await w.seedContent(clientId, { ownerUserId: people.manager.id, publishOn: day });
    const other = await w.seedContent(clientId, { ownerUserId: people.manager.id, publishOn: day });
    await t.seedTask(other, { status: 'approved' });
    await t.seedTask(other, { status: 'approved' });
    const item = async () => (await listOf(clientId, day)).find((candidate) => candidate.id === contentId);

    expect(await item()).toMatchObject({ tasksTotal: 0, tasksApproved: 0 });
    const first = await create('production', contentId, await validTask('reader'), clientId);
    const second = await create('production', contentId, await validTask('reader'), clientId);
    expect(await item()).toMatchObject({ tasksTotal: 2, tasksApproved: 0 });

    const firstIds = { contentId, taskId: first.json().id as string };
    const secondIds = { contentId, taskId: second.json().id as string };
    await move('reader', 'deliver', firstIds, undefined, clientId);
    expect(await item()).toMatchObject({ tasksTotal: 2, tasksApproved: 0 });
    await move('manager', 'approve', firstIds, undefined, clientId);
    expect(await item()).toMatchObject({ tasksTotal: 2, tasksApproved: 1 });

    await move('reader', 'deliver', secondIds, undefined, clientId);
    await move('manager', 'return', secondIds, { comment: 'Refazer.' }, clientId);
    expect(await item()).toMatchObject({ tasksTotal: 2, tasksApproved: 1 });
    await move('reader', 'deliver', secondIds, undefined, clientId);
    await move('manager', 'approve', secondIds, undefined, clientId);
    expect(await item()).toMatchObject({ tasksTotal: 2, tasksApproved: 2 });
    expect((await listOf(clientId, day)).find((candidate) => candidate.id === other)).toMatchObject({ tasksTotal: 2, tasksApproved: 2 });
  });

  it('does not let a content with open subtasks go for approval, and lets it once they are approved', async () => {
    const clientId = await w.newClient('percentage-submit');
    const contentId = await w.seedContent(clientId, { ownerUserId: people.manager.id, status: 'in_production', format: 'reels' });
    await f.addMedia(contentId, clientId);
    const created = await create('production', contentId, await validTask('reader'), clientId);
    const ids = { contentId, taskId: created.json().id as string };

    error(await w.call('POST', people.manager.cookie, f.urlOf(clientId, contentId, 'submit')), 409, 'CONTENT_TASKS_NOT_APPROVED');
    await move('reader', 'deliver', ids, undefined, clientId);
    await move('manager', 'approve', ids, undefined, clientId);

    expect((await w.call('POST', people.manager.cookie, f.urlOf(clientId, contentId, 'submit'))).statusCode).toBe(200);
  });
});

describe('a content has up to 50 subtasks, in any state (issue #255, decision of the maestro)', () => {
  const LIMIT = { code: 'CONTENT_TASK_LIMIT', message: 'Um conteúdo tem até 50 subtarefas.' };

  /** A content with `count` subtasks in every state, made straight in the database. */
  const contentWith = async (clientId: string, count: number): Promise<string> => {
    const contentId = await w.seedContent(clientId, { ownerUserId: people.manager.id });
    const states = ['pending', 'delivered', 'approved'] as const;
    for (let index = 0; index < count; index += 1) await t.seedTask(contentId, { status: states[index % 3], assignee: 'reader' });
    return contentId;
  };

  it('creates the 50th subtask and refuses the 51st with 409 CONTENT_TASK_LIMIT, writing nothing', async () => {
    const contentId = await contentWith(clientA, 49);

    const fiftieth = await create('admin', contentId, await validTask());
    const fiftyFirst = await create('admin', contentId, await validTask());

    expect(fiftieth.statusCode).toBe(201);
    expect(fiftyFirst.statusCode).toBe(409);
    expect(fiftyFirst.json().error).toEqual(LIMIT);
    expect(await t.countTasks(contentId)).toBe(50);
  });

  it('refuses at 50 whatever the state of the ones it has, approved ones included', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.manager.id });
    for (let index = 0; index < 50; index += 1) await t.seedTask(contentId, { status: 'approved', assignee: 'reader' });

    const reply = await create('admin', contentId, await validTask());

    expect(reply.statusCode).toBe(409);
    expect(reply.json().error).toEqual(LIMIT);
    expect(await t.countTasks(contentId)).toBe(50);
  });

  it('counts the subtasks of this content only: another content of the client, full, does not stop this one', async () => {
    const full = await contentWith(clientA, 50);
    const other = await w.seedContent(clientA, { ownerUserId: people.manager.id });

    const reply = await create('admin', other, await validTask());

    expect(reply.statusCode).toBe(201);
    expect(await t.countTasks(full)).toBe(50);
    expect(await t.countTasks(other)).toBe(1);
  });

  it('is only about creating: a full content still edits, delivers, approves and returns its subtasks', async () => {
    const contentId = await contentWith(clientA, 50);
    const idIn = async (status: string): Promise<string> =>
      (await w.getOwner().knex('content_tasks').where({ content_id: contentId, status }).first('id'))?.id as string;
    const pending = await idIn('pending');
    const delivered = await idIn('delivered');

    expect((await patch('admin', { contentId, taskId: pending }, { title: 'Outro título' })).statusCode).toBe(200);
    expect((await move('reader', 'deliver', { contentId, taskId: pending })).statusCode).toBe(200);
    expect((await move('manager', 'return', { contentId, taskId: delivered }, { comment: 'Falta algo.' })).statusCode).toBe(200);
    expect(await t.countTasks(contentId)).toBe(50);
  });

  it('answers 403 to who may not create before it counts, and 400 for an invalid person in charge before the limit', async () => {
    const contentId = await contentWith(clientA, 50);
    w.statements.length = 0;

    const denied = await create('reader', contentId, await validTask());
    const invalid = await create('admin', contentId, { ...await validTask(), assigneeMembershipId: randomUUID() });

    expect(denied.statusCode).toBe(403);
    expect(w.statements.some((statement) => /count\(\*\)/.test(statement))).toBe(false);
    error(invalid, 400, 'CONTENT_TASK_ASSIGNEE_INVALID');
  });
});

describe('a task is the content\'s, the content the client\'s and the client the agency\'s, never another\'s (issue #255)', () => {
  const NOT_FOUND = { code: 'NOT_FOUND', message: 'Task not found.' };
  const ROUTES: ReadonlyArray<readonly [string, (ids: { contentId: string; taskId: string }, clientId?: string, agencyId?: string) => Promise<Reply>]> = [
    ['edit', (ids, clientId = clientA) => patch('admin', ids, { title: 'Outro' }, clientId)],
    ['deliver', (ids, clientId = clientA) => move('admin', 'deliver', ids, undefined, clientId)],
    ['approve', (ids, clientId = clientA) => move('admin', 'approve', ids, undefined, clientId)],
    ['return', (ids, clientId = clientA) => move('admin', 'return', ids, { comment: 'Falta algo.' }, clientId)]
  ];

  it.each(ROUTES)('%s: the id of a task of another content of the same client is the same 404, and the task is untouched', async (_name, run) => {
    const own = await t.scenario(clientA, { assignee: 'admin' });
    const stranger = await t.scenario(clientA, { assignee: 'admin' });
    const before = await t.taskRow(stranger.taskId);

    const reply = await run({ contentId: own.contentId, taskId: stranger.taskId });

    expect(reply.statusCode).toBe(404);
    expect(reply.json().error).toEqual(NOT_FOUND);
    expect(await t.taskRow(stranger.taskId)).toEqual(before);
  });

  it.each(ROUTES)('%s: the wrong client of the same agency is a 404, and the task is untouched', async (_name, run) => {
    const ids = await t.scenario(clientA2, { assignee: 'admin' });
    const before = await t.taskRow(ids.taskId);

    const reply = await run(ids, clientA);

    expect(reply.statusCode).toBe(404);
    expect(reply.json().error.code).toBe('NOT_FOUND');
    expect(await t.taskRow(ids.taskId)).toEqual(before);
  });

  it.each(ROUTES)('%s: a task that does not exist and a malformed id are the same 404', async (_name, run) => {
    const own = await t.scenario(clientA, { assignee: 'admin' });

    expect((await run({ contentId: own.contentId, taskId: randomUUID() })).json().error).toEqual(NOT_FOUND);
    expect((await run({ contentId: own.contentId, taskId: 'not-a-uuid' })).json().error).toEqual(NOT_FOUND);
    expect((await run({ contentId: 'not-a-uuid', taskId: own.taskId })).json().error).toEqual({ code: 'NOT_FOUND', message: 'Content not found.' });
  });

  it.each(ROUTES)('%s: a client of another agency is a 404', async (_name, run) => {
    const own = await t.scenario(clientA, { assignee: 'admin' });

    const reply = await run(own, clientB);

    expect(reply.statusCode).toBe(404);
    expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message: 'Client not found.' });
  });

  it('a person of two agencies cannot reach a task of one through the other, and the admin of another agency is refused', async () => {
    const ids = await t.scenario(clientA, { assignee: 'dual', owner: 'dual', status: 'delivered' });

    const through = await w.call('POST', people.dual.cookie, t.taskUrl(clientA, ids.contentId, ids.taskId, 'approve', w.agencyB));
    const foreign = await w.call('POST', people.adminB.cookie, t.taskUrl(clientA, ids.contentId, ids.taskId, 'approve'));
    const created = await w.call('POST', people.adminB.cookie, t.tasksUrl(clientA, ids.contentId), await validTask());

    expect(through.statusCode).toBe(404);
    expect([403, 404]).toContain(foreign.statusCode);
    expect([403, 404]).toContain(created.statusCode);
    expect(await statusOf(ids.taskId)).toBe('delivered');
    expect(await t.countTasks(ids.contentId)).toBe(1);
  });

  it('create on a content that is not the client\'s, absent or malformed answers the same 404', async () => {
    const foreignContent = await w.seedContent(clientA2, { ownerUserId: people.manager.id });

    const wrongClient = await create('admin', foreignContent, await validTask(), clientA);
    const absent = await create('admin', randomUUID(), await validTask());
    const malformed = await create('admin', 'not-a-uuid', await validTask());

    for (const reply of [wrongClient, absent, malformed]) {
      expect(reply.statusCode).toBe(404);
      expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message: 'Content not found.' });
    }
    expect(await t.countTasks(foreignContent)).toBe(0);
  });
});

describe('the client archived: a task is read-only in the agency (rule 14)', () => {
  it('answers 409 CLIENT_ARCHIVED to create, edit, deliver, approve and return, and writes nothing', async () => {
    const clientId = await w.newClient('archived-routes', { status: 'archived' });
    const contentId = await w.seedContent(clientId, { ownerUserId: people.manager.id });
    const pending = await t.seedTask(contentId, { status: 'pending', assignee: 'reader' });
    const delivered = await t.seedTask(contentId, { status: 'delivered', assignee: 'reader' });
    const before = [await t.taskRow(pending), await t.taskRow(delivered)];

    error(await create('admin', contentId, await validTask(), clientId), 409, 'CLIENT_ARCHIVED');
    error(await patch('admin', { contentId, taskId: pending }, { title: 'Outro' }, clientId), 409, 'CLIENT_ARCHIVED');
    error(await move('reader', 'deliver', { contentId, taskId: pending }, undefined, clientId), 409, 'CLIENT_ARCHIVED');
    error(await move('manager', 'approve', { contentId, taskId: delivered }, undefined, clientId), 409, 'CLIENT_ARCHIVED');
    error(await move('manager', 'return', { contentId, taskId: delivered }, { comment: 'Falta algo.' }, clientId), 409, 'CLIENT_ARCHIVED');

    expect([await t.taskRow(pending), await t.taskRow(delivered)]).toEqual(before);
    expect(await t.countTasks(contentId)).toBe(2);
  });
});
