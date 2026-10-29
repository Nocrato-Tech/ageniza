import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import { createLocalTestDatabaseClient, raw, resolveIntegrationDatabaseUrls, type DatabaseClient } from '@ageniza/database';
import { createEmailSender, type EmailTransport } from '@ageniza/email';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CLIENT_CONTENT_EMAIL_JOB_NAME, clientContentEmailJob } from './client-content-email-job.js';
import { createNotificationQueue, type NotificationQueue } from './notification-queue.js';

// Issue #260, against the migrated local database as the application role, the one the worker uses in production, with the
// real functions of the queue and the real sender (only its transport is fake, and it answers as an SMTP server does: it
// accepts, or refuses with a reply code). The clock is the database's: what is due is moved with the owner connection.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();
const ORIGIN = 'https://app.ageniza.example';
const label = 'worker-client-email';

const id = () => randomUUID();
const ids = {
  agency: id(), agencySuspended: id(), ownerUser: id(), actor: id(), suspendedActor: id(),
  portal1: id(), portal2: id(), portal3: id()
};
const users = Object.values(ids).filter((value) => value !== ids.agency && value !== ids.agencySuspended);
const emailOf = (userId: string): string => `${userId}@${label}.test`;

let owner: DatabaseClient;
let application: DatabaseClient;
const clients: string[] = [];
const contents: string[] = [];

const knex = () => owner.knex;

const captureLogs = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return { logger: createLogger({}, destination), text: (): string => output.join('') };
};

interface SentMail { to: string; subject: string; text: string; html: string }
const mailbox = () => {
  const sent: SentMail[] = [];
  const failures: Array<Error | undefined> = [];
  const transport: EmailTransport = {
    async sendMail(message) {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      sent.push({ to: message.to, subject: message.subject, text: message.text, html: message.html });
      return { messageId: 'test-message-id' };
    }
  };
  return { sent, failures, transport };
};

const runJob = async (
  box: ReturnType<typeof mailbox>,
  options: { queue?: NotificationQueue; database?: DatabaseClient; logs?: ReturnType<typeof captureLogs> } = {}
): Promise<ReturnType<typeof captureLogs>> => {
  const logs = options.logs ?? captureLogs();
  const sender = createEmailSender({ smtpUrl: 'smtp://127.0.0.1:1025', from: 'Ageniza <no-reply@ageniza.local>', logger: logs.logger, transport: box.transport });
  const definition = clientContentEmailJob({ queue: options.queue ?? createNotificationQueue(options.database ?? application), sender, appPublicUrl: ORIGIN });
  await definition.handler({ id: 'job-1', name: CLIENT_CONTENT_EMAIL_JOB_NAME, payload: {}, attempt: 1 }, { logger: logs.logger, signal: new AbortController().signal });
  return logs;
};

const presetRole = async (key: string): Promise<string> =>
  (await knex()('roles').whereNull('agency_id').where({ key }).first('id')).id as string;

const defaultFolder = async (clientId: string): Promise<string> =>
  (await knex()('media_folders').where({ client_id: clientId, is_default: true }).first('id')).id as string;

const freshClient = async (people: readonly string[], agencyId: string = ids.agency, name = 'Padaria Sol'): Promise<string> => {
  const clientId = id();
  clients.push(clientId);
  await knex()('clients').insert({ id: clientId, agency_id: agencyId, name: `${name} ${clientId.slice(0, 8)}` });
  if (people.length > 0) await knex()('client_memberships').insert(people.map((user) => ({ client_id: clientId, user_id: user })));
  return clientId;
};

const seedContent = async (clientId: string, status: 'in_production' | 'approved' = 'in_production', title?: string, actor: string = ids.actor): Promise<string> => {
  const contentId = id();
  contents.push(contentId);
  await knex()('contents').insert({
    id: contentId, client_id: clientId, title: title ?? `Post ${contentId.slice(0, 8)}`, platform: 'instagram', format: 'reels',
    publish_on: '2026-10-20', publish_at_time: '18:30', caption: 'Legenda', folder_id: await defaultFolder(clientId), owner_user_id: actor, status,
    ...(status === 'approved' ? { approved_by: ids.portal1, approved_at: new Date('2026-10-05T12:00:00.000Z') } : {})
  });
  return contentId;
};

