import type { DatabaseClient } from '@ageniza/database';
import { describe, expect, it, vi } from 'vitest';

import { createNotificationQueue, NOTIFICATION_TYPES } from './notification-queue.js';

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  item_id: '00000000-0000-4000-8000-000000000001',
  claim_token: '11111111-1111-4111-8111-111111111111',
  notification_type: 'content_awaiting_approval',
  client_id: '00000000-0000-4000-8000-0000000000a1',
  client_name: 'Padaria Sol',
  agency_name: 'Agência Aurora',
  recipient_portal_access_id: '00000000-0000-4000-8000-0000000000e1',
  recipient_email: 'ana@padaria.test',
  content_id: '00000000-0000-4000-8000-0000000000c1',
  content_title: 'Post 1',
  content_publish_on: '2026-10-20',
  approval_due_on: '2026-11-13',
  approval_note: 'Oi!\r\nSegue a pauta.',
  approval_batch_id: '00000000-0000-4000-8000-0000000000f1',
  ...overrides
});

// The queue is the four functions of the database; the fake is the driver: it records the statement and answers `{ rows }`.
const queueAnswering = (rows: Array<Record<string, unknown>>) => {
  const raw = vi.fn(async () => ({ rows }));
  const database = { transaction: async (work: (transaction: unknown) => Promise<unknown>) => work({ raw }) } as unknown as DatabaseClient;
  return { queue: createNotificationQueue(database), raw };
};

const expected = {
  itemId: '00000000-0000-4000-8000-000000000001',
  claimToken: '11111111-1111-4111-8111-111111111111',
  notificationType: 'content_awaiting_approval',
  clientId: '00000000-0000-4000-8000-0000000000a1',
  clientName: 'Padaria Sol',
  agencyName: 'Agência Aurora',
  recipientPortalAccessId: '00000000-0000-4000-8000-0000000000e1',
  recipientEmail: 'ana@padaria.test',
  contentId: '00000000-0000-4000-8000-0000000000c1',
  contentTitle: 'Post 1',
  contentPublishOn: '2026-10-20',
  approvalDueOn: '2026-11-13',
  approvalNote: 'Oi!\r\nSegue a pauta.',
  approvalBatchId: '00000000-0000-4000-8000-0000000000f1'
};

describe('the notification queue of the worker (the four functions of the database)', () => {
  it('knows the two reminders besides the send and the summary', () => {
    expect([...NOTIFICATION_TYPES]).toEqual(['content_awaiting_approval', 'content_published', 'content_approval_due_soon', 'content_approval_overdue']);
  });

  it.each([
    ['claim', (queue: ReturnType<typeof createNotificationQueue>) => queue.claim(10), 'claim_notification_batch'],
    ['recheck', (queue: ReturnType<typeof createNotificationQueue>) => queue.recheck(['00000000-0000-4000-8000-000000000001'], '11111111-1111-4111-8111-111111111111'), 'recheck_notifications']
  ])('reads the deadline, the note and the send of the round from the %s', async (_name, call, fn) => {
    const { queue, raw } = queueAnswering([row()]);

    expect(await call(queue)).toEqual([expected]);
    const sql = (raw.mock.calls as unknown as string[][])[0]![0]!;
    expect(sql).toContain(`app_private.${fn}(`);
    expect(sql).toContain('approval_due_on::text as approval_due_on');
    expect(sql).toContain('approval_note');
    expect(sql).toContain('approval_batch_id');
  });

  it('keeps the three as null for the summary of published and for a content from before the rounds', async () => {
    const { queue } = queueAnswering([row({ notification_type: 'content_published', approval_due_on: null, approval_note: null, approval_batch_id: null })]);

    expect(await queue.claim(10)).toEqual([{ ...expected, notificationType: 'content_published', approvalDueOn: null, approvalNote: null, approvalBatchId: null }]);
  });

  it('keeps the note as typed (line breaks included): cleaning it is the template\'s, where it is escaped', async () => {
    const { queue } = queueAnswering([row({ approval_note: '<b>x</b>\r\n\r\ny' })]);

    expect((await queue.claim(10))[0]!.approvalNote).toBe('<b>x</b>\r\n\r\ny');
  });

  it.each(['approval_due_on', 'approval_note', 'approval_batch_id'])('refuses an answer without %s: a function of the database that stopped returning it must not send an e-mail without its deadline', async (column) => {
    const answer = row();
    delete answer[column];
    const { queue } = queueAnswering([answer]);

    await expect(queue.claim(10)).rejects.toThrow(`did not return ${column}`);
  });

  it.each(['approval_due_on', 'approval_note', 'approval_batch_id'])('refuses a %s that is neither text nor null', async (column) => {
    const { queue } = queueAnswering([row({ [column]: 5 })]);

    await expect(queue.recheck(['00000000-0000-4000-8000-000000000001'], '11111111-1111-4111-8111-111111111111')).rejects.toThrow(`did not return ${column}`);
  });
});
