import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import type { OutgoingEmail } from '@ageniza/email';
import { describe, expect, it, vi } from 'vitest';

import {
  CLIENT_CONTENT_EMAIL_JOB_NAME,
  CLIENT_CONTENT_EMAIL_SCHEDULE,
  clientContentEmailJob,
  failureCodeOf,
  portalUrlFor
} from './client-content-email-job.js';
import type { ClaimedNotification, NotificationQueue } from './notification-queue.js';

const ORIGIN = 'https://app.ageniza.example';
const TOKEN = '11111111-1111-4111-8111-111111111111';
const CLIENT_A = '00000000-0000-4000-8000-0000000000a1';
const CLIENT_B = '00000000-0000-4000-8000-0000000000b1';
const PERSON_1 = '00000000-0000-4000-8000-0000000000e1';
const PERSON_2 = '00000000-0000-4000-8000-0000000000e2';

let counter = 0;
const item = (overrides: Partial<ClaimedNotification> = {}): ClaimedNotification => {
  counter += 1;
  return {
    itemId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    claimToken: TOKEN,
    notificationType: 'content_awaiting_approval',
    clientId: CLIENT_A,
    clientName: 'Padaria Sol',
    agencyName: 'Agência Aurora',
    recipientPortalAccessId: PERSON_1,
    recipientEmail: 'ana@padaria.test',
    contentId: `00000000-0000-4000-8000-c${String(counter).padStart(11, '0')}`,
    contentTitle: `Post ${counter}`,
    contentPublishOn: '2026-10-20',
    ...overrides
  };
};

// The queue answers as the database does: a claim hands over what is waiting, once; the recheck returns what still holds and
// what the claim handed over under that token; the answers to `markSent` and `fail` count what the token still holds. The
// test says only what in the world changed (`stopsHolding`), never what the job should compute.
const fakeQueue = (waiting: ClaimedNotification[][], options: { stopsHolding?: (itemId: string) => boolean; markFails?: number } = {}) => {
  const claimsLeft = [...waiting];
  const calls: Array<{ call: string; itemIds?: readonly string[]; token?: string; code?: string }> = [];
  const held = new Map<string, ClaimedNotification>();
  const sent = new Set<string>();
  const released = new Map<string, string>();
  let markFails = options.markFails ?? 0;
  const queue: NotificationQueue = {
    claim: async (limit) => {
      calls.push({ call: 'claim' });
      expect(limit).toBe(10);
      const next = claimsLeft.shift() ?? [];
      for (const claimed of next) held.set(claimed.itemId, claimed);
      return next;
    },
    recheck: async (itemIds, token) => {
      calls.push({ call: 'recheck', itemIds, token });
      return itemIds.flatMap((id) => {
        const claimed = held.get(id);
        return claimed !== undefined && claimed.claimToken === token && !sent.has(id) && !released.has(id) && options.stopsHolding?.(id) !== true ? [claimed] : [];
      });
    },
    markSent: async (itemIds, token) => {
      calls.push({ call: 'markSent', itemIds, token });
      if (markFails > 0) {
        markFails -= 1;
        throw new Error('connection reset');
      }
      const marked = itemIds.filter((id) => held.get(id)?.claimToken === token && !sent.has(id) && !released.has(id));
      for (const id of marked) sent.add(id);
      return marked.length;
    },
    fail: async (itemIds, token, code) => {
      calls.push({ call: 'fail', itemIds, token, code });
      const failed = itemIds.filter((id) => held.get(id)?.claimToken === token && !sent.has(id) && !released.has(id));
      for (const id of failed) released.set(id, code);
      return failed.length;
    }
  };
  return { queue, calls, sent, released };
};

const captureLogger = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return {
    logger: createLogger({}, destination),
    async text(): Promise<string> {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return output.join('');
    },
    async records(): Promise<Array<Record<string, unknown>>> {
      return (await this.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    }
  };
};

const senderThatRecords = (failures: Array<Error | undefined> = []) => {
  const emails: OutgoingEmail[] = [];
  const send = vi.fn(async (email: OutgoingEmail): Promise<void> => {
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
    emails.push(email);
  });
  return { sender: { send }, emails, send };
};