type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
const asActor = <T>(actor: string, work: (transaction: Transaction) => Promise<T>): Promise<T> =>
  knex().transaction(async (transaction) => {
    await transaction.raw('select app_private.bind_actor(?::uuid)', [actor]);
    return work(transaction);
  });

const sendForApproval = (contentId: string, actor: string = ids.actor) =>
  asActor(actor, (t) => t('contents').where({ id: contentId }).update({ status: 'awaiting_approval' }));
const approveByClient = (contentId: string) =>
  asActor(ids.portal1, (t) => t('contents').where({ id: contentId }).update({ status: 'approved', approved_by: ids.portal1, approved_at: new Date() }));
const publish = (contentId: string, actor: string = ids.actor) =>
  asActor(actor, (t) => t('contents').where({ id: contentId }).update({ status: 'published', published_on: t.raw("(now() at time zone 'America/Sao_Paulo')::date"), published_at: new Date() }));
const unpublish = (contentId: string) =>
  asActor(ids.actor, (t) => t('contents').where({ id: contentId }).update({ status: 'approved', published_on: null, published_at: null }));

// The whole queue moves back in time, as if `minutes` had passed since everything happened.
const ageQueue = (minutes: number) =>
  knex().raw(
    `update public.notification_queue set created_at = created_at - (?::integer * interval '1 minute'), send_after = send_after - (?::integer * interval '1 minute')
     where client_id = any(?::uuid[])`,
    [minutes, minutes, clients as never]
  );
// The queue names the access (#711); the tests talk about the account the access is linked to.
const itemsOf = (contentId: string) => knex()('notification_queue as item')
  .join('client_portal_accesses as access', 'access.id', 'item.recipient_portal_access_id')
  .where('item.content_id', contentId)
  .orderBy('access.user_id')
  .select('item.*', 'access.user_id as recipient_user_id') as unknown as Promise<Array<Record<string, unknown>>>;
// `every` on an empty list passes, so a content that never queued an item would prove nothing.
const expectDiscardedUnsent = async (contentId: string): Promise<void> => {
  const items = await itemsOf(contentId);
  expect(items.length).toBeGreaterThan(0);
  expect(items.every((row) => row.discarded_at !== null && row.sent_at === null)).toBe(true);
};
const sentItems = async (): Promise<number> =>
  Number((await knex()('notification_queue').whereIn('client_id', clients).whereNotNull('sent_at').count<Array<{ count: string }>>('* as count'))[0]!.count);

const afterClaim = (queue: NotificationQueue, hook: () => Promise<void>): NotificationQueue => ({
  ...queue,
  claim: async (limit) => {
    const claimed = await queue.claim(limit);
    if (claimed.length > 0) await hook();
    return claimed;
  }
});

const archive = (clientId: string) => knex()('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
/** The approval link in the text of an e-mail, and the token that is in its fragment. */
const approvalLinkOf = (mail: SentMail): { link: string; token: string } => {
  const link = /https?:\/\/\S+/.exec(mail.text)![0];
  return { link, token: new URL(link).hash.slice(1) };
};
const uuidsIn = (text: string): string[] => [...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])];

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const admin = await presetRole('admin');
  await knex().transaction(async (transaction) => {
    await transaction('auth.user').insert(users.map((userId) => ({ id: userId, name: `User ${userId}`, email: emailOf(userId), emailVerified: true })));
    await transaction('agencies').insert([
      { id: ids.agency, name: `Agência Aurora ${ids.agency.slice(0, 8)}`, owner_user_id: ids.ownerUser },
      { id: ids.agencySuspended, name: `Agência Suspensa ${ids.agencySuspended.slice(0, 8)}` }
    ]);
    await transaction('agency_memberships').insert([
      { agency_id: ids.agency, user_id: ids.actor, role_id: admin },
      { agency_id: ids.agencySuspended, user_id: ids.suspendedActor, role_id: admin }
    ]);
  });
});

beforeEach(async () => {
  await knex()('notification_queue').whereIn('client_id', clients).delete();
});

