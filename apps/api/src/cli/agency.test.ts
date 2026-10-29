import { describe, expect, it, vi } from 'vitest';

import {
  createAgencyCommandService,
  type AgencyActivationEmail,
  type AgencyActivationMailer,
  type AgencyCliDatabase,
  type AgencyCliTransaction,
  createInvitationToken,
  hashInvitationToken,
  loadAgencyCliEnvironment,
  normalizeEmail,
  parseAgencyCliArguments,
  parseTrialEnd,
  runAgencyCli
} from './agency.js';

const agencyId = '4c7f6f1d-6e03-4d67-8f34-7069bcf2c0f4';
const invitationId = '1a6a9e17-2bc9-4ef8-b2e2-bc3f0c2f5e41';
const nextInvitationId = '2b7b9f28-3cd0-4ff9-c3f3-cd4g1d3g6f52';

interface QueryCall {
  readonly statement: string;
  readonly bindings: readonly unknown[];
}

const fakeMailer = () => {
  const sent: AgencyActivationEmail[] = [];
  const mailer: AgencyActivationMailer = {
    sendActivationEmail: vi.fn(async (email) => { sent.push(email); }),
    close: vi.fn(async () => undefined)
  };
  return { mailer, sent };
};

const fakeDatabase = (query: AgencyCliTransaction['query']): { database: AgencyCliDatabase; calls: QueryCall[] } => {
  const calls: QueryCall[] = [];
  const wrappedQuery: AgencyCliTransaction['query'] = async <TRow extends object>(statement: string, bindings: readonly unknown[] = []) => {
    calls.push({ statement, bindings });
    return query<TRow>(statement, bindings);
  };
  return {
    calls,
    database: {
      transaction: async <TResult>(work: (transaction: AgencyCliTransaction) => Promise<TResult>) => work({ query: wrappedQuery }),
      close: async () => undefined
    }
  };
};

