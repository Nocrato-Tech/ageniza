import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { hashPassword } from 'better-auth/crypto';
import { Client } from 'pg';

import {
  assertLocalDatabaseUrl,
  createDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '@ageniza/database';

/**
 * Demo data for the local environment (issue #183). The command refuses to run anywhere but a
 * loopback database and requires an explicit `--i-know-this-is-local` flag; passwords are random
 * per run and exist only in the command output, never in a versioned file.
 *
 * It uses the application paths, not raw inserts around the rules: accounts and memberships go
 * through `app_private.accept_invitation`, clients and the brand study go through the
 * `ageniza_app` role under the same RLS policies the future routes will use, and agencies are
 * created the way `cli:agency` creates them (the migration owner, since `public.agencies` has no
 * INSERT policy by design).
 *
 * Everything is idempotent: identifiers derive from stable demo keys and every write is an upsert
 * or a guarded insert, so running twice neither duplicates nor fails. Passwords are regenerated
 * and rewritten on each run; the latest output is the one to use.
 */

export const SEED_FLAG = '--i-know-this-is-local';
const DEFAULT_DATABASE_URL = 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';
const DEFAULT_MIGRATION_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const DEFAULT_APP_PUBLIC_URL = 'http://127.0.0.1:5173';
const DEFAULT_TERMS_VERSION = '2026-01-01';
const DEFAULT_PRIVACY_VERSION = '2026-02-01';
const DEFAULT_EMAIL_DOMAIN = 'demo.ageniza.test';
const DEFAULT_NAMESPACE = 'ageniza-demo-seed-v1';
const INVITATION_EXPIRY = "interval '7 days'";

export class SeedDemoError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SeedDemoError';
  }
}

type SeedTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
type SeedId = (key: string) => string;

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