afterAll(async () => {
  try {
    await knex()('client_portal_approval_links').whereIn('client_id', clients).delete();
    await knex()('notification_queue').whereIn('client_id', clients).delete();
    await knex()('contents').whereIn('id', contents).delete();
    await knex()('media_folders').whereIn('client_id', clients).delete();
    await knex()('client_memberships').whereIn('client_id', clients).delete();
    await knex()('clients').whereIn('id', clients).delete();
    await knex()('agency_memberships').whereIn('agency_id', [ids.agency, ids.agencySuspended]).delete();
    await knex()('agencies').whereIn('id', [ids.agency, ids.agencySuspended]).delete();
    await knex()('auth.user').whereIn('id', users).delete();
  } finally {
    await application.close();
    await owner.close();
  }
});

describe('the e-mail to the client: contents to approve (issue #260)', () => {
  it('turns three sends in a row, less than 15 minutes apart, into ONE e-mail per person, once the last one is 15 minutes old', async () => {
    const client = await freshClient([ids.portal1, ids.portal2]);
    const [first, second, third] = [await seedContent(client), await seedContent(client), await seedContent(client)] as [string, string, string];
    await sendForApproval(first);
    await sendForApproval(second);
    await sendForApproval(third);
    const box = mailbox();

    await runJob(box);
    expect(box.sent).toEqual([]);

    await ageQueue(14);
    await runJob(box);
    expect(box.sent).toEqual([]);

    await ageQueue(2);
    await runJob(box);
    expect(box.sent.map((mail) => mail.to).sort()).toEqual([emailOf(ids.portal1), emailOf(ids.portal2)].sort());
    for (const mail of box.sent) {
      expect(mail.subject).toMatch(/^3 conteúdos para você aprovar: Padaria Sol /);
      for (const contentId of [first, second, third]) expect(mail.text).toContain(`Post ${contentId.slice(0, 8)}`);
    }
    expect(await sentItems()).toBe(6);

    await runJob(box);
    expect(box.sent).toHaveLength(2);
  });

  it('waits for the last send: an earlier one that is old enough does not leave alone while a newer one is inside its 15 minutes', async () => {
    const client = await freshClient([ids.portal1]);
    const older = await seedContent(client);
    const newer = await seedContent(client);
    await sendForApproval(older);
    await ageQueue(20);
    await sendForApproval(newer);
    const box = mailbox();

    await runJob(box);
    expect(box.sent).toEqual([]);

    await ageQueue(16);
    await runJob(box);
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.subject).toMatch(/^2 conteúdos para você aprovar/);
  });

  it('sends one e-mail per client to a person who has two, each with the approval link of its own batch', async () => {
    const first = await freshClient([ids.portal1], ids.agency, 'Padaria Sol');
    const second = await freshClient([ids.portal1], ids.agency, 'Loja Lua');
    const firstContent = await seedContent(first);
    const secondContent = await seedContent(second);
    await sendForApproval(firstContent);
    await sendForApproval(secondContent);
    await ageQueue(16);
    const box = mailbox();

    await runJob(box);

    expect(box.sent).toHaveLength(2);
    const links = box.sent.map((mail) => approvalLinkOf(mail));
    for (const { link, token } of links) {
      const url = new URL(link);
      expect(url.origin + url.pathname).toBe(`${ORIGIN}/aprovar`);
      expect(url.search).toBe('');
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(new Set(links.map(({ token }) => token)).size).toBe(2);
    for (const mail of box.sent) expect(mail.html).toContain(`<a href="${approvalLinkOf(mail).link}">`);

    // The link of each e-mail opens the contents of its own client in the database, and only those.
    const contentsOpenedBy = async (mail: SentMail): Promise<string[]> => {
      const session = randomUUID().replaceAll('-', '').repeat(2);
      const batch = await application.knex.transaction(async (transaction) => {
        await transaction.raw('select * from app_private.exchange_portal_approval_token(?, ?)', [sha256(approvalLinkOf(mail).token), session]);
        return (await transaction.raw<{ rows: Array<{ id: string }> }>('select id from app_private.portal_approval_contents(?)', [session])).rows;
      });
      return batch.map((row) => row.id);
    };
    expect(await contentsOpenedBy(box.sent.find((mail) => mail.subject.includes('Padaria Sol'))!)).toEqual([firstContent]);
    expect(await contentsOpenedBy(box.sent.find((mail) => mail.subject.includes('Loja Lua'))!)).toEqual([secondContent]);
  });

  it('issues one link per e-mail, tied to the access that received it, valid for seven days, and keeps only its hash', async () => {
    const client = await freshClient([ids.portal1, ids.portal2]);
    const content = await seedContent(client);
    await sendForApproval(content);
    await ageQueue(16);
    const box = mailbox();

    await runJob(box);

    expect(box.sent).toHaveLength(2);
    const stored = await knex()('client_portal_approval_links as link')
      .join('client_portal_accesses as access', 'access.id', 'link.portal_access_id')
      .where('link.client_id', client)
      .select('link.token_hash', 'link.generation', 'link.expires_at', 'link.created_at', 'access.user_id', 'access.generation as access_generation');
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.user_id).sort()).toEqual([ids.portal1, ids.portal2].sort());
    expect(stored.map((row) => row.token_hash as string).sort()).toEqual(box.sent.map((mail) => sha256(approvalLinkOf(mail).token)).sort());
    for (const row of stored) {
      expect(row.generation).toBe(row.access_generation);
      expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBeLessThanOrEqual(7 * 86_400_000);
      expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBeGreaterThan(6.9 * 86_400_000);
    }
    expect(JSON.stringify(stored)).not.toContain(approvalLinkOf(box.sent[0]!).token);
    // And each e-mail went to the address of the access that owns its link.
    for (const mail of box.sent) {
      const link = await knex()('client_portal_approval_links as link')
        .join('client_portal_accesses as access', 'access.id', 'link.portal_access_id')
        .where('link.token_hash', sha256(approvalLinkOf(mail).token)).first('access.user_id');
      expect(mail.to).toBe(emailOf(link!.user_id as string));
    }
  });

  it('sends nothing and issues no link when the agency went read-only after the claim: the item is released with the code, and the next claim discards it', async () => {
    const client = await freshClient([ids.portal1]);
    const content = await seedContent(client);
    await sendForApproval(content);
    await ageQueue(16);
    const queue = createNotificationQueue(application);
    const readOnly: NotificationQueue = {
      ...queue,
      recheck: async (itemIds, token) => {
        const kept = await queue.recheck(itemIds, token);
        await knex()('agencies').where({ id: ids.agency }).update({
          plan: 'trial', trial_ends_at: knex().raw("now() - interval '1 minute'"), trial_owner_email_key: knex().raw('coalesce(trial_owner_email_key, id::text)')
        });
        return kept;
      }
    };
    const box = mailbox();

    try {
      await runJob(box, { queue: readOnly });
    } finally {
      await knex()('agencies').where({ id: ids.agency }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
    }

    expect(box.sent).toEqual([]);
    expect(await knex()('client_portal_approval_links').where({ client_id: client })).toEqual([]);
    const [item] = await itemsOf(content);
    expect(item).toMatchObject({ sent_at: null, last_error: 'approval_link_failed' });
    expect(item!.discarded_at).not.toBeNull();
  });

  it('escapes in the HTML what the agency wrote in the title of the content', async () => {
    const client = await freshClient([ids.portal1]);
    await sendForApproval(await seedContent(client, 'in_production', '<script>alert(1)</script> & "promo"'));
    await ageQueue(16);
    const box = mailbox();

    await runJob(box);

    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.html).not.toContain('<script>');
    expect(box.sent[0]!.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;promo&quot;');
  });

  it('carries no token and no internal data in the body, and writes none to the log: only the client in the link', async () => {
    const client = await freshClient([ids.portal1, ids.portal2]);
    const contentId = await seedContent(client);
    await sendForApproval(contentId);
    await ageQueue(16);
    const claimTokens = new Set<string>();
    const queue = createNotificationQueue(application);
    const watching: NotificationQueue = { ...queue, claim: async (limit) => { const claimed = await queue.claim(limit); for (const row of claimed) claimTokens.add(row.claimToken); return claimed; } };
    const box = mailbox();

    const logs = await runJob(box, { queue: watching });

    expect(box.sent).toHaveLength(2);
    const itemIds = (await itemsOf(contentId)).map((row) => row.id as string);
    const forbidden = [...claimTokens, ...itemIds, ids.portal1, ids.portal2, contentId, ids.actor, ids.agency];
    expect(claimTokens.size).toBe(1);
    for (const mail of box.sent) {
      // The link of approval names no client, no content and no person: the token in its fragment is all there is.
      expect(uuidsIn(`${mail.subject}\n${mail.text}\n${mail.html}`)).toEqual([]);
      for (const secret of forbidden) expect(`${mail.subject}${mail.text}${mail.html}`).not.toContain(secret);
      expect(`${mail.text}${mail.html}`).not.toMatch(/token|claim|senha|password|session/i);
    }
    const log = logs.text();
    expect(log.length).toBeGreaterThan(0);
    for (const mail of box.sent) {
      const { token } = approvalLinkOf(mail);
      expect(log).not.toContain(token);
      expect(log).not.toContain(sha256(token));
    }
    for (const secret of [...forbidden, client, emailOf(ids.portal1), emailOf(ids.portal2), `Post ${contentId.slice(0, 8)}`, 'Padaria Sol', '/portal/']) expect(log).not.toContain(secret);
    expect(log).not.toMatch(/token/i);
  });
});