describe('agency operator CLI', () => {
  it('normalizes the e-mail and parses the command shapes', () => {
    expect(normalizeEmail('  Owner@Example.COM ')).toBe('owner@example.com');
    expect(parseAgencyCliArguments(['suspend', '--agency-id', agencyId])).toEqual({ command: 'suspend', agencyId });
    expect(parseAgencyCliArguments(['reactivate', `--agency-id=${agencyId}`])).toEqual({ command: 'reactivate', agencyId });
    expect(parseAgencyCliArguments(['resend-activation', '--agency-id', agencyId])).toEqual({ command: 'resend-activation', agencyId });
  });

  it('has no command that creates an agency: it is only born through the product', () => {
    expect(() => parseAgencyCliArguments(['create', '--name', 'Acme', '--owner-email', 'owner@example.com'])).toThrow(/^Usage:/);
    expect(() => parseAgencyCliArguments(['upgrade', '--agency-id', agencyId])).toThrow(/^Usage:/);
    expect(() => parseAgencyCliArguments(['new-trial', '--agency-id', agencyId, '--ends-at', '2030-01-31'])).toThrow(/^Usage:/);
  });

  it('validates required settings without echoing a migration or SMTP secret', () => {
    const environment = loadAgencyCliEnvironment({
      MIGRATION_DATABASE_URL: 'postgresql://postgres:owner-password@postgres:5432/ageniza',
      SMTP_URL: 'smtps://smtp-user:smtp-password@smtp.example.com:465',
      EMAIL_FROM: 'Ageniza <no-reply@example.com>',
      APP_PUBLIC_URL: 'https://app.example.com/'
    });
    expect(environment.appPublicUrl).toBe('https://app.example.com');

    expect(() => loadAgencyCliEnvironment({
      MIGRATION_DATABASE_URL: 'not-a-database-url',
      SMTP_URL: 'smtps://smtp-user:smtp-password@smtp.example.com:465',
      EMAIL_FROM: 'Ageniza <no-reply@example.com>',
      APP_PUBLIC_URL: 'https://app.example.com'
    })).toThrow(/MIGRATION_DATABASE_URL/);
    try {
      loadAgencyCliEnvironment({
        MIGRATION_DATABASE_URL: 'not-a-database-url',
        SMTP_URL: 'smtps://smtp-user:smtp-password@smtp.example.com:465',
        EMAIL_FROM: 'Ageniza <no-reply@example.com>',
        APP_PUBLIC_URL: 'https://app.example.com'
      });
    } catch (error) {
      expect(String(error)).not.toContain('owner-password');
      expect(String(error)).not.toContain('smtp-password');
    }
  });

  it('accepts the production service host the deploy runbook uses', () => {
    // `cli:agency` is the operation tool that changes the plan of an agency in production
    // (docs/infra/production-deploy.md): the database host there is the Compose service `postgres`,
    // not a loopback address. This test exists so the loopback gate is never applied here again.
    const base = {
      SMTP_URL: 'smtp://127.0.0.1:1025',
      EMAIL_FROM: 'Ageniza <no-reply@ageniza.local>',
      APP_PUBLIC_URL: 'http://127.0.0.1:5173'
    };
    const environment = loadAgencyCliEnvironment({
      ...base,
      MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@postgres:5432/ageniza'
    });
    expect(environment.migrationDatabaseUrl).toBe('postgresql://postgres:postgres@postgres:5432/ageniza');
    expect(() => loadAgencyCliEnvironment({
      ...base,
      MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@db.example.com:5432/ageniza'
    })).not.toThrow();
  });

  it('does not audit or update an already-suspended agency when suspend is repeated', async () => {
    const query: AgencyCliTransaction['query'] = async <TRow extends object>(statement: string) => {
      if (statement.startsWith('select id, status')) return { rows: [{ id: agencyId, status: 'suspended' } as TRow] };
      return { rows: [] as TRow[] };
    };
    const { database, calls } = fakeDatabase(query);
    const { mailer } = fakeMailer();
    const result = await createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' }).suspend(agencyId);

    expect(result).toEqual({ agencyId, status: 'suspended' });
    expect(calls.some((call) => call.statement.startsWith('update public.agencies'))).toBe(false);
    expect(calls.some((call) => call.statement.includes('insert into audit.events'))).toBe(false);
  });

  it('revokes the pending activation before creating a replacement and never stores the new token', async () => {
    const query: AgencyCliTransaction['query'] = async <TRow extends object>(statement: string) => {
      if (statement.startsWith('select id, name, status, owner_user_id')) return { rows: [{ id: agencyId, name: 'Acme', status: 'active', owner_user_id: null } as TRow] };
      if (statement.startsWith('select id, email, expires_at')) return { rows: [{ id: invitationId, email: 'owner@example.com', expires_at: '2030-01-01T12:00:00.000Z' } as TRow] };
      if (statement.includes('insert into public.invitations')) return { rows: [{ id: nextInvitationId, email: 'owner@example.com', expires_at: '2030-01-08T12:00:00.000Z' } as TRow] };
      return { rows: [] as TRow[] };
    };
    const { database, calls } = fakeDatabase(query);
    const { mailer, sent } = fakeMailer();
    const result = await createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' }).resendActivation(agencyId);

    expect(result).toEqual({ agencyId, expiresAt: '2030-01-08T12:00:00.000Z' });
    expect(calls.findIndex((call) => call.statement.startsWith('update public.invitations')))
      .toBeLessThan(calls.findIndex((call) => call.statement.includes('insert into public.invitations')));
    const token = decodeURIComponent(sent[0]!.actionUrl.split('/convite/')[1]!);
    expect(calls.flatMap((call) => call.bindings.map(String))).not.toContain(token);
    expect(calls.filter((call) => call.statement.includes('insert into audit.events'))).toHaveLength(3);
  });

  it('files the emailed activation token as the e-mail token, so accepting it confirms the e-mail (decision 2026-10-27)', async () => {
    const query: AgencyCliTransaction['query'] = async <TRow extends object>(statement: string) => {
      if (statement.startsWith('select id, name, status, owner_user_id')) return { rows: [{ id: agencyId, name: 'Acme', status: 'active', owner_user_id: null } as TRow] };
      if (statement.startsWith('select id, email, expires_at')) return { rows: [{ id: invitationId, email: 'owner@example.com', expires_at: '2030-01-01T12:00:00.000Z' } as TRow] };
      if (statement.includes('insert into public.invitations')) return { rows: [{ id: nextInvitationId, email: 'owner@example.com', expires_at: '2030-01-08T12:00:00.000Z' } as TRow] };
      return { rows: [] as TRow[] };
    };
    const { database, calls } = fakeDatabase(query);
    const { mailer, sent } = fakeMailer();
    await createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' }).resendActivation(agencyId);

    const token = decodeURIComponent(sent[0]!.actionUrl.split('/convite/')[1]!);
    const insert = calls.find((call) => call.statement.includes('insert into public.invitations'))!;
    expect(insert.statement).toContain('email_token_hash');
    // The bindings are (agency, e-mail, token_hash, email_token_hash): the hash of the mailed token is the
    // e-mail one, and the column of the token to copy holds a hash that matches nothing anyone received.
    const [, , tokenHash, emailTokenHash] = insert.bindings.map(String);
    expect(emailTokenHash).toBe(hashInvitationToken(token));
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toBe(emailTokenHash);
  });

  it('refuses to resend the activation of a suspended agency and keeps the pending invitation', async () => {
    const query: AgencyCliTransaction['query'] = async <TRow extends object>(statement: string) => {
      if (statement.startsWith('select id, name, status, owner_user_id')) return { rows: [{ id: agencyId, name: 'Acme', status: 'suspended', owner_user_id: null } as TRow] };
      return { rows: [] as TRow[] };
    };
    const { database, calls } = fakeDatabase(query);
    const { mailer, sent } = fakeMailer();

    await expect(createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' }).resendActivation(agencyId))
      .rejects.toThrow(/suspended/);
    expect(calls.some((call) => call.statement.startsWith('update public.invitations'))).toBe(false);
    expect(calls.some((call) => call.statement.includes('insert into public.invitations'))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('generates a 32-byte base64url token and a one-way hexadecimal hash', () => {
    const token = createInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashInvitationToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashInvitationToken(token)).not.toContain(token);
  });
});

describe('agency operator CLI: the plan (issue #708, decision 2026-10-27)', () => {
  const planQuery = (owner: string | null = 'b1b1b1b1-1111-4111-8111-111111111111') => async <TRow extends object>(statement: string) =>
    ({ rows: (statement.includes('for update') ? [{ id: agencyId, owner_user_id: owner }] : []) as TRow[] });

  it('parses set-plan, with --ends-at only for the trial, and set-email-limit', () => {
    expect(parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'isenta'])).toEqual({ command: 'set-plan', agencyId, plan: 'isenta' });
    expect(parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'ativo', '--paid-plan', 'profissional']))
      .toEqual({ command: 'set-plan', agencyId, plan: 'ativo', paidPlan: 'profissional' });
    expect(parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'trial', '--ends-at', '2030-01-31']))
      .toEqual({ command: 'set-plan', agencyId, plan: 'trial', endsAt: '2030-01-31' });
    expect(() => parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'trial'])).toThrow('Option --ends-at is required for the trial plan.');
    expect(() => parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'ativo', '--paid-plan', 'essencial', '--ends-at', '2030-01-31']))
      .toThrow('Option --ends-at is only for the trial plan.');
    expect(() => parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'pago'])).toThrow('Option --plan must be isenta, ativo or trial.');
    expect(() => parseAgencyCliArguments(['set-plan', '--agency-id', agencyId])).toThrow('Option --plan is required.');
    expect(parseAgencyCliArguments(['set-email-limit', '--agency-id', agencyId, '--per-day', '50'])).toEqual({ command: 'set-email-limit', agencyId, perDay: 50 });
    expect(parseAgencyCliArguments(['set-email-limit', '--agency-id', agencyId, '--per-day', 'padrao'])).toEqual({ command: 'set-email-limit', agencyId, perDay: null });
    for (const bad of ['-1', '1.5', '100001', 'muitos']) {
      expect(() => parseAgencyCliArguments(['set-email-limit', '--agency-id', agencyId, '--per-day', bad]), bad).toThrow(/per-day must be a whole number/);
    }
  });

  it('makes ativo a paid plan by courtesy: --paid-plan is required for it, one of the three, and refused for any other plan', () => {
    expect(() => parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'ativo'])).toThrow('Option --paid-plan is required for the ativo plan.');
    for (const paid of ['pago', 'Essencial', 'trial', 'isenta']) {
      expect(() => parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'ativo', '--paid-plan', paid]), paid)
        .toThrow('Option --paid-plan must be essencial, profissional or agencia.');
    }
    for (const paid of ['essencial', 'profissional', 'agencia']) {
      expect(parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'ativo', `--paid-plan=${paid}`]), paid)
        .toEqual({ command: 'set-plan', agencyId, plan: 'ativo', paidPlan: paid });
    }
    expect(() => parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'isenta', '--paid-plan', 'essencial']))
      .toThrow('Option --paid-plan is only for the ativo plan.');
    expect(() => parseAgencyCliArguments(['set-plan', '--agency-id', agencyId, '--plan', 'trial', '--ends-at', '2030-01-31', '--paid-plan', 'essencial']))
      .toThrow('Option --paid-plan is only for the ativo plan.');
  });

  it('refuses ativo without a valid paid plan in the service too, before it touches the database', async () => {
    const { mailer } = fakeMailer();
    for (const paid of [undefined, 'pago']) {
      const { database, calls } = fakeDatabase(planQuery());
      const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });
      await expect(service.setPlan(agencyId, 'ativo', undefined, paid)).rejects.toThrow(/--paid-plan/);
      expect(calls).toEqual([]);
    }
    const { database, calls } = fakeDatabase(planQuery());
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });
    await expect(service.setPlan(agencyId, 'isenta', undefined, 'essencial')).rejects.toThrow('only for the ativo plan');
    expect(calls).toEqual([]);
  });

  it('grants the courtesy subscription for ativo, after the update and in the same transaction, and for no other plan', async () => {
    const { mailer } = fakeMailer();
    const { database, calls } = fakeDatabase(planQuery());
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });
    await expect(service.setPlan(agencyId, 'ativo', undefined, 'agencia')).resolves.toEqual({ agencyId, plan: 'ativo', trialEndsAt: null });
    const grants = calls.filter((call) => call.statement.includes('grant_courtesy_subscription'));
    expect(grants.map((call) => call.bindings)).toEqual([[agencyId, 'agencia']]);
    const order = calls.map((call) => (call.statement.includes('grant_courtesy_subscription') ? 'grant' : call.statement.trim().startsWith('update public.agencies') ? 'update' : call.statement.includes('audit.events') ? 'audit' : 'other'));
    expect(order.indexOf('update')).toBeLessThan(order.indexOf('grant'));
    expect(order.indexOf('grant')).toBeLessThan(order.indexOf('audit'));

    for (const plan of ['isenta', 'trial'] as const) {
      const other = fakeDatabase(planQuery());
      await createAgencyCommandService({ database: other.database, mailer, appPublicUrl: 'https://app.example.com' })
        .setPlan(agencyId, plan, plan === 'trial' ? '2999-01-31' : undefined);
      expect(other.calls.some((call) => call.statement.includes('grant_courtesy_subscription')), plan).toBe(false);
    }
  });

  it('reads a bare date as the end of that day in Brasilia and refuses a past or malformed one', () => {
    const now = new Date('2030-01-01T12:00:00.000Z');
    expect(parseTrialEnd('2030-01-31', now).toISOString()).toBe('2030-02-01T02:59:59.000Z');
    expect(parseTrialEnd('2030-01-02T10:00:00Z', now).toISOString()).toBe('2030-01-02T10:00:00.000Z');
    expect(() => parseTrialEnd('2029-12-31', now)).toThrow('ends-at must be in the future.');
    expect(() => parseTrialEnd('31/01/2030', now)).toThrow('ends-at must be an ISO 8601 date');
  });

  it.each(['ativo', 'isenta'] as const)('moves to %s: clears the end and the key, lifts only the trial quota and audits', async (plan) => {
    const { database, calls } = fakeDatabase(planQuery());
    const { mailer } = fakeMailer();
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });
    await expect(service.setPlan(agencyId, plan, undefined, plan === 'ativo' ? 'essencial' : undefined)).resolves.toEqual({ agencyId, plan, trialEndsAt: null });
    expect(calls.find((call) => call.statement.trim().startsWith('update public.agencies'))?.bindings).toEqual([plan, null, plan, agencyId]);
    expect(calls.find((call) => call.statement.includes('agency_storage_quotas'))?.bindings).toEqual([agencyId, 2147483648]);
    expect(calls.some((call) => call.statement.includes('audit.events') && call.bindings[0] === `agency.plan_${plan}`)).toBe(true);
  });

  it('gives a trial with the owner key and the trial quota, and refuses one to an agency without an owner', async () => {
    const { database, calls } = fakeDatabase(planQuery());
    const { mailer } = fakeMailer();
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });
    const result = await service.setPlan(agencyId, 'trial', '2999-01-31');
    expect(result).toEqual({ agencyId, plan: 'trial', trialEndsAt: '2999-02-01T02:59:59.000Z' });
    const update = calls.find((call) => call.statement.trim().startsWith('update public.agencies'));
    expect(update?.statement).toContain('app_private.trial_email_key(person.email)');
    expect(calls.find((call) => call.statement.includes('insert into public.agency_storage_quotas'))?.bindings).toEqual([agencyId, 2147483648]);

    const ownerless = fakeDatabase(planQuery(null));
    await expect(createAgencyCommandService({ database: ownerless.database, mailer, appPublicUrl: 'https://app.example.com' }).setPlan(agencyId, 'trial', '2999-01-31'))
      .rejects.toThrow('A trial needs the agency to have an owner.');
    expect(ownerless.calls.some((call) => call.statement.trim().startsWith('update public.agencies'))).toBe(false);
  });

  it('says the e-mail already has a trial when the new trial collides with an index', async () => {
    const { database } = fakeDatabase(async <TRow extends object>(statement: string) => {
      if (statement.trim().startsWith('update public.agencies')) throw Object.assign(new Error('duplicate'), { code: '23505' });
      return { rows: (statement.includes('for update') ? [{ id: agencyId, owner_user_id: agencyId }] : []) as TRow[] };
    });
    const { mailer } = fakeMailer();
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });
    await expect(service.setPlan(agencyId, 'trial', '2999-01-31')).rejects.toThrow('already has another agency in trial.');
  });

  it('sets the daily e-mail limit, or returns it to the default, and audits', async () => {
    const { database, calls } = fakeDatabase(planQuery());
    const { mailer } = fakeMailer();
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });
    await expect(service.setEmailLimit(agencyId, 50)).resolves.toEqual({ agencyId, dailyEmailLimit: 50 });
    await expect(service.setEmailLimit(agencyId, null)).resolves.toEqual({ agencyId, dailyEmailLimit: null });
    expect(calls.filter((call) => call.statement.startsWith('update public.agencies set daily_email_limit')).map((call) => call.bindings)).toEqual([[50, agencyId], [null, agencyId]]);
    expect(calls.filter((call) => call.statement.includes('audit.events') && call.bindings[0] === 'agency.email_limit_changed')).toHaveLength(2);
  });

  it('writes only the result when run through the CLI entry point', async () => {
    const { database } = fakeDatabase(planQuery());
    const { mailer } = fakeMailer();
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runAgencyCli({
      argv: ['set-plan', '--agency-id', agencyId, '--plan', 'isenta'],
      environment: {
        MIGRATION_DATABASE_URL: 'postgresql://postgres:owner-password@postgres:5432/ageniza',
        SMTP_URL: 'smtps://smtp-user:smtp-password@smtp.example.com:465',
        EMAIL_FROM: 'Ageniza <no-reply@example.com>',
        APP_PUBLIC_URL: 'https://app.example.com'
      },
      database,
      mailer,
      io: { stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => errors.push(value) } }
    });
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(''))).toEqual({ agencyId, plan: 'isenta', trialEndsAt: null });
  });
});