const oneRow = <TRow>(rows: readonly TRow[], message: string): TRow => {
  const row = rows[0];
  if (row === undefined) throw new SeedDemoError(message);
  return row;
};

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Stable UUID for a demo key, so rerunning updates the same rows instead of creating new ones. */
export const demoId = (key: string): string => {
  const bytes = createHash('sha256').update(`ageniza-demo-seed-v1:${key}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// Every invitation gets a random token hash: a deterministic one would collide with a row a
// developer removed by hand (the `token_hash` unique constraint does not care about `used_at`),
// and it would make the raw token a public string in this source file.
const randomTokenHash = (): string => sha256(randomBytes(32).toString('base64url'));

const randomPassword = (): string => randomBytes(15).toString('base64url');

export interface SeedDemoResolvedEnvironment {
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl: string;
  readonly appPublicUrl: string;
  /** Recorded as the accepted versions for every demo account, like the new-account route does. */
  readonly termsVersion: string;
  readonly privacyVersion: string;
}

export const resolveSeedEnvironment = (env: Record<string, string | undefined>): SeedDemoResolvedEnvironment => ({
  databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? DEFAULT_MIGRATION_DATABASE_URL,
  appPublicUrl: (env.APP_PUBLIC_URL ?? DEFAULT_APP_PUBLIC_URL).replace(/\/+$/, ''),
  termsVersion: env.AUTH_TERMS_VERSION ?? DEFAULT_TERMS_VERSION,
  privacyVersion: env.AUTH_PRIVACY_VERSION ?? DEFAULT_PRIVACY_VERSION
});

const isProductionRuntime = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'production';

/**
 * Host, port and database the driver would connect to, so the two connections cannot silently
 * target different databases. Read from `connectionParameters`, the same parser
 * `assertLocalDatabaseUrl` uses: `new URL` would miss a `?port=` (or `?dbname=`) override.
 */
const databaseIdentity = (connectionString: string): string => {
  const parameters = (new Client(connectionString) as unknown as {
    connectionParameters: { host?: unknown; port?: unknown; database?: unknown };
  }).connectionParameters;
  const hostname = (typeof parameters.host === 'string' ? parameters.host : '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  // The loopback spellings are the same server in practice; anything else compares literally.
  const host = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.') ? 'loopback' : hostname;
  const port = typeof parameters.port === 'number' ? parameters.port : 5432;
  const database = typeof parameters.database === 'string' ? parameters.database : '';
  return `${host}:${port}/${database}`;
};

/**
 * The gate that keeps the command local: an explicit flag, a non-production runtime, a loopback
 * database for both connections and both connections pointing at the same database. Any failure
 * aborts before the first write -- and before any password is rotated.
 */
export const assertSeedAllowed = (input: {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl: string;
}): void => {
  if (!input.argv.includes(SEED_FLAG)) {
    throw new SeedDemoError(`This command only creates local demo data. Pass ${SEED_FLAG} to confirm.`);
  }
  const unknown = input.argv.filter((argument) => argument !== SEED_FLAG);
  if (unknown.length > 0) {
    throw new SeedDemoError(`Unknown argument: ${unknown.join(' ')}. Usage: pnpm seed:demo ${SEED_FLAG}`);
  }
  if (isProductionRuntime(input.env.NODE_ENV) || isProductionRuntime(input.env.APP_ENV)) {
    throw new SeedDemoError('Refusing to run with NODE_ENV/APP_ENV=production.');
  }
  try {
    assertLocalDatabaseUrl(input.databaseUrl);
    assertLocalDatabaseUrl(input.migrationDatabaseUrl);
  } catch {
    throw new SeedDemoError('Refusing to run: both DATABASE_URL and MIGRATION_DATABASE_URL must point at a loopback host (127.0.0.1 or localhost).');
  }
  if (databaseIdentity(input.databaseUrl) !== databaseIdentity(input.migrationDatabaseUrl)) {
    throw new SeedDemoError('Refusing to run: DATABASE_URL and MIGRATION_DATABASE_URL must point at the same host, port and database.');
  }
};

interface DemoUserSpec {
  readonly key: string;
  readonly name: string;
  /** Local part; the domain is a run option so an isolated run never touches real demo accounts. */
  readonly emailLocal: string;
  readonly jobTitle: string;
  /** A system preset key, or `owner` for the agency owner. */
  readonly roleKey: string;
}

const MAIN_AGENCY = { key: 'agency:horizonte', name: 'Agência Horizonte' } as const;
const SECOND_AGENCY = { key: 'agency:ponte', name: 'Estúdio Ponte' } as const;

const MAIN_USERS: readonly DemoUserSpec[] = [
  { key: 'user:marina', name: 'Marina Duarte', emailLocal: 'dono', jobTitle: 'Diretora', roleKey: 'owner' },
  { key: 'user:rafael', name: 'Rafael Lima', emailLocal: 'admin', jobTitle: 'Head de operações', roleKey: 'admin' },
  { key: 'user:camila', name: 'Camila Nogueira', emailLocal: 'gestor', jobTitle: 'Gestora de contas', roleKey: 'account_manager' },
  { key: 'user:bruno', name: 'Bruno Salles', emailLocal: 'producao', jobTitle: 'Diretor de arte', roleKey: 'production' },
  { key: 'user:leticia', name: 'Letícia Prado', emailLocal: 'vendas', jobTitle: 'Executiva de vendas', roleKey: 'sales' },
  { key: 'user:otavio', name: 'Otávio Reis', emailLocal: 'financeiro', jobTitle: 'Analista financeiro', roleKey: 'finance' }
];

const SECOND_USERS: readonly DemoUserSpec[] = [
  { key: 'user:helena', name: 'Helena Costa', emailLocal: 'dono.ponte', jobTitle: 'Sócia', roleKey: 'owner' },
  { key: 'user:paulo', name: 'Paulo Menezes', emailLocal: 'producao.ponte', jobTitle: 'Designer', roleKey: 'production' }
];

const PORTAL_USER = { key: 'user:sofia', name: 'Sofia Andrade', emailLocal: 'portal' } as const;

// Pending invites carry a real role: `invitations_insert` (20260928000000) refuses a
// collaborator invite whose role_id does not resolve to a role scoped to the agency.
const PENDING_COLLABORATOR_INVITES = [
  { emailLocal: 'pendente.um', roleKey: 'production' },
  { emailLocal: 'pendente.dois', roleKey: 'sales' }
] as const;

interface DemoSectionSpec {
  readonly sectionKey: 'branding' | 'tone_of_voice' | 'colors' | 'positioning' | 'archetype' | 'observations';
  readonly body?: string;
  readonly colors?: readonly { readonly nome: string; readonly codigoHexadecimal: string }[];
  readonly archetype?: string;
}

interface DemoPersonaSpec {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly pains: string;
  readonly desires: string;
  readonly objections: string;
}

interface DemoThreadCommentSpec {
  readonly key: string;
  readonly author: string;
  readonly side: 'agency' | 'client';
  readonly body: string;
}

interface DemoThreadSpec {
  readonly key: string;
  readonly sectionKey?: string;
  readonly personaKey?: string;
  readonly openedBy: string;
  readonly openedSide: 'agency' | 'client';
  readonly resolvedBy?: string;
  readonly comments: readonly DemoThreadCommentSpec[];
}

interface DemoClientSpec {
  readonly key: string;
  readonly name: string;
  readonly registration?: {
    readonly legalName?: string;
    readonly taxId?: string;
    readonly segment?: string;
    readonly website?: string;
    readonly instagramHandle?: string;
    readonly contactName?: string;
    readonly contactPhone?: string;
    readonly contactEmail?: string;
  };
  readonly sections?: readonly DemoSectionSpec[];
  readonly personas?: readonly DemoPersonaSpec[];
  readonly threads?: readonly DemoThreadSpec[];
}

// One archived client and one with a scheduled closing are part of issue #183, but archiving and
// `closing_date` only exist through the security-definer functions of issue #123, which is still
// open; creating those states here would mean writing columns the application role deliberately
// cannot touch. Recorded as an open point in the pull request instead.
const MAIN_CLIENTS: readonly DemoClientSpec[] = [
  {
    key: 'client:padaria-central',
    name: 'Padaria Central',
    registration: {
      legalName: 'Padaria Central Ltda.',
      taxId: '12345678000199',
      segment: 'Alimentação',
      website: 'https://padariacentral.exemplo.test',
      instagramHandle: 'padariacentral',
      contactName: 'João Batista',
      contactPhone: '+55 11 95555-0101',
      contactEmail: 'joao@padariacentral.exemplo.test'
    },
    sections: [
      { sectionKey: 'branding', body: 'Marca de bairro, feita para o café da manhã de quem mora perto. O pão quente é o herói.' },
      { sectionKey: 'tone_of_voice', body: 'Próxima e calorosa, sem infantilizar. Fala como quem atende no balcão.' },
      { sectionKey: 'colors', colors: [{ nome: 'Vermelho terracota', codigoHexadecimal: '#B4472F' }, { nome: 'Creme de trigo', codigoHexadecimal: '#F3E3C3' }] },
      { sectionKey: 'positioning', body: 'A padaria que conhece o bairro pelo nome, com fermentação natural e preço justo.' },
      { sectionKey: 'archetype', archetype: 'Cara comum' },
      { sectionKey: 'observations', body: 'O horário de pico é entre 7h e 9h; as campanhas devem evitar esse intervalo.' }
    ],
    personas: [
      {
        key: 'persona:padaria-moradora',
        name: 'Moradora do bairro',
        description: 'Trabalha perto, passa a pé todos os dias e compra para levar.',
        pains: 'Fila grande no horário de pico e pão que acaba cedo.',
        desires: 'Resolver o café da manhã em minutos, com qualidade constante.',
        objections: 'Acha caro quando o preço sobe sem aviso.'
      },
      {
        key: 'persona:padaria-escritorio',
        name: 'Escritório vizinho',
        description: 'Faz encomendas de última hora para reuniões pequenas.',
        pains: 'Não sabe se a encomenda chega a tempo.',
        desires: 'Confirmar o pedido por WhatsApp e receber no horário.',
        objections: 'Já teve pedido errado em outra padaria.'
      }
    ],
    threads: [
      {
        key: 'thread:padaria-positioning',
        sectionKey: 'positioning',
        openedBy: PORTAL_USER.key,
        openedSide: 'client',
        comments: [
          { key: 'comment:padaria-positioning-1', author: PORTAL_USER.key, side: 'client', body: 'O texto do posicionamento ficou mais formal do que a gente fala no balcão. Podemos deixar mais próximo?' }
        ]
      },
      {
        key: 'thread:padaria-branding',
        sectionKey: 'branding',
        openedBy: 'user:rafael',
        openedSide: 'agency',
        resolvedBy: 'user:rafael',
        comments: [
          { key: 'comment:padaria-branding-1', author: 'user:rafael', side: 'agency', body: 'Atualizei o branding com a história do fermento de 2012. Faz sentido para vocês?' },
          { key: 'comment:padaria-branding-2', author: PORTAL_USER.key, side: 'client', body: 'Faz! O fermento é o que mais aparece nas avaliações.' }
        ]
      }
    ]
  },
  {
    key: 'client:clinica-viver-bem',
    name: 'Clínica Viver Bem',
    registration: {
      legalName: 'Viver Bem Saúde Ltda.',
      taxId: '98765432000188',
      segment: 'Saúde',
      website: 'https://viverbem.exemplo.test',
      instagramHandle: 'clinicaviverbem',
      contactName: 'Dra. Alice Prado',
      contactPhone: '+55 21 94444-0202',
      contactEmail: 'contato@viverbem.exemplo.test'
    },
    sections: [
      { sectionKey: 'branding', body: 'Cuidado próximo, sem alarmismo. A clínica acompanha a família inteira.' },
      { sectionKey: 'tone_of_voice', body: 'Acolhedora e clara; explica antes de recomendar.' }
    ],
    personas: [
      {
        key: 'persona:viver-bem-familia',
        name: 'Mãe de dois filhos',
        description: 'Organiza a saúde da casa e decide onde todos são atendidos.',
        pains: 'Não consegue encaixar consultas de rotina na agenda.',
        desires: 'Um lugar só, com lembretes de retorno.',
        objections: 'Tem receio de esperar muito com criança pequena.'
      }
    ],
    threads: [
      {
        key: 'thread:viver-bem-tone',
        sectionKey: 'tone_of_voice',
        openedBy: 'user:camila',
        openedSide: 'agency',
        comments: [
          { key: 'comment:viver-bem-tone-1', author: 'user:camila', side: 'agency', body: 'Sugeri um tom mais direto para as redes; a recepção prefere manter o acolhedor. Deixei as duas opções na seção.' }
        ]
      }
    ]
  },
  { key: 'client:estudio-mova', name: 'Estúdio Mova' },
  {
    key: 'client:cafe-do-alto',
    name: 'Café do Alto',
    registration: { segment: 'Cafeteria', instagramHandle: 'cafedoalto' },
    sections: [
      { sectionKey: 'colors', colors: [{ nome: 'Verde montanha', codigoHexadecimal: '#2F5D50' }, { nome: 'Areia', codigoHexadecimal: '#E5D9C3' }] },
      { sectionKey: 'archetype', archetype: 'Explorador' }
    ]
  },
  {
    key: 'client:colegio-nova-era',
    name: 'Colégio Nova Era',
    registration: {
      legalName: 'Instituto Nova Era de Ensino',
      taxId: '11222333000144',
      segment: 'Educação',
      website: 'https://novaera.exemplo.test',
      contactName: 'Rita Campos',
      contactEmail: 'secretaria@novaera.exemplo.test'
    }
  },
  { key: 'client:oficina-ferro-e-fogo', name: 'Oficina Ferro & Fogo' }
];

const SECOND_CLIENT: DemoClientSpec = {
  key: 'client:livraria-pagina-viva',
  name: 'Livraria Página Viva',
  registration: { segment: 'Livraria', instagramHandle: 'pagina.viva' },
  sections: [{ sectionKey: 'branding', body: 'Livraria de rua com clube de leitura mensal e sarau no fim do mês.' }]
};

export interface SeedDemoProfile {
  readonly label: string;
  readonly email: string;
  readonly password: string;
  /** `null` for a client-portal profile; the agency id to open otherwise. */
  readonly agencyId: string | null;
  readonly clientId: string | null;
  readonly url: string;
}

export interface SeedDemoResult {
  readonly profiles: readonly SeedDemoProfile[];
  readonly pendingInvitations: readonly string[];
  readonly agencyIds: readonly string[];
  readonly userIds: readonly string[];
  readonly clientIds: readonly string[];
}

interface SystemRoles {
  readonly byKey: ReadonlyMap<string, string>;
}

const loadSystemRoles = async (owner: DatabaseClient): Promise<SystemRoles> => {
  const roles = await owner.transaction((transaction) =>
    raw<RawRows<{ id: string; key: string }>>(transaction, 'select id, key from public.roles where agency_id is null', [])
  );
  return { byKey: new Map(roles.rows.map((role) => [role.key, role.id])) };
};

const ensureUser = async (database: DatabaseClient, user: { id: string; name: string; email: string; passwordHash: string }): Promise<string> => {
  return database.transaction(async (transaction) => {
    const inserted = await raw<RawRows<{ id: string }>>(transaction, `
      insert into auth."user" (id, name, email, "emailVerified", "updatedAt")
      values (?::uuid, ?, ?, true, now())
      on conflict (email) do update set name = excluded.name, "updatedAt" = now()
      returning id
    `, [user.id, user.name, user.email]);
    const userId = oneRow(inserted.rows, `Could not create the demo user ${user.email}.`).id;

    const existing = await raw<RawRows<{ id: string }>>(transaction, `
      select id from auth."account" where "userId" = ?::uuid and "providerId" = 'credential' limit 1
    `, [userId]);
    if (existing.rows[0] === undefined) {
      await raw(transaction, `
        insert into auth."account" (id, "accountId", "providerId", "userId", password, "updatedAt")
        values (gen_random_uuid(), ?, 'credential', ?::uuid, ?, now())
      `, [userId, userId, user.passwordHash]);
    } else {
      await raw(transaction, 'update auth."account" set password = ?, "updatedAt" = now() where id = ?::uuid', [user.passwordHash, existing.rows[0].id]);
    }
    // The password just rotated, so any session opened with the old one dies with it: the printed
    // output is the only valid credential from now on (same effect a password reset has).
    await raw(transaction, 'delete from auth."session" where "userId" = ?::uuid', [userId]);
    return userId;
  });
};

const ensureAgency = async (owner: DatabaseClient, agency: { id: string; name: string }): Promise<void> => {
  await owner.transaction(async (transaction) => {
    await raw(transaction, `
      insert into public.agencies (id, name, status)
      values (?::uuid, ?, 'active')
      on conflict (id) do update set name = excluded.name, updated_at = now()
    `, [agency.id, agency.name]);
  });
};

const findPendingInvitation = async (
  transaction: SeedTransaction,
  filter: { agencyId: string; purpose: 'agency_activation' | 'collaborator_invite' | 'client_invite'; email: string; clientId: string | null }
): Promise<{ id: string; tokenHash: string; expiresAt: Date } | undefined> => {
  const result = await raw<RawRows<{ id: string; token_hash: string; expires_at: Date }>>(transaction, `
    select id, token_hash, expires_at
    from public.invitations
    where agency_id = ?::uuid
      and purpose = ?
      and email = ?
      and client_id is not distinct from ?::uuid
      and used_at is null
      and revoked_at is null
    limit 1
  `, [filter.agencyId, filter.purpose, filter.email, filter.clientId]);
  const row = result.rows[0];
  return row === undefined ? undefined : { id: row.id, tokenHash: row.token_hash, expiresAt: new Date(row.expires_at) };
};

const insertInvitation = async (
  transaction: SeedTransaction,
  invitation: {
    agencyId: string;
    purpose: 'agency_activation' | 'collaborator_invite' | 'client_invite';
    email: string;
    tokenHash: string;
    roleId: string | null;
    clientId: string | null;
    invitedByUserId: string | null;
  }
): Promise<void> => {
  await raw(transaction, `
    insert into public.invitations
      (id, agency_id, purpose, email, role_id, client_id, token_hash, expires_at, invited_by_user_id)
    values (gen_random_uuid(), ?::uuid, ?, ?, ?::uuid, ?::uuid, ?, now() + ${INVITATION_EXPIRY}, ?::uuid)
  `, [
    invitation.agencyId,
    invitation.purpose,
    invitation.email,
    invitation.roleId,
    invitation.clientId,
    invitation.tokenHash,
    invitation.invitedByUserId
  ]);
};

interface SeedVersions {
  readonly terms: string;
  readonly privacy: string;
}

const acceptInvitation = async (database: DatabaseClient, userId: string, tokenHash: string, versions: SeedVersions): Promise<void> => {
  await withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId }), async (transaction) => {
    // Every seeded account is new, so the acceptance is recorded exactly like the real
    // `accept-new-account` route does: both documents, with the configured versions.
    await raw(transaction, 'select * from app_private.accept_invitation(?, ?::uuid, ?, ?, true)', [tokenHash, userId, versions.terms, versions.privacy]);
  });
};

/**
 * Invites one person and accepts for them, the same pair of steps the application uses. When an
 * active membership already exists, nothing happens; a pending invitation is reused; an expired
 * one is revoked first, like a resend would.
 */
const ensureInvitationAccepted = async (input: {
  readonly database: DatabaseClient;
  readonly ownerDatabase: DatabaseClient;
  readonly inviterUserId: string | null;
  readonly agencyId: string;
  readonly purpose: 'agency_activation' | 'collaborator_invite' | 'client_invite';
  readonly email: string;
  readonly roleId: string | null;
  readonly clientId: string | null;
  readonly inviteeUserId: string;
  readonly versions: SeedVersions;
}): Promise<void> => {
  const { database, agencyId, purpose, email, clientId, inviteeUserId } = input;
  const run = async (transaction: SeedTransaction): Promise<string> => {
    const pending = await findPendingInvitation(transaction, { agencyId, purpose, email, clientId });
    if (pending !== undefined && pending.expiresAt.getTime() > Date.now()) return pending.tokenHash;
    if (pending !== undefined) {
      await raw(transaction, 'update public.invitations set revoked_at = now() where id = ?::uuid', [pending.id]);
    }
    const tokenHash = randomTokenHash();
    await insertInvitation(transaction, {
      agencyId,
      purpose,
      email,
      tokenHash,
      roleId: input.roleId,
      clientId,
      invitedByUserId: input.inviterUserId
    });
    return tokenHash;
  };

  const tokenHash = input.inviterUserId === null
    // Agency activation has no inviter yet and no INSERT policy for the application role; the
    // migration owner is the same path `cli:agency` uses to create it.
    ? await input.ownerDatabase.transaction((transaction) => run(transaction))
    : await withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId: input.inviterUserId }), (transaction) => run(transaction));

  try {
    await acceptInvitation(database, inviteeUserId, tokenHash, input.versions);
  } catch (error) {
    throw new SeedDemoError(`Could not accept the ${purpose} invitation for ${email}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
};

// Both existence checks run under the person's own transaction-local identity: the RLS policy
// only shows a membership to its owner (`user_id = app_private.current_user_id()`), so a plain
// connection would always answer "no" and the seed would try to invite an existing member again.
const activeAgencyMembershipExists = async (database: DatabaseClient, agencyId: string, userId: string): Promise<boolean> => {
  const result = await withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId }), (transaction) =>
    raw<RawRows<{ exists: boolean }>>(transaction, `
      select exists(
        select 1 from public.agency_memberships where agency_id = ?::uuid and user_id = ?::uuid and status = 'active'
      ) as exists
    `, [agencyId, userId])
  );
  return result.rows[0]?.exists === true;
};