describe('no e-mail for what stopped being true (issue #260)', () => {
  const scenario = async (): Promise<{ client: string; content: string }> => {
    const client = await freshClient([ids.portal1, ids.portal2]);
    const content = await seedContent(client);
    await sendForApproval(content);
    await ageQueue(16);
    return { client, content };
  };

  it('sends nothing for a client archived before the claim, and the item is dropped, not held', async () => {
    const { client, content } = await scenario();
    await archive(client);
    const box = mailbox();

    await runJob(box);

    expect(box.sent).toEqual([]);
    expect((await itemsOf(content)).every((row) => row.discarded_at !== null && row.sent_at === null)).toBe(true);
  });

  it('sends nothing for a client archived AFTER the claim and before the send', async () => {
    const { client, content } = await scenario();
    const box = mailbox();

    await runJob(box, { queue: afterClaim(createNotificationQueue(application), async () => { await archive(client); }) });

    expect(box.sent).toEqual([]);
    const items = await itemsOf(content);
    expect(items.every((row) => row.discarded_at !== null && row.sent_at === null)).toBe(true);
    expect(items.every((row) => row.attempts === 1)).toBe(true);
  });

  it('sends nothing for an agency suspended AFTER the claim', async () => {
    const client = await freshClient([ids.portal3], ids.agencySuspended);
    const content = await seedContent(client, 'in_production', undefined, ids.suspendedActor);
    await sendForApproval(content, ids.suspendedActor);
    await ageQueue(16);
    const box = mailbox();

    try {
      await runJob(box, { queue: afterClaim(createNotificationQueue(application), async () => { await knex()('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' }); }) });
    } finally {
      await knex()('agencies').where({ id: ids.agencySuspended }).update({ status: 'active' });
    }

    expect(box.sent).toEqual([]);
    await expectDiscardedUnsent(content);
  });

  it('sends nothing for an agency whose trial ended, and discards the items (issue #708)', async () => {
    const client = await freshClient([ids.portal3], ids.agencySuspended);
    const content = await seedContent(client, 'in_production', undefined, ids.suspendedActor);
    await sendForApproval(content, ids.suspendedActor);
    await ageQueue(16);
    const box = mailbox();
    await knex()('agencies').where({ id: ids.agencySuspended }).update({ plan: 'trial', trial_ends_at: knex().raw("now() - interval '1 minute'"), trial_owner_email_key: `worker-${ids.agencySuspended}` });

    try {
      await runJob(box);
    } finally {
      await knex()('agencies').where({ id: ids.agencySuspended }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
    }

    expect(box.sent).toEqual([]);
    await expectDiscardedUnsent(content);
  });

  // The paid plan of an agency (issue #772): it keeps writing for three days after the period ended and not for the fourth, and a
  // canceled one stops writing when the period ends. The e-mail follows the same rule as every other write of the agency.
  describe('an agency with a paid plan', () => {
    const SUBSCRIPTION_FIXTURE = (periodEnd: string, canceled: boolean) => knex().raw(
      `insert into public.agency_subscriptions (agency_id, plan_key, provider, current_period_start, current_period_end, cancel_at_period_end)
       values (?, 'essencial', 'simulado', ${periodEnd} - interval '1 month', ${periodEnd}, ?)`,
      [ids.agencySuspended, canceled]
    );
    const withPaidPlan = async (work: () => Promise<void>): Promise<void> => {
      await knex()('agencies').where({ id: ids.agencySuspended }).update({ plan: 'ativo', trial_ends_at: null, trial_owner_email_key: null });
      await SUBSCRIPTION_FIXTURE("now() + interval '10 days'", false);
      try {
        await work();
      } finally {
        await knex()('agency_subscriptions').where({ agency_id: ids.agencySuspended }).delete();
        await knex()('agencies').where({ id: ids.agencySuspended }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
      }
    };
    const movePeriod = (periodEnd: string, canceled: boolean) => knex().raw(
      `update public.agency_subscriptions set current_period_start = ${periodEnd} - interval '1 month', current_period_end = ${periodEnd}, cancel_at_period_end = ? where agency_id = ?`,
      [canceled, ids.agencySuspended]
    );
    const queued = async () => {
      const client = await freshClient([ids.portal3], ids.agencySuspended);
      const content = await seedContent(client, 'in_production', undefined, ids.suspendedActor);
      await sendForApproval(content, ids.suspendedActor);
      await ageQueue(16);
      return content;
    };

    it.each([
      ['the period ended two days ago, inside the three days of grace', "now() - interval '2 days'", false],
      ['it was canceled and the period still runs', "now() + interval '1 day'", true]
    ])('still sends when %s', async (_name, periodEnd, canceled) => {
      await withPaidPlan(async () => {
        const content = await queued();
        await movePeriod(periodEnd, canceled);
        const box = mailbox();

        await runJob(box);

        expect(box.sent).toHaveLength(1);
        expect((await itemsOf(content)).every((row) => row.sent_at !== null)).toBe(true);
      });
    });

    it.each([
      ['the period ended four days ago, past the three days of grace', "now() - interval '4 days'", false],
      ['it was canceled and the period ended an hour ago', "now() - interval '1 hour'", true]
    ])('sends nothing and discards the items when %s', async (_name, periodEnd, canceled) => {
      await withPaidPlan(async () => {
        const content = await queued();
        await movePeriod(periodEnd, canceled);
        const box = mailbox();

        await runJob(box);

        expect(box.sent).toEqual([]);
        await expectDiscardedUnsent(content);
      });
    });

    it('sends nothing when the agency went read-only AFTER the claim', async () => {
      await withPaidPlan(async () => {
        const content = await queued();
        const box = mailbox();

        await runJob(box, { queue: afterClaim(createNotificationQueue(application), async () => { await movePeriod("now() - interval '4 days'", false); }) });

        expect(box.sent).toEqual([]);
        expect((await itemsOf(content)).every((row) => row.sent_at === null)).toBe(true);
      });
    });
  });

  it('sends nothing for an agency that was already suspended', async () => {
    const client = await freshClient([ids.portal3], ids.agencySuspended);
    const content = await seedContent(client, 'in_production', undefined, ids.suspendedActor);
    await sendForApproval(content, ids.suspendedActor);
    await ageQueue(16);
    const box = mailbox();
    await knex()('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });

    try {
      await runJob(box);
    } finally {
      await knex()('agencies').where({ id: ids.agencySuspended }).update({ status: 'active' });
    }

    expect(box.sent).toEqual([]);
    await expectDiscardedUnsent(content);
  });

  it('drops only the person who was removed from the portal after the claim, and still sends to the other', async () => {
    const { client, content } = await scenario();
    const box = mailbox();

    await runJob(box, { queue: afterClaim(createNotificationQueue(application), async () => {
      // The state of a membership follows its access (#711), so the access goes first.
      await knex().transaction(async (transaction) => {
        await transaction('client_portal_accesses').where({ client_id: client, user_id: ids.portal2 }).update({ status: 'removed', generation: transaction.raw('generation + 1') });
        await transaction('client_memberships').where({ client_id: client, user_id: ids.portal2 }).update({ status: 'removed' });
      });
    }) });

    expect(box.sent.map((mail) => mail.to)).toEqual([emailOf(ids.portal1)]);
    const items = await itemsOf(content);
    expect(items.find((row) => row.recipient_user_id === ids.portal2)).toMatchObject({ discarded_at: expect.any(Date), sent_at: null });
    expect(items.find((row) => row.recipient_user_id === ids.portal1)).toMatchObject({ discarded_at: null, sent_at: expect.any(Date) });
  });

  it('sends nothing about a content the client approved after the claim, and lists in the e-mail only the ones still waiting', async () => {
    const client = await freshClient([ids.portal1]);
    const approved = await seedContent(client);
    const waiting = await seedContent(client);
    await sendForApproval(approved);
    await sendForApproval(waiting);
    await ageQueue(16);
    const box = mailbox();

    await runJob(box, { queue: afterClaim(createNotificationQueue(application), async () => { await approveByClient(approved); }) });

    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.subject).toMatch(/^um conteúdo para você aprovar/);
    expect(box.sent[0]!.text).toContain(`Post ${waiting.slice(0, 8)}`);
    expect(box.sent[0]!.text).not.toContain(`Post ${approved.slice(0, 8)}`);
  });

  it('does not send once the lease of the claim ran out before the send: the next claim judges the item', async () => {
    const { content } = await scenario();
    const box = mailbox();

    await runJob(box, { queue: afterClaim(createNotificationQueue(application), async () => {
      await knex()('notification_queue').where({ content_id: content }).update({ claimed_at: knex().raw("now() - interval '11 minutes'") });
    }) });

    expect(box.sent).toEqual([]);
    expect((await itemsOf(content)).every((row) => row.sent_at === null && row.discarded_at === null)).toBe(true);
  });
});

describe('the daily summary of what was published (issue #260)', () => {
  it('sends one summary per person with every content published that day, once the day has ended in Brasília, and not before', async () => {
    const client = await freshClient([ids.portal1]);
    const [one, two] = [await seedContent(client, 'approved'), await seedContent(client, 'approved')] as [string, string];
    await publish(one);
    await publish(two);
    const box = mailbox();

    await runJob(box);
    expect(box.sent).toEqual([]);

    await knex()('notification_queue').whereIn('client_id', clients).update({ send_after: knex().raw("now() - interval '1 minute'") });
    await runJob(box);

    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.subject).toMatch(/^2 conteúdos publicados: Padaria Sol /);
    expect(box.sent[0]!.text).toContain(`Post ${one.slice(0, 8)}`);
    expect(box.sent[0]!.text).toContain(`Post ${two.slice(0, 8)}`);
    expect(box.sent[0]!.text).toContain(`${ORIGIN}/portal/${client}/calendario`);
  });

  it('does not list a publication that was undone the same day', async () => {
    const client = await freshClient([ids.portal1]);
    const undone = await seedContent(client, 'approved');
    const kept = await seedContent(client, 'approved');
    await publish(undone);
    await publish(kept);
    await unpublish(undone);
    await knex()('notification_queue').whereIn('client_id', clients).update({ send_after: knex().raw("now() - interval '1 minute'") });
    const box = mailbox();

    await runJob(box);

    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.subject).toMatch(/^um conteúdo publicado/);
    expect(box.sent[0]!.text).toContain(`Post ${kept.slice(0, 8)}`);
    expect(box.sent[0]!.text).not.toContain(`Post ${undone.slice(0, 8)}`);
  });

  it('keeps a summary and an approval request of the same person and client in two e-mails', async () => {
    const client = await freshClient([ids.portal1]);
    const published = await seedContent(client, 'approved');
    const waiting = await seedContent(client);
    await publish(published);
    await sendForApproval(waiting);
    await ageQueue(16);
    await knex()('notification_queue').whereIn('client_id', clients).update({ send_after: knex().raw("now() - interval '1 minute'") });
    const box = mailbox();

    await runJob(box);

    expect(box.sent.map((mail) => mail.subject.replace(/ [0-9a-f]{8}$/, '')).sort()).toEqual([
      'um conteúdo para você aprovar: Padaria Sol', 'um conteúdo publicado: Padaria Sol'
    ].sort());
  });
});

