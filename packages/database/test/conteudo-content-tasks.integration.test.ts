import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld } from './support/content-world.js';

// Issue #249 (specs/conteudo.md §4, §5 rules 1 and 10, §6): the subtasks of a content. Approving a subtask depends
// on the VALUE (who owns the content), not only on a key, so every guard is attacked with a custom role holding
// the one permission, and with the content owner who holds nothing else than conteudo.visualizar.
const w = createContentWorld('conteudo-tasks');
const { ids } = w;

const NOT_FOUND = { code: 'A0070' };
const NOT_ALLOWED = { code: 'A0074' };
const WRONG_STATE = { code: 'A0071' };
const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };
const deniedByGrant = { code: '42501', message: expect.stringContaining('permission denied for table content_tasks') };

let content: string;
let onlyOperar: string;
let onlyVisualizar: string;
let operarAndVisualizar: string;
let ownerOnlyVisualizar: string;
let approverWithVisualizar: string;
let approverWithoutVisualizar: string;
let contentOfOwner: string;

beforeAll(async () => {
  await w.setup();
  onlyOperar = await w.personWith('conteudo.operar');
  onlyVisualizar = await w.personWith('conteudo.visualizar');
  operarAndVisualizar = await w.personWith('conteudo.operar', 'conteudo.visualizar');
  ownerOnlyVisualizar = await w.personWith('conteudo.visualizar');
  approverWithVisualizar = await w.personWith('conteudo.aprovar_pela_agencia', 'conteudo.visualizar');
  approverWithoutVisualizar = await w.personWith('conteudo.aprovar_pela_agencia');
  content = await w.seedContent(ids.clientA1, { owner: ids.productionA });
  contentOfOwner = await w.seedContent(ids.clientA1, { owner: ownerOnlyVisualizar });
});

afterAll(async () => {
  await w.teardown();
});

const fn = (user: string, signature: string, ...args: unknown[]): Promise<unknown> =>
  w.asUser(user, (transaction) => transaction.raw(`select app_private.${signature}`, args as never[]));
const deliverAs = (user: string, id: string) => fn(user, 'deliver_content_task(?::uuid)', id);
const approveAs = (user: string, id: string) => fn(user, 'approve_content_task(?::uuid)', id);
const returnAs = (user: string, id: string, comment: string | null) => fn(user, 'return_content_task(?::uuid, ?::text)', id, comment);

const asOwnerWithActor = async (actor: string, work: (transaction: Knex.Transaction) => Promise<unknown>): Promise<void> => {
  await w.getOwner().transaction(async (transaction) => {
    await transaction.raw('select app_private.bind_actor(?::uuid)', [actor]);
    await work(transaction);
  });
};

const insertTask = (user: string, contentId: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  return w.asUser(user, (transaction) => transaction('content_tasks').insert({
    id, content_id: contentId, client_id: ids.clientA1, title: 'Gravar o vídeo', assignee_user_id: ids.productionA, due_on: '2026-10-15', ...extra
  })).then(() => id);
};

const updateTask = (user: string, id: string, patch: Record<string, unknown>): Promise<number> =>
  w.asUser(user, (transaction) => transaction('content_tasks').where({ id }).update(patch));