const activeClientMembershipExists = async (database: DatabaseClient, clientId: string, userId: string): Promise<boolean> => {
  const result = await withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId }), (transaction) =>
    raw<RawRows<{ exists: boolean }>>(transaction, `
      select exists(
        select 1 from public.client_memberships where client_id = ?::uuid and user_id = ?::uuid and status = 'active'
      ) as exists
    `, [clientId, userId])
  );
  return result.rows[0]?.exists === true;
};

const ensureAgencyOwner = async (input: {
  readonly database: DatabaseClient;
  readonly ownerDatabase: DatabaseClient;
  readonly ownerUserId: string;
  readonly agencyId: string;
  readonly email: string;
  readonly versions: SeedVersions;
}): Promise<void> => {
  // The migration owner reads the agency here: `agencies_select` deliberately hides it from the
  // application role before the caller has a membership.
  const current = await input.ownerDatabase.transaction((transaction) =>
    raw<RawRows<{ owner_user_id: string | null }>>(transaction, 'select owner_user_id from public.agencies where id = ?::uuid', [input.agencyId])
  );
  const agency = current.rows[0];
  if (agency === undefined) throw new SeedDemoError('The demo agency could not be created.');
  if (agency.owner_user_id !== null) return;
  await ensureInvitationAccepted({
    database: input.database,
    ownerDatabase: input.ownerDatabase,
    inviterUserId: null,
    agencyId: input.agencyId,
    purpose: 'agency_activation',
    email: input.email,
    roleId: null,
    clientId: null,
    inviteeUserId: input.ownerUserId,
    versions: input.versions
  });
};

