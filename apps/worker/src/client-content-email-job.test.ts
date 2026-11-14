import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import type { OutgoingEmail } from '@ageniza/email';
import { describe, expect, it, vi } from 'vitest';

import {
  approvalUrlFor,
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

const APPROVAL_TYPES = ['content_awaiting_approval', 'content_approval_due_soon', 'content_approval_overdue'];
const BATCH_1 = '00000000-0000-4000-8000-0000000000f1';
const BATCH_2 = '00000000-0000-4000-8000-0000000000f2';

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
    approvalDueOn: null,
    approvalNote: null,
    approvalBatchId: null,
    ...overrides
  };
};

// The queue answers as the database does: a claim hands over what is waiting, once; the recheck returns what still holds and
// what the claim handed over under that token; the answers to `markSent` and `fail` count what the token still holds. The
// test says only what in the world changed (`stopsHolding`), never what the job should compute.
const fakeQueue = (
  waiting: ClaimedNotification[][],
  options: { stopsHolding?: (itemId: string) => boolean; markFails?: number; issueFails?: boolean } = {}
) => {
  const claimsLeft = [...waiting];
  const calls: Array<{ call: string; itemIds?: readonly string[]; token?: string; code?: string }> = [];
  const held = new Map<string, ClaimedNotification>();
  const sent = new Set<string>();
  const released = new Map<string, string>();
  // What the database keeps of a link: the hash it was handed and the items it was handed it for. Never the token.
  const issued: Array<{ tokenHash: string; itemIds: readonly string[] }> = [];
  let markFails = options.markFails ?? 0;
  const queue: NotificationQueue = {
    issueApprovalLink: async (itemIds, token, tokenHash) => {
      calls.push({ call: 'issueApprovalLink', itemIds, token });
      // The function refuses what is not a live claim of items of approval (the send and its two reminders, not the summary of "published")
      // and a hash that is not a sha256 in hex.
      const live = itemIds.length > 0 && itemIds.every((id) => {
        const claimed = held.get(id);
        return claimed !== undefined && claimed.claimToken === token && APPROVAL_TYPES.includes(claimed.notificationType) && !sent.has(id) && !released.has(id);
      });
      if (!live || !/^[0-9a-f]{64}$/.test(tokenHash)) throw Object.assign(new Error('The items and the claim do not describe one e-mail.'), { code: 'A0101' });
      if (options.issueFails === true) throw Object.assign(new Error('The agency is read-only: its trial has ended.'), { code: 'A0090' });
      issued.push({ tokenHash, itemIds });
    },
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
  return { queue, calls, sent, released, issued };
};

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
/** The approval link of an e-mail: the one link in its text. */
const linkOf = (email: OutgoingEmail): string => /https?:\/\/\S+/.exec(email.text)![0];

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

  it('sends ONE e-mail to a mailbox that two accesses of the client resolve to, with the content once, and stamps both items', async () => {
    const shared = item({ recipientPortalAccessId: PERSON_1, recipientEmail: 'ana@padaria.test' });
    const twin = item({ recipientPortalAccessId: PERSON_2, recipientEmail: 'ana@padaria.test', contentId: shared.contentId, contentTitle: shared.contentTitle });
    const { queue, sent } = fakeQueue([[shared, twin]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toBe('ana@padaria.test');
    expect(emails[0]!.subject).toBe('um conteúdo para você aprovar: Padaria Sol');
    expect(emails[0]!.text.split(shared.contentTitle)).toHaveLength(2);
    expect([...sent].sort()).toEqual([shared.itemId, twin.itemId].sort());
  });

  it('points the e-mail of the summary of published to the portal of its own client, with nothing of the person in the link', async () => {
    const { queue } = fakeQueue([[
      item({ notificationType: 'content_published' }),
      item({ notificationType: 'content_published', clientId: CLIENT_B, clientName: 'Loja Lua' })
    ]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    const links = emails.map(linkOf);
    expect(links.sort()).toEqual([`${ORIGIN}/portal/${CLIENT_A}/calendario`, `${ORIGIN}/portal/${CLIENT_B}/calendario`].sort());
    for (const link of links) {
      expect(new URL(link).search).toBe('');
      expect(new URL(link).hash).toBe('');
      expect(link).not.toMatch(/token|invite|sessao|session/i);
    }
    expect(portalUrlFor('http://127.0.0.1:5173', CLIENT_A)).toBe(`http://127.0.0.1:5173/portal/${CLIENT_A}/calendario`);
  });

  describe('the approval link of the e-mail "contents to approve" (issue #712)', () => {
    it('carries a link of its own in each e-mail: the token in the fragment, never in the query, and the database holds only its hash', async () => {
      const first = [item(), item()];
      const second = [item({ recipientPortalAccessId: PERSON_2, recipientEmail: 'bia@padaria.test' })];
      const { queue, issued } = fakeQueue([[...first, ...second]]);
      const { sender, emails } = senderThatRecords();

      await run(queue, sender);

      const links = emails.map(linkOf);
      expect(links).toHaveLength(2);
      for (const link of links) {
        const url = new URL(link);
        expect(url.origin + url.pathname).toBe(`${ORIGIN}/aprovar`);
        expect(url.search).toBe('');
        expect(url.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/);
      }
      expect(new Set(links.map((link) => new URL(link).hash)).size).toBe(2);
      // The hash the database was handed is the hash of the token that went into the e-mail: computed here, not handed to the fake.
      expect(issued.map((link) => link.tokenHash).sort()).toEqual(links.map((link) => sha256(new URL(link).hash.slice(1))).sort());
      expect(emails.map((email) => email.html).join('')).toContain('/aprovar#');
    });

    it('issues the link for the items that still hold after the recheck, and only for them', async () => {
      const group = [item(), item(), item()];
      const gone = group[1]!.itemId;
      const { queue, calls, issued } = fakeQueue([group], { stopsHolding: (id) => id === gone });
      const { sender } = senderThatRecords();

      await run(queue, sender);

      expect(issued).toHaveLength(1);
      expect([...issued[0]!.itemIds].sort()).toEqual([group[0]!.itemId, group[2]!.itemId].sort());
      // The link exists before the e-mail leaves and the claim is stamped after it.
      expect(calls.map((call) => call.call)).toEqual(['claim', 'recheck', 'issueApprovalLink', 'markSent', 'claim']);
    });

    it('issues no link for the summary of published, which carries the portal', async () => {
      const { queue, calls } = fakeQueue([[item({ notificationType: 'content_published' })]]);
      const { sender, emails } = senderThatRecords();

      await run(queue, sender);

      expect(emails).toHaveLength(1);
      expect(calls.map((call) => call.call)).not.toContain('issueApprovalLink');
    });

    it('sends nothing and releases the items with a code when the link cannot be issued, and says nothing of why', async () => {
      const group = [item(), item()];
      const { queue, calls, released, sent } = fakeQueue([group], { issueFails: true });
      const { sender, send } = senderThatRecords();

      const captured = await run(queue, sender);

      expect(send).not.toHaveBeenCalled();
      expect(sent.size).toBe(0);
      expect([...released.entries()].sort()).toEqual(group.map((claimed) => [claimed.itemId, 'approval_link_failed']).sort());
      expect(calls.filter((call) => call.call === 'markSent')).toEqual([]);
      const text = await captured.text();
      for (const secret of ['read-only', 'trial', 'A0090', 'ana@padaria.test', TOKEN, group[0]!.itemId]) expect(text).not.toContain(secret);
      expect(await captured.records()).toContainEqual(expect.objectContaining({ errorCode: 'approval_link_failed', items: 2 }));
    });

    it('goes on to the next group when the link of one cannot be issued', async () => {
      const first = [item({ recipientPortalAccessId: PERSON_1 })];
      const second = [item({ recipientPortalAccessId: PERSON_2, recipientEmail: 'bia@padaria.test' })];
      const { queue, released, sent } = fakeQueue([[...first, ...second]]);
      const failing: NotificationQueue = {
        ...queue,
        issueApprovalLink: async (itemIds, token, tokenHash) => {
          if (itemIds.includes(first[0]!.itemId)) throw new Error('lock timeout');
          await queue.issueApprovalLink(itemIds, token, tokenHash);
        }
      };
      const { sender, emails } = senderThatRecords();

      await run(failing, sender);

      expect(emails.map((email) => email.to)).toEqual(['bia@padaria.test']);
      expect([...released.entries()]).toEqual([[first[0]!.itemId, 'approval_link_failed']]);
      expect([...sent]).toEqual([second[0]!.itemId]);
    });

    it('never writes the token, the link or its hash to the log', async () => {
      const { queue, issued } = fakeQueue([[item()]]);
      const { sender, emails } = senderThatRecords();

      const captured = await run(queue, sender);

      const token = new URL(linkOf(emails[0]!)).hash.slice(1);
      const text = await captured.text();
      for (const secret of [token, issued[0]!.tokenHash, '/aprovar', '#']) expect(text).not.toContain(secret);
    });

    it('builds the link of the page from the origin: the token after the hash, whatever the origin carries', () => {
      expect(approvalUrlFor('https://app.ageniza.example', 'abc_DEF-123')).toBe('https://app.ageniza.example/aprovar#abc_DEF-123');
      expect(approvalUrlFor('https://app.ageniza.example/ignored?x=1#y', 'tok')).toBe('https://app.ageniza.example/aprovar#tok');
      expect(approvalUrlFor('http://127.0.0.1:5173', 'tok')).toBe('http://127.0.0.1:5173/aprovar#tok');
    });
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
    expect(calls.map((call) => call.call)).toEqual(['claim', 'recheck', 'issueApprovalLink', 'markSent', 'claim']);
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

describe('the deadline and the note of the e-mail "contents to approve" (decision 2026-11-10)', () => {
  const dated = (overrides: Partial<ClaimedNotification> = {}): ClaimedNotification => item({ approvalBatchId: BATCH_1, approvalDueOn: '2026-11-13', approvalNote: 'Oi! Segue a pauta.', ...overrides });

  it('groups the contents of ONE e-mail by the send they came with, each send with its own deadline and note, and the legacy contents with neither', async () => {
    const one = [dated({ contentTitle: 'Post A' }), dated({ contentTitle: 'Post B' })];
    const two = [dated({ contentTitle: 'Post C', approvalBatchId: BATCH_2, approvalDueOn: '2026-11-16', approvalNote: 'Segundo envio' })];
    const legacy = [item({ contentTitle: 'Post D' })];
    const { queue, sent } = fakeQueue([[one[0]!, two[0]!, legacy[0]!, one[1]!]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(emails).toHaveLength(1);
    expect(emails[0]!.template).toBe('contents-awaiting-approval');
    // Two sends and a legacy group are one e-mail of four contents; the subject names a deadline only if every send has one.
    expect(emails[0]!.subject).toBe('4 conteúdos para você aprovar: Padaria Sol');
    const text = emails[0]!.text;
    expect(text).toContain('Aprovar até sexta, 13/11\n\nRecado:\nOi! Segue a pauta.\n— Agência Aurora\n\n- Post A (20/10/2026)\n- Post B (20/10/2026)');
    expect(text).toContain('Aprovar até segunda, 16/11\n\nRecado:\nSegundo envio\n— Agência Aurora\n\n- Post C (20/10/2026)');
    expect(text).toContain('- Post D (20/10/2026)');
    expect(text.split('Aprovar até')).toHaveLength(3);
    expect(text.split('Recado:')).toHaveLength(3);
    expect(text.indexOf('Post A')).toBeLessThan(text.indexOf('Post C'));
    expect(text.indexOf('Post C')).toBeLessThan(text.indexOf('Post D'));
    expect([...sent].sort()).toEqual([...one, ...two, ...legacy].map((claimed) => claimed.itemId).sort());
  });

  it('keeps the contents from before the rounds in one list, with no deadline and no note, as the e-mail always was', async () => {
    const { queue } = fakeQueue([[item({ contentTitle: 'Post A' }), item({ contentTitle: 'Post B' }), item({ contentTitle: 'Post C' })]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(emails[0]!.text.split('\n\n').slice(0, 3)).toEqual([
      'Agência Aurora enviou 3 conteúdos de Padaria Sol para a sua aprovação.',
      '- Post A (20/10/2026)\n- Post B (20/10/2026)\n- Post C (20/10/2026)',
      expect.stringContaining('Abra o link')
    ]);
    expect(emails[0]!.html).toContain('<ul><li>Post A (20/10/2026)</li><li>Post B (20/10/2026)</li><li>Post C (20/10/2026)</li></ul>');
  });

  it('cites the deadline in the subject when the send has one, and the e-mail of a legacy content leaves as it did', async () => {
    const withDeadline = [dated(), dated()];
    const legacy = [item({ clientId: CLIENT_B, clientName: 'Loja Lua' })];
    const { queue } = fakeQueue([[...withDeadline, ...legacy]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    const byClient = (name: string) => emails.find((email) => email.subject.includes(name))!;
    expect(byClient('Padaria Sol').subject).toBe('2 conteúdos para você aprovar até sexta, 13/11: Padaria Sol');
    expect(byClient('Loja Lua').subject).toBe('um conteúdo para você aprovar: Loja Lua');
    expect(byClient('Loja Lua').text).not.toMatch(/Aprovar até|Recado/);
    expect(byClient('Loja Lua').html).not.toMatch(/Aprovar até|Recado|blockquote/);
  });

  it('signs the note by the agency and escapes it: what is typed never starts markup, a header or a line of the subject', async () => {
    const hostile = '<script>alert(1)</script>\r\n<img src=x onerror="alert(2)"> & "q"\r\nBcc: alguem@exemplo.test\r\n\r\n</blockquote><p>fim';
    const { queue } = fakeQueue([[dated({ approvalNote: hostile })]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    const [email] = emails;
    expect(email!.html).not.toContain('<script');
    expect(email!.html).not.toContain('<img');
    expect(email!.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br>&lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp; &quot;q&quot;<br>Bcc: alguem@exemplo.test<br><br>&lt;/blockquote&gt;&lt;p&gt;fim<br>— Agência Aurora</blockquote>');
    expect(email!.html.match(/<blockquote>/g)).toHaveLength(1);
    expect(email!.text).toContain('Recado:\n<script>alert(1)</script>\n<img src=x onerror="alert(2)"> & "q"\nBcc: alguem@exemplo.test\n\n</blockquote><p>fim\n— Agência Aurora');
    expect(email!.subject).toBe('um conteúdo para você aprovar até sexta, 13/11: Padaria Sol');
  });

  it('does not log the note, the deadline or the send', async () => {
    const { queue } = fakeQueue([[dated({ approvalNote: 'Recado secreto da campanha' })]]);
    const { sender } = senderThatRecords();

    const captured = await run(queue, sender);

    const text = await captured.text();
    for (const secret of ['Recado secreto', 'sexta', '2026-11-13', BATCH_1]) expect(text).not.toContain(secret);
  });
});

describe('the reminders of approval, "vence amanhã" and "venceu" (decision 2026-11-10)', () => {
  const reminder = (type: string, overrides: Partial<ClaimedNotification> = {}): ClaimedNotification =>
    item({ notificationType: type, approvalBatchId: BATCH_1, approvalDueOn: '2026-11-13', approvalNote: 'Preciso do seu OK.', ...overrides });

  it.each([
    ['content_approval_due_soon', 'approval-due-soon', 'Vence amanhã: aprovar 2 conteúdos de Padaria Sol', 'o prazo termina amanhã'],
    ['content_approval_overdue', 'approval-overdue', 'Prazo vencido: aprovar 2 conteúdos de Padaria Sol', 'o prazo já passou']
  ])('sends the %s e-mail with the approval link, the contents that wait and the deadline', async (type, template, subject, sentence) => {
    const group = [reminder(type, { contentTitle: 'Post A' }), reminder(type, { contentTitle: 'Post B' })];
    const { queue, calls, issued, sent } = fakeQueue([group]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(emails).toHaveLength(1);
    const [email] = emails;
    expect(email!.template).toBe(template);
    expect(email!.to).toBe('ana@padaria.test');
    expect(email!.subject).toBe(subject);
    expect(email!.text).toContain(sentence);
    expect(email!.text).toContain('Prazo: sexta, 13/11\n\nRecado:\nPreciso do seu OK.\n— Agência Aurora\n\n- Post A (20/10/2026)\n- Post B (20/10/2026)');
    expect(email!.text).toContain('O link vale por 7 dias, abre só os conteúdos deste e-mail e não pede que você crie uma conta.');
    // The link is the approval link of the person, issued for the items of this e-mail before it leaves.
    const url = new URL(linkOf(email!));
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/aprovar`);
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/);
    expect(issued).toHaveLength(1);
    expect([...issued[0]!.itemIds].sort()).toEqual(group.map((claimed) => claimed.itemId).sort());
    expect(issued[0]!.tokenHash).toBe(sha256(url.hash.slice(1)));
    expect(email!.html).toContain(`<a href="${linkOf(email!)}">`);
    expect(calls.map((call) => call.call)).toEqual(['claim', 'recheck', 'issueApprovalLink', 'markSent', 'claim']);
    expect([...sent].sort()).toEqual(group.map((claimed) => claimed.itemId).sort());
  });

  it('sends the reminders and the send as separate e-mails to the same person, each with a link of its own', async () => {
    const send = [item({ contentTitle: 'Pauta de segunda' })];
    const soon = [reminder('content_approval_due_soon', { contentTitle: 'Reels de terça' })];
    const overdue = [reminder('content_approval_overdue', { contentTitle: 'Foto de quarta' })];
    const { queue, issued } = fakeQueue([[...send, ...soon, ...overdue]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(emails.map((email) => email.template).sort()).toEqual(['approval-due-soon', 'approval-overdue', 'contents-awaiting-approval']);
    expect(new Set(emails.map(linkOf)).size).toBe(3);
    expect(issued).toHaveLength(3);
    for (const email of emails) {
      const others = ['Pauta de segunda', 'Reels de terça', 'Foto de quarta'].filter((title) => !email.text.includes(title));
      expect(others).toHaveLength(2);
    }
  });

  it.each(['content_approval_due_soon', 'content_approval_overdue'])('issues the link of %s only for the items that still hold after the recheck', async (type) => {
    const group = [reminder(type), reminder(type), reminder(type)];
    const gone = group[1]!.itemId;
    const { queue, issued, sent } = fakeQueue([group], { stopsHolding: (id) => id === gone });
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect([...issued[0]!.itemIds].sort()).toEqual([group[0]!.itemId, group[2]!.itemId].sort());
    expect(emails[0]!.subject).toContain('2 conteúdos');
    expect([...sent].sort()).toEqual([group[0]!.itemId, group[2]!.itemId].sort());
  });

  it.each(['content_approval_due_soon', 'content_approval_overdue'])('sends nothing and issues no link when nothing of the %s group holds any more', async (type) => {
    const { queue, calls } = fakeQueue([[reminder(type)]], { stopsHolding: () => true });
    const { sender, send } = senderThatRecords();

    await run(queue, sender);

    expect(send).not.toHaveBeenCalled();
    expect(calls.map((call) => call.call)).toEqual(['claim', 'recheck', 'claim']);
  });

  it.each(['content_approval_due_soon', 'content_approval_overdue'])('releases the %s items with a code, sending nothing, when the link cannot be issued', async (type) => {
    const group = [reminder(type), reminder(type)];
    const { queue, released, sent } = fakeQueue([group], { issueFails: true });
    const { sender, send } = senderThatRecords();

    const captured = await run(queue, sender);

    expect(send).not.toHaveBeenCalled();
    expect(sent.size).toBe(0);
    expect([...released.entries()].sort()).toEqual(group.map((claimed) => [claimed.itemId, 'approval_link_failed']).sort());
    expect(await captured.records()).toContainEqual(expect.objectContaining({ errorCode: 'approval_link_failed', items: 2, notificationType: type }));
  });

  it.each(['content_approval_due_soon', 'content_approval_overdue'])('releases the %s items with the code of the provider when the e-mail fails, and does not stamp them', async (type) => {
    const group = [reminder(type)];
    const { queue, released, sent } = fakeQueue([group]);
    const { sender } = senderThatRecords([Object.assign(new Error('450 full'), { responseCode: 450 })]);

    await run(queue, sender);

    expect([...released.entries()]).toEqual([[group[0]!.itemId, 'smtp_temporary']]);
    expect(sent.size).toBe(0);
  });

  it.each(['content_approval_due_soon', 'content_approval_overdue'])('writes only counts to the log, never the note, the link or the contents of %s', async (type) => {
    const { queue, issued } = fakeQueue([[reminder(type, { contentTitle: 'Lançamento secreto', approvalNote: 'Recado secreto' })]]);
    const { sender, emails } = senderThatRecords();

    const captured = await run(queue, sender);

    const token = new URL(linkOf(emails[0]!)).hash.slice(1);
    const text = await captured.text();
    for (const secret of ['Lançamento secreto', 'Recado secreto', token, issued[0]!.tokenHash, 'ana@padaria.test', 'Padaria Sol', 'Agência Aurora', '/aprovar']) expect(text).not.toContain(secret);
    expect(await captured.records()).toContainEqual(expect.objectContaining({ claimedGroups: 1, sent: 1 }));
  });

  it('issues no link for the summary of published even beside a reminder, and gives it the portal', async () => {
    const { queue, issued } = fakeQueue([[reminder('content_approval_due_soon'), item({ notificationType: 'content_published' })]]);
    const { sender, emails } = senderThatRecords();

    await run(queue, sender);

    expect(issued).toHaveLength(1);
    expect(emails.find((email) => email.template === 'contents-published')!.text).toContain(`${ORIGIN}/portal/${CLIENT_A}/calendario`);
  });
});