describe('two workers, and a provider that fails (issue #260)', () => {
  it('lets two workers run at the same time without sending any e-mail twice', async () => {
    const people = [ids.portal1, ids.portal2, ids.portal3];
    for (let index = 0; index < 4; index += 1) {
      const client = await freshClient(people, ids.agency, `Cliente ${index}`);
      await sendForApproval(await seedContent(client));
    }
    await ageQueue(16);
    const second = createLocalTestDatabaseClient(applicationUrl);
    const box = mailbox();

    try {
      await Promise.all([runJob(box), runJob(box, { database: second })]);
    } finally {
      await second.close();
    }

    expect(box.sent).toHaveLength(12);
    expect(new Set(box.sent.map((mail) => `${mail.to}|${mail.subject}`)).size).toBe(12);
    expect(await sentItems()).toBe(12);
    await runJob(box);
    expect(box.sent).toHaveLength(12);
  });

  it('loses nothing and repeats nothing when the provider refuses: the items wait, with a code, and leave once on the next try', async () => {
    const client = await freshClient([ids.portal1]);
    const content = await seedContent(client);
    await sendForApproval(content);
    await ageQueue(16);
    const box = mailbox();
    box.failures.push(Object.assign(new Error(`450 Mailbox ${emailOf(ids.portal1)} is full`), { responseCode: 450 }));

    const logs = await runJob(box);

    expect(box.sent).toEqual([]);
    expect((await itemsOf(content))[0]).toMatchObject({ sent_at: null, discarded_at: null, claimed_at: null, claim_token: null, attempts: 1, last_error: 'smtp_temporary' });
    expect(logs.text()).not.toContain(emailOf(ids.portal1));
    expect(logs.text()).not.toContain('is full');

    await runJob(box);
    expect(box.sent).toEqual([]);

    await knex()('notification_queue').where({ content_id: content }).update({ send_after: knex().raw("now() - interval '1 minute'") });
    await runJob(box);
    expect(box.sent).toHaveLength(1);
    expect((await itemsOf(content))[0]).toMatchObject({ sent_at: expect.any(Date), attempts: 2 });

    await runJob(box);
    expect(box.sent).toHaveLength(1);
  });

  it('lets a worker that was claimed out of its lease stamp nothing: the e-mail it sent late is not counted for the other claim', async () => {
    const client = await freshClient([ids.portal1]);
    const content = await seedContent(client);
    await sendForApproval(content);
    await ageQueue(16);
    const box = mailbox();
    const queue = createNotificationQueue(application);
    const takenAway: NotificationQueue = { ...queue, markSent: async (itemIds, token) => {
      await knex()('notification_queue').where({ content_id: content }).update({ claim_token: id(), claimed_at: new Date() });
      return queue.markSent(itemIds, token);
    } };

    const logs = await runJob(box, { queue: takenAway });

    expect(box.sent).toHaveLength(1);
    expect((await itemsOf(content))[0]!.sent_at).toBeNull();
    expect(logs.text()).toContain('no longer held by this claim');
  });

  it('refuses a call of the queue made with an actor bound as the first instruction: only the worker, which binds none, may ask', async () => {
    const client = await freshClient([ids.portal1]);
    await sendForApproval(await seedContent(client));
    await ageQueue(16);

    const asRequest = application.transaction(async (transaction) => {
      await raw(transaction, 'select app_private.bind_actor(?::uuid)', [ids.portal1]);
      await raw(transaction, 'select * from app_private.claim_notification_batch(?::integer)', [10]);
    });

    await expect(asRequest).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('worker') });
    expect(await knex()('notification_queue').whereIn('client_id', clients).whereNotNull('claimed_at')).toEqual([]);
  });
});