const ensurePresetMembership = async (input: {
  readonly database: DatabaseClient;
  readonly ownerDatabase: DatabaseClient;
  readonly inviterUserId: string;
  readonly inviteeUserId: string;
  readonly agencyId: string;
  readonly email: string;
  readonly roleId: string;
  readonly versions: SeedVersions;
}): Promise<void> => {
  if (await activeAgencyMembershipExists(input.database, input.agencyId, input.inviteeUserId)) return;
  await ensureInvitationAccepted({
    database: input.database,
    ownerDatabase: input.ownerDatabase,
    inviterUserId: input.inviterUserId,
    agencyId: input.agencyId,
    purpose: 'collaborator_invite',
    email: input.email,
    roleId: input.roleId,
    clientId: null,
    inviteeUserId: input.inviteeUserId,
    versions: input.versions
  });
};

const ensurePortalMembership = async (input: {
  readonly database: DatabaseClient;
  readonly ownerDatabase: DatabaseClient;
  readonly inviterUserId: string;
  readonly inviteeUserId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly email: string;
  readonly versions: SeedVersions;
}): Promise<void> => {
  if (await activeClientMembershipExists(input.database, input.clientId, input.inviteeUserId)) return;
  await ensureInvitationAccepted({
    database: input.database,
    ownerDatabase: input.ownerDatabase,
    inviterUserId: input.inviterUserId,
    agencyId: input.agencyId,
    purpose: 'client_invite',
    email: input.email,
    roleId: null,
    clientId: input.clientId,
    inviteeUserId: input.inviteeUserId,
    versions: input.versions
  });
};

