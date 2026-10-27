import { describe, expect, it, vi } from 'vitest';

import {
  createAgencyCommandService,
  type AgencyActivationEmail,
  type AgencyActivationMailer,
  type AgencyCliDatabase,
  type AgencyCliTransaction,
  createInvitationToken,
  formatAgencyCliOutput,
  hashInvitationToken,
  loadAgencyCliEnvironment,
  normalizeAgencyName,
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

const createQuery: AgencyCliTransaction['query'] = async <TRow extends object>(statement: string) => {
  if (statement.includes('insert into public.agencies')) return { rows: [{ id: agencyId, name: 'Acme' } as TRow] };
  if (statement.includes('insert into public.invitations')) return { rows: [{ id: invitationId, email: 'owner@example.com', expires_at: '2030-01-08T12:00:00.000Z' } as TRow] };
  return { rows: [] as TRow[] };
};

describe('agency operator CLI', () => {
  it('normalizes owner e-mail and parses the four command shapes', () => {
    expect(normalizeEmail('  Owner@Example.COM ')).toBe('owner@example.com');
    expect(parseAgencyCliArguments(['create', '--name', 'Acme', '--owner-email', 'owner@example.com'])).toEqual({
      command: 'create', name: 'Acme', ownerEmail: 'owner@example.com'
    });
    expect(parseAgencyCliArguments(['suspend', '--agency-id', agencyId])).toEqual({ command: 'suspend', agencyId });
    expect(parseAgencyCliArguments(['reactivate', `--agency-id=${agencyId}`])).toEqual({ command: 'reactivate', agencyId });
    expect(parseAgencyCliArguments(['resend-activation', '--agency-id', agencyId])).toEqual({ command: 'resend-activation', agencyId });
  });

  it('refuses an agency name the invitation e-mail templates would reject', () => {
    expect(normalizeAgencyName('  Acme  ')).toBe('Acme');
    expect(() => normalizeAgencyName('   ')).toThrow(/blank/);
    expect(normalizeAgencyName('a'.repeat(256))).toHaveLength(256);
    expect(() => normalizeAgencyName('a'.repeat(257))).toThrow(/256 bytes/);
    // Bytes, not characters: 200 emoji are 800 UTF-8 bytes and 400 UTF-16 units, which the
    // e-mail template would reject even though it is under 256 characters.
    expect(() => normalizeAgencyName('🙂'.repeat(200))).toThrow(/256 bytes/);
  });

  it('refuses an agency name with an invisible, bidi or tag character, and keeps an accented name', () => {
    expect(normalizeAgencyName('Ação Pão & Cia')).toBe('Ação Pão & Cia');
    // A tag letter (U+E0041), a bidi override (U+202E) and a zero-width space (U+200B): each one is a character the e-mail would show as
    // something other than what is stored, so the CLI refuses the name before it writes anything.
    for (const code of [0xe0041, 0x202e, 0x200b]) {
      const name = `Acme${String.fromCodePoint(code)}`;
      expect(() => normalizeAgencyName(name)).toThrow(/invisible/);
    }
  });

  it('exits non-zero with the reason, and writes nothing, when the CLI gets an agency name with a bidi override', async () => {
    const { database, calls } = fakeDatabase(createQuery);
    const { mailer, sent } = fakeMailer();
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runAgencyCli({
      argv: ['create', '--name', `Acme${String.fromCodePoint(0x202e)}`, '--owner-email', 'owner@example.com'],
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

    expect(exitCode).not.toBe(0);
    expect(errors.join('')).toContain('name must not contain control, bidi or invisible characters.');
    expect(output).toEqual([]);
    expect(calls).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('refuses, through the CLI, an agency name with a variation selector, a combining mark or a Braille blank that the invisible rule refuses', async () => {
    // Code points are spelled as numbers so the invisible characters stay visible in this file: a variation selector of the supplement
    // (U+E0100), a loose VS16 (U+FE0F) after a letter, the combining grapheme joiner (U+034F), the Braille blank (U+2800), the
    // Mongolian selector (U+180B) and the Khmer inherent vowel (U+17B4).
    for (const code of [0xe0100, 0xe01ef, 0xfe0f, 0xfe00, 0x034f, 0x2800, 0x180b, 0x17b4]) {
      const { database, calls } = fakeDatabase(createQuery);
      const { mailer, sent } = fakeMailer();
      const output: string[] = [];
      const errors: string[] = [];
      const exitCode = await runAgencyCli({
        argv: ['create', '--name', `Acme${String.fromCodePoint(code)}`, '--owner-email', 'owner@example.com'],
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

      expect(exitCode, code.toString(16)).not.toBe(0);
      expect(errors.join(''), code.toString(16)).toContain('name must not contain');
      expect(output, code.toString(16)).toEqual([]);
      expect(calls, code.toString(16)).toEqual([]);
      expect(sent, code.toString(16)).toHaveLength(0);
    }
  });

  it('keeps an accented name, Arabic, and a whole emoji sequence in an agency name', () => {
    expect(normalizeAgencyName('Ação Pão & Cia')).toBe('Ação Pão & Cia');
    expect(normalizeAgencyName('مكتب الشمس')).toBe('مكتب الشمس');
    // A heart is U+2764 with the selector 16 after it: one whole emoji, which the rule of invisible characters reads as a sequence.
    expect(normalizeAgencyName(`Sol ${String.fromCodePoint(0x2764, 0xfe0f)}`)).toBe(`Sol ${String.fromCodePoint(0x2764, 0xfe0f)}`);
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
    // `cli:agency` is the operation tool that creates agencies in production
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

  it('creates the agency and invitation in one transaction, audits both, and only mails the raw token', async () => {
    const { database, calls } = fakeDatabase(createQuery);
    const { mailer, sent } = fakeMailer();
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });

    const result = await service.create({ name: ' Acme ', ownerEmail: 'Owner@Example.COM' });

    expect(result).toEqual({ agencyId, expiresAt: '2030-01-08T12:00:00.000Z' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'owner@example.com', agencyName: 'Acme' });
    const token = sent[0]!.actionUrl.split('/convite/')[1];
    expect(token).toBeDefined();
    const dbValues = calls.flatMap((call) => call.bindings.map(String));
    expect(dbValues).toContain(hashInvitationToken(decodeURIComponent(token!)));
    expect(dbValues).not.toContain(decodeURIComponent(token!));
    expect(calls.filter((call) => call.statement.includes('insert into audit.events'))).toHaveLength(2);
    expect(formatAgencyCliOutput(result)).toBe(JSON.stringify({ agencyId, expiresAt: result.expiresAt }) + '\n');
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

  it('writes only the restricted result fields when run through the CLI entry point', async () => {
    const { database } = fakeDatabase(createQuery);
    const { mailer } = fakeMailer();
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runAgencyCli({
      argv: ['create', '--name', 'Acme', '--owner-email', 'owner@example.com'],
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
    expect(JSON.parse(output.join(''))).toEqual({ agencyId, expiresAt: '2030-01-08T12:00:00.000Z' });
    expect(output.join('')).not.toContain('/convite/');
  });

  it('generates a 32-byte base64url token and a one-way hexadecimal hash', () => {
    const token = createInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashInvitationToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashInvitationToken(token)).not.toContain(token);
  });
});

describe('agency operator CLI: the plan (issue #708)', () => {
  it('parses upgrade and new-trial', () => {
    expect(parseAgencyCliArguments(['upgrade', '--agency-id', agencyId])).toEqual({ command: 'upgrade', agencyId });
    expect(parseAgencyCliArguments(['new-trial', '--agency-id', agencyId, '--ends-at', '2030-01-31'])).toEqual({ command: 'new-trial', agencyId, endsAt: '2030-01-31' });
    expect(() => parseAgencyCliArguments(['new-trial', '--agency-id', agencyId])).toThrow('Option --ends-at is required.');
    expect(() => parseAgencyCliArguments(['upgrade', '--agency-id', agencyId, '--ends-at', '2030-01-31'])).toThrow('Unknown option --ends-at.');
  });

  it('reads a bare date as the end of that day in Brasilia and refuses a past or malformed one', () => {
    const now = new Date('2030-01-01T12:00:00.000Z');
    expect(parseTrialEnd('2030-01-31', now).toISOString()).toBe('2030-02-01T02:59:59.000Z');
    expect(parseTrialEnd('2030-01-02T10:00:00Z', now).toISOString()).toBe('2030-01-02T10:00:00.000Z');
    expect(() => parseTrialEnd('2029-12-31', now)).toThrow('ends-at must be in the future.');
    expect(() => parseTrialEnd('31/01/2030', now)).toThrow('ends-at must be an ISO 8601 date');
  });

  it('upgrades to ativo: clears the end, lifts only the trial quota and audits', async () => {
    const { database, calls } = fakeDatabase(async <TRow extends object>(statement: string) =>
      ({ rows: (statement.includes('for update') ? [{ id: agencyId }] : []) as TRow[] }));
    const { mailer } = fakeMailer();
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });
    await expect(service.upgrade(agencyId)).resolves.toEqual({ agencyId, plan: 'ativo', trialEndsAt: null });
    expect(calls.find((call) => call.statement.startsWith('update public.agencies'))?.bindings).toEqual(['ativo', null, agencyId]);
    expect(calls.find((call) => call.statement.includes('agency_storage_quotas'))?.bindings).toEqual([agencyId, 2147483648]);
    expect(calls.some((call) => call.statement.includes('audit.events') && call.bindings[0] === 'agency.upgraded')).toBe(true);
  });

  it('says the owner already has a trial when the new trial collides with the one-per-account index', async () => {
    const { database } = fakeDatabase(async <TRow extends object>(statement: string) => {
      if (statement.startsWith('update public.agencies')) throw Object.assign(new Error('duplicate'), { code: '23505' });
      return { rows: (statement.includes('for update') ? [{ id: agencyId }] : []) as TRow[] };
    });
    const { mailer } = fakeMailer();
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: 'https://app.example.com' });
    await expect(service.newTrial(agencyId, '2999-01-31')).rejects.toThrow('The owner of this agency already has another agency in trial.');
  });
});