const run = async (
  queue: NotificationQueue,
  sender: { send(email: OutgoingEmail): Promise<void> },
  extra: { signal?: AbortSignal; now?: () => number } = {}
) => {
  const captured = captureLogger();
  const definition = clientContentEmailJob({ queue, sender, appPublicUrl: ORIGIN, ...(extra.now === undefined ? {} : { now: extra.now }) });
  await definition.handler(
    { id: 'job-1', name: CLIENT_CONTENT_EMAIL_JOB_NAME, payload: {}, attempt: 1 },
    { logger: captured.logger, signal: extra.signal ?? new AbortController().signal }
  );
  return captured;
};

describe('notifications.send-client-content-emails (issue #260)', () => {
  it('is named and scheduled as decided: every minute in Brasília, and once at every start', () => {
    const definition = clientContentEmailJob({ queue: fakeQueue([]).queue, sender: senderThatRecords().sender, appPublicUrl: ORIGIN });

    expect(definition.name).toBe('notifications.send-client-content-emails');
    expect(definition.schedule).toEqual({ cron: '* * * * *', timeZone: 'America/Sao_Paulo' });
    expect(CLIENT_CONTENT_EMAIL_SCHEDULE).toEqual({ cron: '* * * * *', timeZone: 'America/Sao_Paulo' });
    expect(definition.runOnStart).toBe(true);
    expect(definition.concurrency).toBe(1);
  });

  it('sends ONE e-mail per person, client and type, with every content of the group, and stamps exactly what it sent', async () => {
    const group = [item(), item(), item()];
    const otherPerson = [item({ recipientPortalAccessId: PERSON_2, recipientEmail: 'bia@padaria.test' })];
    const otherClient = [item({ clientId: CLIENT_B, clientName: 'Loja Lua' })];
    const published = [item({ notificationType: 'content_published' })];
    const { queue, sent } = fakeQueue([[...group, ...otherPerson, ...otherClient, ...published]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(emails).toHaveLength(4);
    const byRecipientAndTemplate = (to: string, template: string) => emails.filter((email) => email.to === to && email.template === template);
    const forGroup = byRecipientAndTemplate('ana@padaria.test', 'contents-awaiting-approval').filter((email) => email.subject.includes('Padaria Sol'));
    expect(forGroup).toHaveLength(1);
    expect(forGroup[0]!.subject).toBe('3 conteúdos para você aprovar: Padaria Sol');
    for (const content of group) expect(forGroup[0]!.text).toContain(content.contentTitle);
    expect(forGroup[0]!.text).not.toContain(otherPerson[0]!.contentTitle);
    expect(byRecipientAndTemplate('bia@padaria.test', 'contents-awaiting-approval')).toHaveLength(1);
    expect(emails.filter((email) => email.subject.includes('Loja Lua'))).toHaveLength(1);
    expect(byRecipientAndTemplate('ana@padaria.test', 'contents-published')).toHaveLength(1);
    expect(byRecipientAndTemplate('ana@padaria.test', 'contents-published')[0]!.subject).toBe('um conteúdo publicado: Padaria Sol');
    expect([...sent].sort()).toEqual([...group, ...otherPerson, ...otherClient, ...published].map((claimed) => claimed.itemId).sort());
  });

  it('points each e-mail to the portal of its own client, with nothing of the person in the link', async () => {
    const { queue } = fakeQueue([[item(), item({ clientId: CLIENT_B, clientName: 'Loja Lua' })]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    const links = emails.map((email) => /https?:\/\/\S+/.exec(email.text)![0]);
    expect(links.sort()).toEqual([`${ORIGIN}/portal/${CLIENT_A}/calendario`, `${ORIGIN}/portal/${CLIENT_B}/calendario`].sort());
    for (const link of links) {
      expect(new URL(link).search).toBe('');
      expect(new URL(link).hash).toBe('');
      expect(link).not.toMatch(/token|invite|sessao|session/i);
    }
    expect(portalUrlFor('http://127.0.0.1:5173', CLIENT_A)).toBe(`http://127.0.0.1:5173/portal/${CLIENT_A}/calendario`);
  });

  it('escapes what comes from the content in the HTML of the e-mail', async () => {
    const hostile = item({ contentTitle: '<img src=x onerror=alert(1)> & co', clientName: 'A <b>B</b>' });
    const { queue } = fakeQueue([[hostile]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(emails[0]!.html).not.toContain('<img');
    expect(emails[0]!.html).not.toContain('<b>');
    expect(emails[0]!.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; co');
  });

  it('judges again right before the send: what stopped holding is not sent and not stamped, and the rest of the group is', async () => {
    const group = [item(), item(), item()];
    const gone = group[1]!.itemId;
    const { queue, calls, sent } = fakeQueue([group], { stopsHolding: (id) => id === gone });
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(emails).toHaveLength(1);
    expect(emails[0]!.text).toContain(group[0]!.contentTitle);
    expect(emails[0]!.text).not.toContain(group[1]!.contentTitle);
    expect(emails[0]!.text).toContain(group[2]!.contentTitle);
    expect(emails[0]!.subject).toBe('2 conteúdos para você aprovar: Padaria Sol');
    expect([...sent].sort()).toEqual([group[0]!.itemId, group[2]!.itemId].sort());
    const markCall = calls.find((call) => call.call === 'markSent');
    expect(markCall?.itemIds).toEqual([group[0]!.itemId, group[2]!.itemId]);
    // the recheck comes after the claim and before the send, for this group's items
    expect(calls.map((call) => call.call)).toEqual(['claim', 'recheck', 'markSent', 'claim']);
  });

  it('sends nothing, and stamps nothing, when nothing of the group holds any more', async () => {
    const group = [item(), item()];
    const { queue, calls } = fakeQueue([group], { stopsHolding: () => true });
    const { sender, send } = senderThatRecords();

    await run(queue, sender);

    expect(send).not.toHaveBeenCalled();
    expect(calls.map((call) => call.call)).toEqual(['claim', 'recheck', 'claim']);
  });

  it('releases the items with a code, and no text of the provider, when the provider fails; it neither stamps nor repeats them', async () => {
    const group = [item(), item()];
    const provider = Object.assign(new Error('450 Mailbox ana@padaria.test is full'), { responseCode: 450 });
    const { queue, calls, sent, released } = fakeQueue([group]);
    const { sender, send } = senderThatRecords([provider]);

    const captured = await run(queue, sender);

    expect(send).toHaveBeenCalledTimes(1);
    expect(sent.size).toBe(0);
    expect([...released.entries()].sort()).toEqual(group.map((claimed) => [claimed.itemId, 'smtp_temporary']).sort());
    expect(calls.filter((call) => call.call === 'markSent')).toEqual([]);
    const text = await captured.text();
    for (const secret of ['ana@padaria.test', 'Mailbox', 'is full', TOKEN, group[0]!.itemId, group[0]!.contentTitle, 'Padaria Sol', CLIENT_A, PERSON_1]) expect(text).not.toContain(secret);
    expect(await captured.records()).toContainEqual(expect.objectContaining({ errorCode: 'smtp_temporary', items: 2 }));
  });

  it('goes on to the next group after a failure, and a group that failed is not sent again in the same run', async () => {
    const first = [item({ recipientPortalAccessId: PERSON_1 })];
    const second = [item({ recipientPortalAccessId: PERSON_2, recipientEmail: 'bia@padaria.test' })];
    const { queue, released, sent } = fakeQueue([[...first, ...second]]);
    const { sender, emails } = senderThatRecords([new Error('socket hang up')]);

    await run(queue, sender);

    expect(emails.map((email) => email.to)).toEqual(['bia@padaria.test']);
    expect([...released.keys()]).toEqual([first[0]!.itemId]);
    expect([...sent]).toEqual([second[0]!.itemId]);
  });

  it('tries the stamp again when the database blinks after the e-mail left, so the next claim does not send it twice', async () => {
    const group = [item()];
    const { queue, calls, sent } = fakeQueue([group], { markFails: 2 });
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(emails).toHaveLength(1);
    expect(calls.filter((call) => call.call === 'markSent')).toHaveLength(3);
    expect([...sent]).toEqual([group[0]!.itemId]);
  });

  it('lets the error through, to be retried by the queue, when the stamp keeps failing', async () => {
    const { queue, calls } = fakeQueue([[item()]], { markFails: 5 });
    const { sender } = senderThatRecords();

    await expect(run(queue, sender)).rejects.toThrow('connection reset');
    expect(calls.filter((call) => call.call === 'markSent')).toHaveLength(3);
  });

  it('releases the items of a type it does not send, without sending anything', async () => {
    const odd = [item({ notificationType: 'invoice_due' })];
    const { queue, released } = fakeQueue([odd]);
    const { sender, send } = senderThatRecords();

    await run(queue, sender);

    expect(send).not.toHaveBeenCalled();
    expect([...released.entries()]).toEqual([[odd[0]!.itemId, 'unknown_type']]);
  });

  it('claims again until nothing is left, at most six times, ten groups at a time', async () => {
    const batches = Array.from({ length: 8 }, (_unused, index) => [item({ recipientPortalAccessId: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`, recipientEmail: `p${index}@padaria.test` })]);
    const { queue, calls } = fakeQueue(batches);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(calls.filter((call) => call.call === 'claim')).toHaveLength(6);
    expect(emails).toHaveLength(6);
  });

  it('stops claiming after four minutes of a run, so its last group is rechecked well inside the lease', async () => {
    const batches = [[item()], [item({ recipientPortalAccessId: PERSON_2, recipientEmail: 'bia@padaria.test' })]];
    const { queue, calls } = fakeQueue(batches);
    const { sender, emails } = senderThatRecords();
    const clock = [0, 1_000, 4 * 60 * 1000 + 1];

    await run(queue, sender, { now: () => clock.shift() ?? 10 * 60 * 1000 });

    expect(calls.filter((call) => call.call === 'claim')).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });

  it('does not claim at all once the worker is stopping', async () => {
    const controller = new AbortController();
    controller.abort();
    const { queue, calls } = fakeQueue([[item()]]);
    const { sender, send } = senderThatRecords();

    await run(queue, sender, { signal: controller.signal });

    expect(calls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('releases the groups it had claimed and did not reach when the worker stops in the middle', async () => {
    const controller = new AbortController();
    const first = [item({ recipientPortalAccessId: PERSON_1 })];
    const second = [item({ recipientPortalAccessId: PERSON_2, recipientEmail: 'bia@padaria.test' })];
    const { queue, released, sent } = fakeQueue([[...first, ...second]]);
    const { sender } = senderThatRecords();
    const stopping = { send: async (email: OutgoingEmail) => { await sender.send(email); controller.abort(); } };

    await run(queue, stopping, { signal: controller.signal });

    expect([...sent]).toEqual([first[0]!.itemId]);
    expect([...released.entries()]).toEqual([[second[0]!.itemId, 'worker_stopping']]);
  });

  it('writes counts to the log, and nothing of the person, the content, the client, the claim or the link', async () => {
    const group = [item({ contentTitle: 'Lançamento secreto' }), item()];
    const { queue } = fakeQueue([group]);
    const { sender } = senderThatRecords();

    const captured = await run(queue, sender);

    const text = await captured.text();
    expect(await captured.records()).toContainEqual(expect.objectContaining({ claimedGroups: 1, sent: 1, droppedItems: 0, failedGroups: 0, releasedGroups: 0 }));
    for (const secret of ['ana@padaria.test', 'Lançamento secreto', 'Padaria Sol', 'Agência Aurora', TOKEN, CLIENT_A, PERSON_1, group[0]!.itemId, group[0]!.contentId, '/portal/', 'token']) {
      expect(text).not.toContain(secret);
    }
  });

  it('names a failure by a code that is a legal error code of the queue, whatever the provider said', () => {
    const legal = /^[a-z0-9_.:-]{1,64}$/;
    const cases: Array<[unknown, string]> = [
      [Object.assign(new Error('x'), { responseCode: 421 }), 'smtp_temporary'],
      [Object.assign(new Error('x'), { responseCode: 550 }), 'smtp_rejected'],
      [Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'smtp_etimedout'],
      [Object.assign(new Error('x'), { code: 'EAUTH' }), 'smtp_eauth'],
      [Object.assign(new Error('x'), { code: 'ana@padaria.test' }), 'smtp_failed'],
      [Object.assign(new Error('x'), { code: 'X'.repeat(80) }), 'smtp_failed'],
      [new Error('Mailbox ana@padaria.test full'), 'smtp_failed'],
      ['text', 'smtp_failed'],
      [null, 'smtp_failed']
    ];
    for (const [error, expected] of cases) {
      expect(failureCodeOf(error)).toBe(expected);
      expect(failureCodeOf(error)).toMatch(legal);
    }
  });
});