/**
 * Writes `agency_memberships.job_title` through the application path: the Owner holds
 * `colaborador.alterar_funcao`, and the BEFORE UPDATE trigger is the one that checks it.
 */
const ensureJobTitle = async (input: {
  readonly database: DatabaseClient;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly jobTitle: string;
}): Promise<void> => {
  await withAuthenticatedUserTransaction(input.database, createVerifiedUserClaims({ userId: input.actorUserId }), async (transaction) => {
    await raw(transaction, `
      update public.agency_memberships
      set job_title = ?, updated_at = now()
      where agency_id = ?::uuid and user_id = ?::uuid
    `, [input.jobTitle, input.agencyId, input.targetUserId]);
  });
};

const ensurePendingCollaboratorInvitations = async (input: {
  readonly database: DatabaseClient;
  readonly inviterUserId: string;
  readonly agencyId: string;
  readonly invites: readonly { readonly email: string; readonly roleId: string }[];
}): Promise<void> => {
  await withAuthenticatedUserTransaction(input.database, createVerifiedUserClaims({ userId: input.inviterUserId }), async (transaction) => {
    for (const invite of input.invites) {
      const pending = await findPendingInvitation(transaction, { agencyId: input.agencyId, purpose: 'collaborator_invite', email: invite.email, clientId: null });
      if (pending !== undefined && pending.expiresAt.getTime() > Date.now()) continue;
      if (pending !== undefined) {
        await raw(transaction, 'update public.invitations set revoked_at = now() where id = ?::uuid', [pending.id]);
      }
      await insertInvitation(transaction, {
        agencyId: input.agencyId,
        purpose: 'collaborator_invite',
        email: invite.email,
        tokenHash: randomTokenHash(),
        roleId: invite.roleId,
        clientId: null,
        invitedByUserId: input.inviterUserId
      });
    }
  });
};