describe('who creates a subtask (issue #249)', () => {
  it.each([
    ['Admin', () => ids.adminA],
    ['Production', () => ids.productionA],
    ['the Owner of the agency, by ownership', () => ids.ownerA],
    ['a role with conteudo.operar and conteudo.visualizar', () => operarAndVisualizar]
  ] as const)('lets %s create a pending subtask', async (_label, user) => {
    const id = await insertTask(user(), content);

    expect(await w.taskRow(id)).toMatchObject({ status: 'pending', return_comment: null, content_id: content, client_id: ids.clientA1 });
  });

  it.each([
    ['Sales', () => ids.salesA],
    ['Finance', () => ids.financeA],
    ['a role with only conteudo.operar, because a write that cannot read its own row is blind', () => onlyOperar],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal of the client', () => ids.portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('refuses %s a subtask, leaving no row', async (_label, user) => {
    const id = randomUUID();

    await expect(w.asUser(user(), (transaction) => transaction('content_tasks').insert({
      id, content_id: content, client_id: ids.clientA1, title: 'x', assignee_user_id: ids.productionA, due_on: '2026-10-15'
    }))).rejects.toMatchObject(rlsViolation);

    expect(await w.getOwner().knex('content_tasks').where({ id }).select('id')).toHaveLength(0);
  });

  it('refuses a subtask for a content of an archived client', async () => {
    const archived = await w.seedContent(ids.clientArchived);
    await w.archiveClient(ids.clientArchived);

    try {
      await expect(insertTask(ids.adminA, archived, { client_id: ids.clientArchived })).rejects.toMatchObject(rlsViolation);
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
  });

  it.each([
    ['status', { status: 'approved' }],
    ['return_comment', { return_comment: 'x' }],
    ['created_at', { created_at: new Date(0) }]
  ] as const)('refuses to let the caller choose %s on the INSERT, at the privilege layer', async (_label, extra) => {
    await expect(insertTask(ids.adminA, content, extra)).rejects.toMatchObject(deniedByGrant);
  });

  it.each([
    ['Sales, who cannot see Conteúdo', () => ids.salesA],
    ['a role with only conteudo.operar, who cannot read what they would have to deliver', () => onlyOperar],
    ['a person of the portal', () => ids.portalA1],
    ['a person of another agency', () => ids.adminB],
    ['a person that does not exist', () => randomUUID()]
  ] as const)('refuses %s as the person in charge', async (_label, assignee) => {
    await expect(insertTask(ids.adminA, content, { assignee_user_id: assignee() })).rejects.toMatchObject({ code: 'A0073' });
  });

  it('refuses as the person in charge a collaborator whose link to the agency was removed', async () => {
    const removed = await w.personWith('conteudo.visualizar');
    await w.getOwner().knex('agency_memberships').where({ user_id: removed }).update({ status: 'removed' });

    await expect(insertTask(ids.adminA, content, { assignee_user_id: removed })).rejects.toMatchObject({ code: 'A0073' });
  });

  it.each([
    ['the Owner of the agency, who holds no membership', () => ids.ownerA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar]
  ] as const)('accepts %s as the person in charge', async (_label, assignee) => {
    const id = await insertTask(ids.adminA, content, { assignee_user_id: assignee() });

    expect((await w.taskRow(id)).assignee_user_id).toBe(assignee());
  });

  it('refuses a subtask tied to a content of another client, and one with no title, no day or a title that is only spaces', async () => {
    await expect(insertTask(ids.adminA, content, { client_id: ids.clientA2 })).rejects.toMatchObject({ code: '23503', constraint: 'content_tasks_content_fk' });
    await expect(insertTask(ids.adminA, content, { title: String.fromCharCode(0xa0, 0x20) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertTask(ids.adminA, content, { due_on: null })).rejects.toMatchObject({ code: '23502' });
    await expect(insertTask(ids.adminA, content, { title: 'a'.repeat(1025) })).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['published', 'cancelled'] as const)('refuses a subtask for a %s content', async (status) => {
    const closed = await w.seedContent(ids.clientA1, { status });

    await expect(insertTask(ids.adminA, closed)).rejects.toMatchObject(WRONG_STATE);
  });

  it.each(['awaiting_approval', 'approved'] as const)('lets a subtask be added to a content that is %s, which keeps its state', async (status) => {
    const open = await w.seedContent(ids.clientA1, { status });

    await insertTask(ids.adminA, open);

    expect((await w.getOwner().knex('contents').where({ id: open }).first('status'))?.status).toBe(status);
  });
});

describe('editing a subtask (issue #249)', () => {
  it.each(['pending', 'delivered'] as const)('lets an operator edit a %s subtask', async (status) => {
    const id = await w.seedTask(content, { status });

    expect(await updateTask(ids.productionA, id, { title: 'Novo título', description: 'Detalhe', due_on: '2026-11-01', assignee_user_id: ids.managerA })).toBe(1);

    expect(await w.taskRow(id)).toMatchObject({ title: 'Novo título', description: 'Detalhe', assignee_user_id: ids.managerA, status });
  });

  it('does not edit an approved subtask, which is what was approved', async () => {
    const id = await w.seedTask(content, { status: 'approved' });
    const before = await w.taskRow(id);

    await expect(updateTask(ids.productionA, id, { title: 'Trocado' })).rejects.toMatchObject(WRONG_STATE);

    expect(await w.taskRow(id)).toEqual(before);
  });

  it.each(['published', 'cancelled'] as const)('does not edit the subtask of a %s content', async (status) => {
    const id = await w.seedTaskOfClosedContent(ids.clientA1, status);

    await expect(updateTask(ids.productionA, id, { title: 'Trocado' })).rejects.toMatchObject(WRONG_STATE);
  });

  it('refuses a new person in charge who cannot see Conteúdo', async () => {
    const id = await w.seedTask(content);

    await expect(updateTask(ids.adminA, id, { assignee_user_id: ids.salesA })).rejects.toMatchObject({ code: 'A0073' });
    expect((await w.taskRow(id)).assignee_user_id).toBe(ids.productionA);
  });

  it.each([
    ['status', () => ({ status: 'approved' })],
    ['return_comment', () => ({ return_comment: 'x' })],
    ['content_id', () => ({ content_id: contentOfOwner })],
    ['client_id', () => ({ client_id: ids.clientA2 })],
    ['id', () => ({ id: randomUUID() })],
    ['created_at', () => ({ created_at: new Date(0) })]
  ] as const)('refuses an UPDATE of %s at the privilege layer, to an Admin who sees the row', async (_label, patch) => {
    const id = await w.seedTask(content);
    const before = await w.taskRow(id);

    await expect(w.asUser(ids.adminA, async (transaction) => {
      expect(await transaction('content_tasks').where({ id }).select('id')).toHaveLength(1);
      return await transaction('content_tasks').where({ id }).update(patch());
    })).rejects.toMatchObject(deniedByGrant);

    expect(await w.taskRow(id)).toEqual(before);
  });

  it.each([
    ['Sales', () => ids.salesA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a role with only conteudo.operar', () => onlyOperar],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal', () => ids.portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare]
  ] as const)('changes nothing of a subtask for %s: the UPDATE reaches no row', async (_label, user) => {
    const id = await w.seedTask(content);
    const before = await w.taskRow(id);

    expect(await updateTask(user(), id, { title: 'Invadido' })).toBe(0);

    expect(await w.taskRow(id)).toEqual(before);
  });
});

describe('deliver: pending to delivered, by the person in charge only (issue #249)', () => {
  it('lets the person in charge deliver, changing the state and nothing else', async () => {
    const id = await w.seedTask(content, { assignee: ids.productionA });
    const before = await w.taskRow(id);

    await deliverAs(ids.productionA, id);

    expect(await w.taskRow(id)).toEqual({ ...before, status: 'delivered' });
  });

  it.each([
    ['the Admin, who reads the subtask but is not in charge of it', () => ids.adminA],
    ['the Owner of the agency', () => ids.ownerA],
    ['the owner of the content', () => ownerOnlyVisualizar],
    ['a role with every conteudo.* permission, who is not in charge', () => ids.managerA]
  ] as const)('says %s may not: the answer is the one of a person who reads the task', async (_label, user) => {
    const id = await w.seedTask(contentOfOwner, { assignee: ids.productionA });
    const before = await w.taskRow(id);

    await expect(deliverAs(user(), id)).rejects.toMatchObject(NOT_ALLOWED);

    expect(await w.taskRow(id)).toEqual(before);
  });

  it.each([
    ['Sales', () => ids.salesA],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal of the client', () => ids.portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('answers "not found" to %s, and the answer is the one of a task that does not exist', async (_label, user) => {
    const id = await w.seedTask(content, { assignee: ids.productionA });
    const before = await w.taskRow(id);

    const forTask = await deliverAs(user(), id).catch((error: unknown) => error);
    const forUnknown = await deliverAs(user(), randomUUID()).catch((error: unknown) => error);

    expect(forTask).toMatchObject(NOT_FOUND);
    expect((forTask as { message: string }).message).toBe((forUnknown as { message: string }).message);
    expect(await w.taskRow(id)).toEqual(before);
  });

  it('answers "not found" to a person in charge who can no longer see Conteúdo, because a write needs the read', async () => {
    const assignee = await w.personWith('conteudo.visualizar');
    const id = await w.seedTask(content, { assignee });
    await w.getOwner().knex('agency_memberships').where({ user_id: assignee }).update({ status: 'removed' });

    await expect(deliverAs(assignee, id)).rejects.toMatchObject(NOT_FOUND);

    expect((await w.taskRow(id)).status).toBe('pending');
  });

  it('is idempotent for a delivered subtask, and refuses an approved one', async () => {
    const delivered = await w.seedTask(content, { status: 'delivered' });
    const approved = await w.seedTask(content, { status: 'approved' });
    const before = await w.taskRow(delivered);

    await deliverAs(ids.productionA, delivered);

    expect(await w.taskRow(delivered)).toEqual(before);
    await expect(deliverAs(ids.productionA, approved)).rejects.toMatchObject(WRONG_STATE);
  });

  it('refuses the subtask of an archived client and of a published or cancelled content', async () => {
    const archived = await w.seedTask(await w.seedContent(ids.clientArchived));
    const [published, cancelled] = [await w.seedTaskOfClosedContent(ids.clientA1, 'published'), await w.seedTaskOfClosedContent(ids.clientA1, 'cancelled')];
    await w.archiveClient(ids.clientArchived);

    try {
      await expect(deliverAs(ids.productionA, archived)).rejects.toMatchObject({ code: 'A0061' });
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
    await expect(deliverAs(ids.productionA, published)).rejects.toMatchObject(WRONG_STATE);
    await expect(deliverAs(ids.productionA, cancelled)).rejects.toMatchObject(WRONG_STATE);
  });
});

describe('approve and return: the owner of the content, or who approves for the agency (issue #249, acceptance 6)', () => {
  it.each([
    ['the owner of the content, who holds only conteudo.visualizar', () => ownerOnlyVisualizar],
    ['a role with only conteudo.aprovar_pela_agencia and conteudo.visualizar, who is not the owner', () => approverWithVisualizar],
    ['the Account manager, by the preset', () => ids.managerA],
    ['the Admin', () => ids.adminA],
    ['the Owner of the agency, by ownership', () => ids.ownerA]
  ] as const)('lets %s approve a delivered subtask and return another with a comment', async (_label, user) => {
    const [toApprove, toReturn] = [await w.seedTask(contentOfOwner, { status: 'delivered' }), await w.seedTask(contentOfOwner, { status: 'delivered' })];

    await approveAs(user(), toApprove);
    await returnAs(user(), toReturn, 'Falta o áudio');

    const approved = await w.taskRow(toApprove);
    expect(approved).toMatchObject({ status: 'approved', approved_by: user() });
    expect(Math.abs((approved.approved_at as Date).getTime() - Date.now())).toBeLessThan(10_000);
    expect(await w.taskRow(toReturn)).toMatchObject({ status: 'pending', return_comment: 'Falta o áudio' });
  });

  it.each([
    ['Production, who is not the owner of the content and holds no conteudo.aprovar_pela_agencia', async () => ids.productionA],
    ['a role with every conteudo.* permission but conteudo.aprovar_pela_agencia, who is not the owner', () => w.personWithAllBut('conteudo.aprovar_pela_agencia')]
  ] as const)('says %s may not approve nor return, leaving the subtask delivered', async (_label, user) => {
    const person = await user();
    const id = await w.seedTask(contentOfOwner, { status: 'delivered', assignee: ids.productionA });
    const before = await w.taskRow(id);

    await expect(approveAs(person, id)).rejects.toMatchObject(NOT_ALLOWED);
    await expect(returnAs(person, id, 'x')).rejects.toMatchObject(NOT_ALLOWED);

    expect(await w.taskRow(id)).toEqual(before);
  });

  it('says a person who may only read may not, even when asked to approve their own delivery', async () => {
    const id = await w.seedTask(contentOfOwner, { status: 'delivered', assignee: onlyVisualizar });

    await expect(approveAs(onlyVisualizar, id)).rejects.toMatchObject(NOT_ALLOWED);

    expect((await w.taskRow(id)).status).toBe('delivered');
  });

  it.each([
    ['a role with only conteudo.aprovar_pela_agencia, who cannot read the subtask', () => approverWithoutVisualizar],
    ['Sales', () => ids.salesA],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal of the client', () => ids.portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('answers "not found" to %s', async (_label, user) => {
    const id = await w.seedTask(contentOfOwner, { status: 'delivered' });
    const before = await w.taskRow(id);

    await expect(approveAs(user(), id)).rejects.toMatchObject(NOT_FOUND);
    await expect(returnAs(user(), id, 'x')).rejects.toMatchObject(NOT_FOUND);

    expect(await w.taskRow(id)).toEqual(before);
  });

  it('lets the owner of the content who is also the person in charge approve what they delivered', async () => {
    const id = await w.seedTask(contentOfOwner, { status: 'delivered', assignee: ownerOnlyVisualizar });

    await approveAs(ownerOnlyVisualizar, id);

    expect((await w.taskRow(id)).status).toBe('approved');
  });

  it('follows the owner of the content when it changes: the former owner may not and the new one may', async () => {
    const moved = await w.seedContent(ids.clientA1, { owner: ownerOnlyVisualizar });
    const id = await w.seedTask(moved, { status: 'delivered' });
    await w.asUser(ids.adminA, (transaction) => transaction('contents').where({ id: moved }).update({ owner_user_id: onlyVisualizar }));

    await expect(approveAs(ownerOnlyVisualizar, id)).rejects.toMatchObject(NOT_ALLOWED);
    await approveAs(onlyVisualizar, id);

    expect((await w.taskRow(id)).status).toBe('approved');
  });

  it.each([
    ['null', null], ['empty', ''], ['spaces', '   '], ['a no-break space', String.fromCharCode(0xa0)], ['more than 5000 bytes', 'a'.repeat(5001)]
  ] as const)('refuses to return a subtask with a comment that is %s', async (_label, comment) => {
    const id = await w.seedTask(contentOfOwner, { status: 'delivered' });

    await expect(returnAs(ids.adminA, id, comment)).rejects.toMatchObject({ code: 'A0068' });

    expect((await w.taskRow(id)).status).toBe('delivered');
  });

  it('clears the comment of a return when the subtask is delivered again', async () => {
    const id = await w.seedTask(contentOfOwner, { status: 'delivered', assignee: ids.productionA });
    await returnAs(ids.adminA, id, 'Refazer');

    await deliverAs(ids.productionA, id);

    expect(await w.taskRow(id)).toMatchObject({ status: 'delivered', return_comment: null });
  });

  it('is idempotent for an approved subtask, and refuses to approve or return one that was not delivered', async () => {
    const approved = await w.seedTask(contentOfOwner, { status: 'approved' });
    const pending = await w.seedTask(contentOfOwner, { status: 'pending' });
    const before = await w.taskRow(approved);

    await approveAs(ids.adminA, approved);

    expect(await w.taskRow(approved)).toEqual(before);
    await expect(returnAs(ids.adminA, approved, 'x')).rejects.toMatchObject(WRONG_STATE);
    await expect(approveAs(ids.adminA, pending)).rejects.toMatchObject(WRONG_STATE);
    await expect(returnAs(ids.adminA, pending, 'x')).rejects.toMatchObject(WRONG_STATE);
  });

  it('refuses the subtask of an archived client and of a published or cancelled content', async () => {
    const archived = await w.seedTask(await w.seedContent(ids.clientArchived), { status: 'delivered' });
    const closed = await w.seedTaskOfClosedContent(ids.clientA1, 'published', 'delivered');
    await w.archiveClient(ids.clientArchived);

    try {
      await expect(approveAs(ids.adminA, archived)).rejects.toMatchObject({ code: 'A0061' });
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
    await expect(approveAs(ids.adminA, closed)).rejects.toMatchObject(WRONG_STATE);
  });
});

describe('the owner of a content cannot be moved to approve a subtask (issue #249, review A2)', () => {
  it('refuses the person who delivers a subtask to make themselves the owner and approve it, step by step', async () => {
    const attacker = await w.personWith('conteudo.operar', 'conteudo.visualizar');
    const reviewed = await w.seedContent(ids.clientA1, { owner: ids.managerA });
    const id = await w.seedTask(reviewed, { assignee: attacker });

    await deliverAs(attacker, id);
    await expect(approveAs(attacker, id)).rejects.toMatchObject(NOT_ALLOWED);
    await expect(w.asUser(attacker, (transaction) => transaction('contents').where({ id: reviewed }).update({ owner_user_id: attacker })))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('approves for the agency') });
    await expect(approveAs(attacker, id)).rejects.toMatchObject(NOT_ALLOWED);

    expect(await w.taskRow(id)).toMatchObject({ status: 'delivered', approved_by: null, approved_at: null });
    expect((await w.contentRow(reviewed)).owner_user_id).toBe(ids.managerA);
  });

  it('records who approved a subtask and when, from the actor and the clock, whatever the statement names', async () => {
    const id = await w.seedTask(contentOfOwner, { status: 'delivered' });

    await asOwnerWithActor(ids.managerA, (transaction) => transaction('content_tasks').where({ id }).update({
      status: 'approved', approved_by: ids.adminA, approved_at: new Date('2000-01-01T00:00:00.000Z')
    }));

    const row = await w.taskRow(id);
    expect(row.approved_by).toBe(ids.managerA);
    expect(Math.abs((row.approved_at as Date).getTime() - Date.now())).toBeLessThan(10_000);
  });

  it('does not approve a subtask without an actor, and does not rewrite who approved it', async () => {
    const delivered = await w.seedTask(contentOfOwner, { status: 'delivered' });
    const approved = await w.seedTask(contentOfOwner, { status: 'approved' });

    await expect(w.getOwner().knex('content_tasks').where({ id: delivered }).update({ status: 'approved' }))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('approved by a person') });
    await expect(asOwnerWithActor(ids.adminA, (transaction) => transaction('content_tasks').where({ id: approved }).update({ approved_by: ids.managerA })))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('who approved it') });

    expect((await w.taskRow(delivered)).status).toBe('delivered');
    expect((await w.taskRow(approved)).approved_by).toBe(ids.adminA);
  });

  it('refuses a task that is approved with nobody approving, and one with an approver that is not approved', async () => {
    await expect(w.getOwner().knex('content_tasks').insert({ content_id: contentOfOwner, client_id: ids.clientA1, title: 'x', assignee_user_id: ids.productionA, due_on: '2026-10-15', status: 'approved' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'content_tasks_approval_shape' });
    await expect(w.getOwner().knex('content_tasks').insert({ content_id: contentOfOwner, client_id: ids.clientA1, title: 'x', assignee_user_id: ids.productionA, due_on: '2026-10-15', approved_by: ids.adminA, approved_at: new Date() }))
      .rejects.toMatchObject({ code: '23514', constraint: 'content_tasks_approval_shape' });
  });

  it.each(['approved_by', 'approved_at'] as const)('refuses an UPDATE and an INSERT of %s at the privilege layer', async (column) => {
    const id = await w.seedTask(content);
    const value = column === 'approved_by' ? ids.adminA : new Date();

    await expect(updateTask(ids.adminA, id, { [column]: value })).rejects.toMatchObject(deniedByGrant);
    await expect(insertTask(ids.adminA, content, { [column]: value })).rejects.toMatchObject(deniedByGrant);
  });
});

describe('the trigger holds the direction of a subtask for every writer (issue #249)', () => {
  it.each([
    ['pending', 'approved'], ['approved', 'pending'], ['approved', 'delivered']
  ] as const)('refuses %s -> %s, even to the schema owner, and leaves the row as it was', async (from, to) => {
    const id = await w.seedTask(content, { status: from });
    const before = await w.taskRow(id);

    await expect(asOwnerWithActor(ids.adminA, (transaction) => transaction('content_tasks').where({ id }).update({ status: to })))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('only moves') });

    expect(await w.taskRow(id)).toEqual(before);
  });

  it('refuses a change of state that carries another change, a return without a comment, and a comment without a state', async () => {
    const delivered = await w.seedTask(content, { status: 'delivered' });
    const pending = await w.seedTask(content, { status: 'pending' });

    await expect(w.getOwner().knex('content_tasks').where({ id: delivered }).update({ status: 'approved', title: 'Outro' }))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('no other change') });
    await expect(w.getOwner().knex('content_tasks').where({ id: delivered }).update({ status: 'pending' }))
      .rejects.toMatchObject({ code: 'A0068' });
    await expect(w.getOwner().knex('content_tasks').where({ id: pending }).update({ return_comment: 'solto' }))
      .rejects.toBeDefined();
  });

  it('never changes the identity of a subtask, for any writer', async () => {
    const id = await w.seedTask(content);

    await expect(w.getOwner().knex('content_tasks').where({ id }).update({ content_id: contentOfOwner }))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('identity') });
  });
});