const ensureClient = async (database: DatabaseClient, userId: string, agencyId: string, client: DemoClientSpec, idFor: SeedId): Promise<void> => {
  await withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId }), async (transaction) => {
    // Insert and update are separate on purpose: `updated_by` is outside the INSERT grant and is
    // required to equal the caller on every UPDATE, so the upsert cannot be a single statement.
    await raw(transaction, `
      insert into public.clients
        (id, agency_id, name, legal_name, tax_id, segment, website, instagram_handle, contact_name, contact_phone, contact_email)
      values (?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (id) do nothing
    `, [
      idFor(client.key),
      agencyId,
      client.name,
      client.registration?.legalName ?? null,
      client.registration?.taxId ?? null,
      client.registration?.segment ?? null,
      client.registration?.website ?? null,
      client.registration?.instagramHandle ?? null,
      client.registration?.contactName ?? null,
      client.registration?.contactPhone ?? null,
      client.registration?.contactEmail ?? null
    ]);
    await raw(transaction, `
      update public.clients set
        name = ?,
        legal_name = ?,
        tax_id = ?,
        segment = ?,
        website = ?,
        instagram_handle = ?,
        contact_name = ?,
        contact_phone = ?,
        contact_email = ?,
        updated_by = ?::uuid,
        updated_at = now()
      where id = ?::uuid
    `, [
      client.name,
      client.registration?.legalName ?? null,
      client.registration?.taxId ?? null,
      client.registration?.segment ?? null,
      client.registration?.website ?? null,
      client.registration?.instagramHandle ?? null,
      client.registration?.contactName ?? null,
      client.registration?.contactPhone ?? null,
      client.registration?.contactEmail ?? null,
      userId,
      idFor(client.key)
    ]);
  });
};

const ensureBrandStudy = async (database: DatabaseClient, userId: string, client: DemoClientSpec, idFor: SeedId): Promise<void> => {
  await withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId }), async (transaction) => {
    for (const section of client.sections ?? []) {
      await raw(transaction, `
        insert into public.client_brand_sections (client_id, section_key, body, colors, archetype, updated_by)
        values (?::uuid, ?, ?, ?::jsonb, ?, ?::uuid)
        on conflict (client_id, section_key) do update set
          body = excluded.body,
          colors = excluded.colors,
          archetype = excluded.archetype,
          updated_by = excluded.updated_by,
          updated_at = now()
      `, [
        idFor(client.key),
        section.sectionKey,
        section.body ?? null,
        section.colors === undefined ? null : JSON.stringify(section.colors),
        section.archetype ?? null,
        userId
      ]);
    }
    for (const persona of client.personas ?? []) {
      await raw(transaction, `
        insert into public.client_personas (id, client_id, name, description, pains, desires, objections, updated_by)
        values (?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?::uuid)
        on conflict (id) do update set
          name = excluded.name,
          description = excluded.description,
          pains = excluded.pains,
          desires = excluded.desires,
          objections = excluded.objections,
          updated_by = excluded.updated_by,
          updated_at = now()
      `, [
        idFor(persona.key),
        idFor(client.key),
        persona.name,
        persona.description,
        persona.pains,
        persona.desires,
        persona.objections,
        userId
      ]);
    }
  });
};

const ensureThreads = async (input: {
  readonly database: DatabaseClient;
  readonly userIdByKey: ReadonlyMap<string, string>;
  readonly client: DemoClientSpec;
  readonly idFor: SeedId;
}): Promise<void> => {
  const { database, client, userIdByKey, idFor } = input;
  for (const thread of client.threads ?? []) {
    const openedById = userIdByKey.get(thread.openedBy);
    if (openedById === undefined) throw new SeedDemoError(`Unknown thread author ${thread.openedBy}.`);
    await withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId: openedById }), async (transaction) => {
      await raw(transaction, `
        insert into public.client_threads (id, client_id, section_key, persona_id, opened_by, opened_side)
        values (?::uuid, ?::uuid, ?, ?::uuid, ?::uuid, ?)
        on conflict (id) do nothing
      `, [
        idFor(thread.key),
        idFor(client.key),
        thread.sectionKey ?? null,
        thread.personaKey === undefined ? null : idFor(thread.personaKey),
        openedById,
        thread.openedSide
      ]);
    });
    for (const comment of thread.comments) {
      // Each comment is written under its own author: `author_user_id = current_user_id()` is part
      // of the policy, so the agency cannot comment as the client, nor the client as the agency.
      const authorId = userIdByKey.get(comment.author);
      if (authorId === undefined) throw new SeedDemoError(`Unknown comment author ${comment.author}.`);
      await withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId: authorId }), async (transaction) => {
        await raw(transaction, `
          insert into public.client_thread_comments (id, thread_id, client_id, author_user_id, author_side, body)
          values (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?)
          on conflict (id) do nothing
        `, [idFor(comment.key), idFor(thread.key), idFor(client.key), authorId, comment.side, comment.body]);
      });
    }
    if (thread.resolvedBy !== undefined) {
      const resolverId = userIdByKey.get(thread.resolvedBy);
      if (resolverId === undefined) throw new SeedDemoError(`Unknown resolver ${thread.resolvedBy}.`);
      await withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId: resolverId }), async (transaction) => {
        await raw(transaction, 'update public.client_threads set resolved_by = ?::uuid where id = ?::uuid', [resolverId, idFor(thread.key)]);
      });
    }
  }
};

const formatProfiles = (profiles: readonly SeedDemoProfile[]): string => {
  const width = Math.max(...profiles.map((profile) => profile.label.length), 'papel'.length);
  const emailWidth = Math.max(...profiles.map((profile) => profile.email.length), 'e-mail'.length);
  const lines = profiles.map((profile) =>
    `  ${profile.label.padEnd(width)}  ${profile.email.padEnd(emailWidth)}  ${profile.password}`
  );
  return [`  ${'papel'.padEnd(width)}  ${'e-mail'.padEnd(emailWidth)}  senha`, ...lines].join('\n');
};

export interface SeedDemoOptions {
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  readonly stdout?: { write(chunk: string): void };
  /**
   * Prefix for every derived identifier. The integration suite uses a random namespace so its
   * run cannot touch the developer's demo dataset (and its cleanup cannot delete it).
   */
  readonly namespace?: string;
  /** Domain for every demo email; same reason as `namespace`, and it keeps the unique emails apart. */
  readonly emailDomain?: string;
  /** Test seam: builds the two database clients. Defaults to the real client factory. */
  readonly connect?: (options: { readonly connectionString: string }) => DatabaseClient;
}

/** Creates (or refreshes) the demo dataset. Throws `SeedDemoError` before writing when not local. */
export const runSeedDemo = async (options: SeedDemoOptions): Promise<SeedDemoResult> => {
  const environment = resolveSeedEnvironment(options.env);
  assertSeedAllowed({
    argv: options.argv,
    env: options.env,
    databaseUrl: environment.databaseUrl,
    migrationDatabaseUrl: environment.migrationDatabaseUrl
  });

  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const emailDomain = options.emailDomain ?? DEFAULT_EMAIL_DOMAIN;
  const idFor: SeedId = (key) => demoId(`${namespace}:${key}`);
  const emailFor = (localPart: string): string => `${localPart}@${emailDomain}`;
  const versions: SeedVersions = { terms: environment.termsVersion, privacy: environment.privacyVersion };
  const connect = options.connect ?? createDatabaseClient;

  const database = connect({ connectionString: environment.databaseUrl });
  const owner = connect({ connectionString: environment.migrationDatabaseUrl });
  try {
    const roles = await loadSystemRoles(owner);
    const profiles: SeedDemoProfile[] = [];
    const userIds: string[] = [];
    const agencyIds: string[] = [];
    const clientIds: string[] = [];

    const passwordByEmail = new Map<string, string>();
    const passwordFor = (email: string): string => {
      const existing = passwordByEmail.get(email);
      if (existing !== undefined) return existing;
      const password = randomPassword();
      passwordByEmail.set(email, password);
      return password;
    };

    const ensureTeam = async (agency: { key: string; name: string }, users: readonly DemoUserSpec[]): Promise<Map<string, string>> => {
      const agencyId = idFor(agency.key);
      agencyIds.push(agencyId);
      await ensureAgency(owner, { id: agencyId, name: agency.name });

      const userIdByKey = new Map<string, string>();
      for (const user of users) {
        const email = emailFor(user.emailLocal);
        const userId = await ensureUser(database, {
          id: idFor(user.key),
          name: user.name,
          email,
          passwordHash: await hashPassword(passwordFor(email))
        });
        userIdByKey.set(user.key, userId);
        userIds.push(userId);
      }

      const ownerSpec = users.find((user) => user.roleKey === 'owner');
      if (ownerSpec === undefined) throw new SeedDemoError(`Agency ${agency.name} needs an owner.`);
      const ownerUserId = userIdByKey.get(ownerSpec.key)!;
      await ensureAgencyOwner({
        database,
        ownerDatabase: owner,
        ownerUserId,
        agencyId,
        email: emailFor(ownerSpec.emailLocal),
        versions
      });
      await ensureJobTitle({ database, agencyId, actorUserId: ownerUserId, targetUserId: ownerUserId, jobTitle: ownerSpec.jobTitle });
      profiles.push({
        label: 'Owner',
        email: emailFor(ownerSpec.emailLocal),
        password: passwordFor(emailFor(ownerSpec.emailLocal)),
        agencyId,
        clientId: null,
        url: `${environment.appPublicUrl}/agencia/${agencyId}`
      });

      for (const user of users) {
        if (user.roleKey === 'owner') continue;
        const roleId = roles.byKey.get(user.roleKey);
        if (roleId === undefined) throw new SeedDemoError(`Unknown system role ${user.roleKey}.`);
        const email = emailFor(user.emailLocal);
        const inviteeUserId = userIdByKey.get(user.key)!;
        await ensurePresetMembership({
          database,
          ownerDatabase: owner,
          inviterUserId: ownerUserId,
          inviteeUserId,
          agencyId,
          email,
          roleId,
          versions
        });
        await ensureJobTitle({ database, agencyId, actorUserId: ownerUserId, targetUserId: inviteeUserId, jobTitle: user.jobTitle });
        profiles.push({
          label: roleName(user.roleKey),
          email,
          password: passwordFor(email),
          agencyId,
          clientId: null,
          url: `${environment.appPublicUrl}/agencia/${agencyId}`
        });
      }
      return userIdByKey;
    };

    const mainUserIds = await ensureTeam(MAIN_AGENCY, MAIN_USERS);
    const mainOwnerId = mainUserIds.get('user:marina')!;

    // Portal person, created the same way a client invite is accepted.
    const portalEmail = emailFor(PORTAL_USER.emailLocal);
    const portalUserId = await ensureUser(database, {
      id: idFor(PORTAL_USER.key),
      name: PORTAL_USER.name,
      email: portalEmail,
      passwordHash: await hashPassword(passwordFor(portalEmail))
    });
    userIds.push(portalUserId);

    const mainAgencyId = idFor(MAIN_AGENCY.key);
    const adminUserId = mainUserIds.get('user:rafael')!;
    const userIdByKey = new Map<string, string>([...mainUserIds, [PORTAL_USER.key, portalUserId]]);

    for (const client of MAIN_CLIENTS) {
      clientIds.push(idFor(client.key));
      await ensureClient(database, adminUserId, mainAgencyId, client, idFor);
      await ensureBrandStudy(database, adminUserId, client, idFor);
    }

    const portalClient = MAIN_CLIENTS.find((client) => client.threads?.some((thread) => thread.openedSide === 'client'));
    if (portalClient === undefined) throw new SeedDemoError('The demo needs one client with a portal conversation.');
    const portalClientId = idFor(portalClient.key);
    // The portal membership comes before the threads: a client-side thread is only allowed for an
    // active vínculo, and the seed creates conversations through the same policy.
    await ensurePortalMembership({
      database,
      ownerDatabase: owner,
      inviterUserId: adminUserId,
      inviteeUserId: portalUserId,
      agencyId: mainAgencyId,
      clientId: portalClientId,
      email: portalEmail,
      versions
    });

    for (const client of MAIN_CLIENTS) {
      await ensureThreads({ database, userIdByKey, client, idFor });
    }
    profiles.push({
      label: 'Portal',
      email: portalEmail,
      password: passwordFor(portalEmail),
      agencyId: null,
      clientId: portalClientId,
      url: `${environment.appPublicUrl}/portal/${portalClientId}`
    });

    await ensurePendingCollaboratorInvitations({
      database,
      inviterUserId: mainOwnerId,
      agencyId: mainAgencyId,
      invites: PENDING_COLLABORATOR_INVITES.map((invite) => {
        const roleId = roles.byKey.get(invite.roleKey);
        if (roleId === undefined) throw new SeedDemoError(`Unknown system role ${invite.roleKey}.`);
        return { email: emailFor(invite.emailLocal), roleId };
      })
    });

    const secondUserIds = await ensureTeam(SECOND_AGENCY, SECOND_USERS);
    const secondAgencyId = idFor(SECOND_AGENCY.key);
    // The owner creates the client: `cliente.cadastrar` belongs to admin/account_manager, and the
    // second agency is deliberately small (owner + production only), where only posse reaches it.
    const secondOwnerId = secondUserIds.get('user:helena')!;
    clientIds.push(idFor(SECOND_CLIENT.key));
    await ensureClient(database, secondOwnerId, secondAgencyId, SECOND_CLIENT, idFor);
    await ensureBrandStudy(database, secondOwnerId, SECOND_CLIENT, idFor);

    const pendingInvitationEmails = PENDING_COLLABORATOR_INVITES.map((invite) => emailFor(invite.emailLocal));
    const result: SeedDemoResult = {
      profiles,
      pendingInvitations: pendingInvitationEmails,
      agencyIds: [...new Set(agencyIds)],
      userIds: [...new Set(userIds)],
      clientIds: [...new Set(clientIds)]
    };

    const stdout = options.stdout ?? process.stdout;
    stdout.write([
      'Dados de demonstração criados no banco local.',
      '',
      `Agência: ${MAIN_AGENCY.name} — ${environment.appPublicUrl}/agencia/${mainAgencyId}`,
      `Agência: ${SECOND_AGENCY.name} — ${environment.appPublicUrl}/agencia/${secondAgencyId}`,
      `Portal: ${portalClient.name} — ${environment.appPublicUrl}/portal/${portalClientId}`,
      '',
      formatProfiles(profiles),
      '',
      'Convites de colaborador pendentes (sem conta, ainda não aceitos):',
      ...pendingInvitationEmails.map((email) => `  ${email}`),
      '',
      'As senhas foram geradas agora e só existem nesta saída; rodar de novo gera outras.',
      ''
    ].join('\n'));

    return result;
  } finally {
    await database.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
  }
};

const roleName = (roleKey: string): string => {
  const names: Record<string, string> = {
    admin: 'Admin',
    account_manager: 'Gestor de conta',
    production: 'Produção',
    sales: 'Vendas',
    finance: 'Financeiro'
  };
  return names[roleKey] ?? roleKey;
};

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void runSeedDemo({ env: process.env, argv: process.argv.slice(2) }).then(
    () => { process.exitCode = 0; },
    (error: unknown) => {
      // Local-only command: the operator's own database errors are worth showing; the guard above
      // already refused anything that is not a loopback database.
      const message = error instanceof SeedDemoError
        ? error.message
        : error instanceof Error ? `Demo seed failed: ${error.message}` : 'Demo seed failed.';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  );
}