describe('a subtask is not edited while its content is being closed (issue #249, concurrency)', () => {
  it('waits for the cancellation of the content, then refuses the edit', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'in_production' });
    const taskId = await w.seedTask(id);
    const closing = await w.openTransactionAs(ids.managerA);
    let editing: Promise<unknown> | undefined;

    try {
      await closing.raw('select app_private.cancel_content(?::uuid)', [id]);
      editing = updateTask(ids.productionA, taskId, { title: 'Tarde demais' }).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await closing.commit();
    }

    expect(await editing).toMatchObject(WRONG_STATE);
    expect((await w.taskRow(taskId)).title).not.toBe('Tarde demais');
  });
});

describe('a subtask is read by the agency with conteudo.visualizar, and by nobody else (issue #249, acceptance 5)', () => {
  it('shows the subtasks to who reads Conteúdo, and no row to anyone else, a client link included', async () => {
    const task = await w.seedTask(await w.seedContent(ids.clientA1, { status: 'awaiting_approval' }));
    const readable = [ids.adminA, ids.ownerA, ids.productionA, ids.managerA, onlyVisualizar, ids.dualFull];
    const blind = [ids.salesA, ids.financeA, onlyOperar, ids.adminB, ids.portalA1, ids.portalA1Second, ids.portalA2, ids.portalB, ids.dualBare, ids.crossDual];

    for (const user of readable) {
      expect(await w.asUser(user, (transaction) => transaction('content_tasks').where({ id: task }).select('id')), String(user)).toHaveLength(1);
    }
    for (const user of blind) {
      expect(await w.asUser(user, (transaction) => transaction('content_tasks').select('id')), String(user)).toHaveLength(0);
    }
  });
});
