import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issue #258: the story scripts of a client, on the agency and on the portal. Every permission is held alone by a
// custom role, because the Owner and the Admin pass every guard and hide one written with the wrong key; the portal
// is probed with every kind of person who can reach it: a person with only a client link (`portalOne`), a collaborator
// whose role reads drafts and has a client link (`dual`), one whose role holds no Conteúdo key (`dualBare`) and an
// Admin of another agency with a link here (`crossDual`). Every refusal is checked by the state left in the database,
// because RLS answers an empty result and the route answers a status, and every race is two real transactions
// sequenced by a lock, never by a sleep.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const cMain = randomUUID();
const cOther = randomUUID();
const cArchived = randomUUID();
const cCap = randomUUID();
const cB = randomUUID();

const userIds: string[] = [];
const roleIds: string[] = [];
const extraClientIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const names: Record<string, string> = {};
const cookies: Record<string, string> = {};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const cookieOf = (response: { cookies: readonly { name: string; value: string }[] }): string =>
  response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, as?: string, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, ...(as === undefined ? {} : { cookie: cookies[as]! }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const agencyScripts = (agency: string, client: string): string => `/agencies/${agency}/clients/${client}/story-scripts`;
const agencyScript = (agency: string, client: string, script: string): string => `${agencyScripts(agency, client)}/${script}`;
const portalScripts = (client: string): string => `/clients/${client}/story-scripts`;
const recordedUrl = (client: string, script: string): string => `${portalScripts(client)}/${script}/recorded`;

const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|40001|42501|pg_|relation|process/i;

interface Seeded {
  readonly id: string;
  readonly sceneIds: string[];
}

const seedScript = async (
  clientId: string,
  extra: {
    scriptOn?: string;
    status?: 'draft' | 'sent' | 'recorded';
    scenes?: ReadonlyArray<readonly [string, string | null]>;
    recordedBy?: string;
    /** Writes the last scene first, so the order the rows were stored in is not the order of their positions. */
    insertLastSceneFirst?: boolean;
  } = {}
): Promise<Seeded> => {
  const id = randomUUID();
  const status = extra.status ?? 'draft';
  await owner.knex('story_scripts').insert({
    id,
    client_id: clientId,
    script_on: extra.scriptOn ?? '2026-10-20',
    status,
    ...(status === 'recorded' ? { recorded_by: extra.recordedBy ?? users.portalOne!.id, recorded_at: new Date('2026-10-19T15:00:00Z') } : {})
  });
  const scenes = extra.scenes ?? [['Cena um', 'Orientação um'], ['Cena dois', null]];
  const sceneIds: string[] = scenes.map(() => randomUUID());
  const order = scenes.map((_, index) => index);
  if (extra.insertLastSceneFirst === true) order.reverse();
  for (const index of order) {
    const [text, guidance] = scenes[index]!;
    await owner.knex('story_script_scenes').insert({ id: sceneIds[index], script_id: id, client_id: clientId, position: index + 1, text, guidance });
  }
  return { id, sceneIds };
};

const stateOf = async (scriptId: string) => {
  const script = await owner.knex('story_scripts').where({ id: scriptId }).first('script_on', 'status', 'recorded_by');
  const scenes = await owner.knex('story_script_scenes').where({ script_id: scriptId }).orderBy('position').select('id', 'position', 'text', 'guidance');
  return {
    scriptOn: script === undefined ? undefined : new Date(script.script_on).toISOString().slice(0, 10),
    status: script?.status as string | undefined,
    recordedBy: script?.recorded_by as string | null | undefined,
    scenes
  };
};

const scriptCount = async (clientId: string): Promise<number> =>
  Number((await owner.knex('story_scripts').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count);

const sceneCount = async (clientId: string): Promise<number> =>
  Number((await owner.knex('story_script_scenes').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count);

const waitUntilSomeoneWaitsOnALock = async (waiters = 1): Promise<void> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await owner.knex.raw<{ rows: Array<{ count: string }> }>(
      "select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'"
    );
    if (Number(waiting.rows[0]?.count) >= waiters) return;
    if (Date.now() > deadline) throw new Error(`Fewer than ${waiters} requests ever queued behind the lock.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * The two windows of the race with the archive of a client. `in-progress`: the archive has changed the client and
 * not committed, so the request passes the policy on a snapshot where it is still active and waits on the AFTER
 * INSERT lock of the client's children (#284), which raises A0020. `committed-before-statement`: the archive commits
 * after the route has read the client as open and before the statement that writes starts, so the policy of that
 * statement refuses (42501); the table is locked by the archive's own transaction, which holds the request in front
 * of the statement and releases it together with the commit.
 */
type ArchiveWindow = 'in-progress' | { readonly committedBeforeStatement: 'story_scripts' | 'story_script_scenes' };

const duringArchiveOfAFreshClient = async <TPrepared>(
  window: ArchiveWindow,
  prepare: (clientId: string) => Promise<TPrepared>,
  request: (clientId: string, prepared: TPrepared) => Promise<Reply>
): Promise<{ clientId: string; prepared: TPrepared; reply: Reply }> => {
  const clientId = randomUUID();
  extraClientIds.push(clientId);
  await owner.knex('clients').insert({ id: clientId, agency_id: agencyA, name: `Cliente em arquivamento ${clientId}` });
  const prepared = await prepare(clientId);
  const archiving = await owner.knex.transaction();
  let pending: Promise<Reply> | undefined;
  try {
    if (window !== 'in-progress') await archiving.raw(`lock table public.${window.committedBeforeStatement} in access exclusive mode`);
    await archiving('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
    pending = request(clientId, prepared);
    await waitUntilSomeoneWaitsOnALock();
  } finally {
    await archiving.commit();
  }
  return { clientId, prepared, reply: await pending! };
};

const expectClientArchived = (reply: Reply): void => {
  expect(reply.statusCode).toBe(409);
  expect(reply.json().error).toEqual({ code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
  expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
};

const expectNotFound = (reply: Reply, message: string): void => {
  expect(reply.statusCode).toBe(404);
  expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message });
};

/** A trigger of the test plays the failure the database may raise inside a statement of the route. */
const withFailing = async (event: 'insert' | 'update', condition: string, errcode: string, run: () => Promise<void>): Promise<void> => {
  const name = `zz_fail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await owner.knex.raw(`
    create function public.${name}() returns trigger language plpgsql as $$
    begin
      if ${condition} then raise exception 'injected failure' using errcode = '${errcode}'; end if;
      return new;
    end $$;
    create trigger ${name} before ${event} on public.story_scripts for each row execute function public.${name}();
  `);
  try {
    await run();
  } finally {
    await owner.knex.raw(`drop trigger if exists ${name} on public.story_scripts; drop function if exists public.${name}();`);
  }
};

const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp();

  const people: ReadonlyArray<readonly [string, string]> = [
    ['owner', 'Dona da Agência'], ['ownerB', 'Dono da Outra'], ['opVis', 'Operadora Completa'], ['onlyOperar', 'Só Opera'],
    ['onlyVisualizar', 'Só Visualiza'], ['sales', 'Vera Vendas'], ['dual', 'Duda Dupla'], ['dualBare', 'Eva Dupla Sem Papel'],
    ['crossDual', 'Admin da Outra com Vínculo'], ['portalOne', 'Pessoa Um'], ['portalTwo', 'Pessoa Dois'], ['portalOther', 'Pessoa do Outro Cliente'],
    ['portalB', 'Pessoa da Outra Agência'], ['portalRemoved', 'Pessoa Removida'], ['portalArchived', 'Pessoa do Arquivado'],
    ['finance', 'Fábio Financeiro'], ['twoAgencies', 'Leitora de Duas Agências']
  ];
  for (const [key, name] of people) {
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: `scripts-${key.toLowerCase()}`, name });
    userIds.push(user.id);
    users[key] = user;
    names[key] = name;
  }

  await owner.knex('agencies').insert([
    { id: agencyA, name: `Roteiros A ${agencyA}`, owner_user_id: users.owner!.id },
    { id: agencyB, name: `Roteiros B ${agencyB}`, owner_user_id: users.ownerB!.id }
  ]);
  await owner.knex('clients').insert([
    { id: cMain, agency_id: agencyA, name: `Cliente Principal ${cMain}` },
    { id: cOther, agency_id: agencyA, name: `Cliente Vizinho ${cOther}` },
    { id: cArchived, agency_id: agencyA, name: `Cliente Arquivado ${cArchived}` },
    { id: cCap, agency_id: agencyA, name: `Cliente do Teto ${cCap}` },
    { id: cB, agency_id: agencyB, name: `Cliente B ${cB}` }
  ]);
  await owner.knex('clients').where({ id: cArchived }).update({ status: 'archived', archived_at: new Date() });

  const customRole = async (agencyId: string, ...permissions: string[]): Promise<string> => {
    const id = randomUUID();
    roleIds.push(id);
    await owner.knex('roles').insert({ id, agency_id: agencyId, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
    await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
    return id;
  };
  const system = async (key: string): Promise<string> => (await owner.knex('roles').whereNull('agency_id').where({ key }).first('id')).id as string;

  await owner.knex('agency_memberships').insert([
    { agency_id: agencyA, user_id: users.opVis!.id, role_id: await customRole(agencyA, 'conteudo.operar', 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.onlyOperar!.id, role_id: await customRole(agencyA, 'conteudo.operar') },
    { agency_id: agencyA, user_id: users.onlyVisualizar!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.sales!.id, role_id: await system('sales') },
    { agency_id: agencyA, user_id: users.finance!.id, role_id: await system('finance') },
    // Reads Conteúdo in BOTH agencies: the policy shows this person the rows of either, so only the route tells them apart.
    { agency_id: agencyA, user_id: users.twoAgencies!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyB, user_id: users.twoAgencies!.id, role_id: await customRole(agencyB, 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.dual!.id, role_id: await system('production') },
    { agency_id: agencyA, user_id: users.dualBare!.id, role_id: await customRole(agencyA, 'midia.enviar') },
    { agency_id: agencyB, user_id: users.crossDual!.id, role_id: await system('admin') }
  ]);
  // `portalRemoved` and `portalArchived` hold a second, active link so they can sign in at all.
  await owner.knex('client_memberships').insert([
    ...[users.dual, users.dualBare, users.crossDual, users.portalOne, users.portalTwo].map((user) => ({ client_id: cMain, user_id: user!.id })),
    { client_id: cMain, user_id: users.portalRemoved!.id, status: 'removed' },
    { client_id: cOther, user_id: users.portalRemoved!.id },
    { client_id: cOther, user_id: users.portalOther!.id },
    { client_id: cArchived, user_id: users.portalArchived!.id },
    { client_id: cOther, user_id: users.portalArchived!.id },
    { client_id: cCap, user_id: users.portalOne!.id },
    { client_id: cB, user_id: users.portalB!.id }
  ]);

  for (const key of Object.keys(users)) {
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users[key]!.email, password: users[key]!.password } });
    expect(response.statusCode, key).toBe(200);
    cookies[key] = cookieOf(response);
  }
});

afterAll(async () => {
  const agencies = [agencyA, agencyB];
  const clients = [cMain, cOther, cArchived, cCap, cB, ...extraClientIds];
  await owner.knex('story_script_scenes').whereIn('client_id', clients).delete();
  await owner.knex('story_scripts').whereIn('client_id', clients).delete();
  await owner.knex('client_memberships').whereIn('client_id', clients).delete();
  await owner.knex('agency_memberships').whereIn('agency_id', agencies).delete();
  await owner.knex('clients').whereIn('id', clients).delete();
  await owner.knex('role_permissions').whereIn('role_id', roleIds).delete();
  await owner.knex('roles').whereIn('id', roleIds).delete();
  await owner.knex('audit.events').whereIn('agency_id', agencies).delete();
  await owner.knex('agencies').whereIn('id', agencies).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', agencies).delete();
  await owner.knex('auth.user').whereIn('id', userIds).delete();
  await app.close();
  await owner.close();
});

describe('creating a story script (issue #258)', () => {
  it('creates a draft with its scenes in the order they came, and reads it back', async () => {
    const reply = await call('POST', agencyScripts(agencyA, cMain), 'opVis', {
      scriptOn: '2026-10-20',
      scenes: [{ text: '  Abrir a loja  ', guidance: 'Filmar na vertical' }, { text: 'Contar a promoção' }, { text: 'Pedir para seguir', guidance: '   ' }]
    });

    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toEqual({
      id: expect.any(String),
      scriptOn: '2026-10-20',
      status: 'draft',
      scenes: [
        { id: expect.any(String), position: 1, text: 'Abrir a loja', guidance: 'Filmar na vertical' },
        { id: expect.any(String), position: 2, text: 'Contar a promoção', guidance: null },
        { id: expect.any(String), position: 3, text: 'Pedir para seguir', guidance: null }
      ],
      recordedBy: null,
      recordedAt: null,
      createdAt: expect.any(String)
    });
    const stored = await stateOf(reply.json().id);
    expect(stored).toMatchObject({ scriptOn: '2026-10-20', status: 'draft', recordedBy: null });
    expect(stored.scenes.map((scene) => [scene.position, scene.text, scene.guidance])).toEqual([[1, 'Abrir a loja', 'Filmar na vertical'], [2, 'Contar a promoção', null], [3, 'Pedir para seguir', null]]);
    expect((await owner.knex('story_scripts').where({ id: reply.json().id }).first('client_id')).client_id).toBe(cMain);
  });

  it('takes a script with no scene, and a second script on the same day', async () => {
    const first = await call('POST', agencyScripts(agencyA, cMain), 'opVis', { scriptOn: '2026-10-22' });
    const second = await call('POST', agencyScripts(agencyA, cMain), 'opVis', { scriptOn: '2026-10-22', scenes: [{ text: 'Outra' }] });

    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json().scenes).toEqual([]);
    expect(first.json().id).not.toBe(second.json().id);
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone, or neither, is a 403 and writes nothing', async () => {
    const before = [await scriptCount(cMain), await sceneCount(cMain)];

    for (const as of ['onlyOperar', 'onlyVisualizar', 'sales', 'dualBare']) {
      const reply = await call('POST', agencyScripts(agencyA, cMain), as, { scriptOn: '2026-10-20', scenes: [{ text: 'Sem permissão' }] });
      expect({ as, status: reply.statusCode, code: reply.json().error.code }).toEqual({ as, status: 403, code: 'FORBIDDEN' });
    }
    expect([await scriptCount(cMain), await sceneCount(cMain)]).toEqual(before);
  });

  it('lets the Owner without a role create one, and answers a person of the portal as a stranger to the agency', async () => {
    expect((await call('POST', agencyScripts(agencyA, cMain), 'owner', { scriptOn: '2026-10-23' })).statusCode).toBe(201);

    const before = await scriptCount(cMain);
    for (const as of ['portalOne', 'crossDual', 'ownerB']) {
      expectNotFound(await call('POST', agencyScripts(agencyA, cMain), as, { scriptOn: '2026-10-23' }), 'Agency not found.');
    }
    expect((await call('POST', agencyScripts(agencyA, cMain), undefined, { scriptOn: '2026-10-23' })).statusCode).toBe(401);
    expect(await scriptCount(cMain)).toBe(before);
  });

  it('refuses what the schema refuses, and writes nothing', async () => {
    const before = [await scriptCount(cMain), await sceneCount(cMain)];
    const bodies: Array<[string, unknown]> = [
      ['zero-width space in the text', { scriptOn: '2026-10-20', scenes: [{ text: `Abrir ${text(0x200b)}a loja` }] }],
      ['joiner in the guidance', { scriptOn: '2026-10-20', scenes: [{ text: 'Abrir', guidance: `Filmar${text(0x200d)}bem` }] }],
      ['control character in the text', { scriptOn: '2026-10-20', scenes: [{ text: `Abrir${text(0x0007)}` }] }],
      ['combining grapheme joiner in the text', { scriptOn: '2026-10-20', scenes: [{ text: `Ca${text(0x034f)}fé` }] }],
      ['31 scenes', { scriptOn: '2026-10-20', scenes: Array.from({ length: 31 }, (_, index) => ({ text: `Cena ${index}` })) }],
      ['blank text', { scriptOn: '2026-10-20', scenes: [{ text: '   ' }] }],
      ['an unreal day', { scriptOn: '2026-02-30', scenes: [] }],
      ['no day', { scenes: [] }],
      ['a status in the body', { scriptOn: '2026-10-20', status: 'sent' }],
      ['a client in the body', { scriptOn: '2026-10-20', clientId: cOther }],
      ['a position in a scene', { scriptOn: '2026-10-20', scenes: [{ text: 'Abrir', position: 2 }] }]
    ];

    for (const [label, body] of bodies) {
      const reply = await call('POST', agencyScripts(agencyA, cMain), 'opVis', body);
      expect({ label, status: reply.statusCode }).toEqual({ label, status: 400 });
    }
    expect([await scriptCount(cMain), await sceneCount(cMain)]).toEqual(before);
  });

  it('answers the same 404 for a client of another agency, an absent one and a malformed id', async () => {
    const before = await scriptCount(cB);

    for (const clientId of [cB, randomUUID(), 'not-a-uuid']) {
      expectNotFound(await call('POST', agencyScripts(agencyA, clientId), 'opVis', { scriptOn: '2026-10-20' }), 'Client not found.');
    }
    expect(await scriptCount(cB)).toBe(before);
  });

  it('refuses an archived client with 409 and writes nothing', async () => {
    const before = await scriptCount(cArchived);

    expectClientArchived(await call('POST', agencyScripts(agencyA, cArchived), 'opVis', { scriptOn: '2026-10-20', scenes: [{ text: 'Tarde' }] }));
    expect(await scriptCount(cArchived)).toBe(before);
  });

  it.each([
    ['the archive is still running (A0020 of the trigger)', 'in-progress'],
    ['the archive committed before the INSERT (42501 of the policy)', { committedBeforeStatement: 'story_scripts' }]
  ] as const)('is a 409 CLIENT_ARCHIVED, with no script or scene left behind, when %s', async (_label, window) => {
    const { clientId, reply } = await duringArchiveOfAFreshClient(window, async () => undefined, (id) =>
      call('POST', agencyScripts(agencyA, id), 'opVis', { scriptOn: '2026-10-20', scenes: [{ text: 'Chegou tarde' }] }));

    expectClientArchived(reply);
    expect([await scriptCount(clientId), await sceneCount(clientId)]).toEqual([0, 0]);
  });

  it.each([['40P01', 409, 'TRY_AGAIN'], ['40001', 409, 'TRY_AGAIN'], ['A0020', 409, 'CLIENT_ARCHIVED'], ['XX000', 500, 'INTERNAL_ERROR']] as const)(
    'answers the failure %s of the INSERT as %i %s, leaves nothing and works when repeated',
    async (errcode, status, code) => {
      const before = [await scriptCount(cMain), await sceneCount(cMain)];

      await withFailing('insert', `new.client_id = '${cMain}'::uuid and new.script_on = '2026-11-02'`, errcode, async () => {
        const failed = await call('POST', agencyScripts(agencyA, cMain), 'opVis', { scriptOn: '2026-11-02', scenes: [{ text: 'Falha injetada' }] });
        expect({ status: failed.statusCode, code: failed.json().error.code }).toEqual({ status, code });
        expect(JSON.stringify(failed.json())).not.toMatch(NO_DATABASE_DETAIL);
      });

      expect([await scriptCount(cMain), await sceneCount(cMain)]).toEqual(before);
      expect((await call('POST', agencyScripts(agencyA, cMain), 'opVis', { scriptOn: '2026-11-02' })).statusCode).toBe(201);
    }
  );
});

describe('editing a story script (issue #258)', () => {
  it('changes the day alone', async () => {
    const script = await seedScript(cMain);

    const reply = await call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', { scriptOn: '2026-11-05' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ id: script.id, scriptOn: '2026-11-05', status: 'draft' });
    expect(reply.json().scenes.map((scene: { id: string }) => scene.id)).toEqual(script.sceneIds);
    expect(await stateOf(script.id)).toMatchObject({ scriptOn: '2026-11-05', status: 'draft' });
  });

  it('rewrites the scenes: the text, the guidance, the order (a swap in one statement) and a new scene at the end', async () => {
    const script = await seedScript(cMain, { scenes: [['Primeira', 'Guia 1'], ['Segunda', null]] });
    const [first, second] = script.sceneIds as [string, string];

    const reply = await call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', {
      scenes: [{ id: second, text: '  Segunda, agora primeira  ', guidance: 'Guia nova' }, { id: first, text: 'Primeira, agora segunda', guidance: null }, { text: 'Terceira, nova' }]
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().scenes).toEqual([
      { id: second, position: 1, text: 'Segunda, agora primeira', guidance: 'Guia nova' },
      { id: first, position: 2, text: 'Primeira, agora segunda', guidance: null },
      { id: expect.any(String), position: 3, text: 'Terceira, nova', guidance: null }
    ]);
    expect((await stateOf(script.id)).scenes.map((scene) => [scene.position, scene.text, scene.guidance])).toEqual([
      [1, 'Segunda, agora primeira', 'Guia nova'], [2, 'Primeira, agora segunda', null], [3, 'Terceira, nova', null]
    ]);
  });

  it('changes the day and the scenes in one edit, or none of them', async () => {
    const script = await seedScript(cMain, { scriptOn: '2026-11-10', scenes: [['Única', null]] });

    const refused = await call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', { scriptOn: '2026-11-11', scenes: [{ text: 'Esqueci a antiga' }] });
    expect(refused.statusCode).toBe(409);
    expect(await stateOf(script.id)).toMatchObject({ scriptOn: '2026-11-10' });
    expect((await stateOf(script.id)).scenes.map((scene) => scene.text)).toEqual(['Única']);

    const accepted = await call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', { scriptOn: '2026-11-11', scenes: [{ id: script.sceneIds[0], text: 'Única' }, { text: 'Mais uma' }] });
    expect(accepted.statusCode).toBe(200);
    expect(await stateOf(script.id)).toMatchObject({ scriptOn: '2026-11-11' });
    expect((await stateOf(script.id)).scenes.map((scene) => scene.text)).toEqual(['Única', 'Mais uma']);
  });

  it('answers 409 STORY_SCENES_MISMATCH, and changes nothing, for a list that drops a scene, names one that is not the script\'s or names one twice', async () => {
    const script = await seedScript(cMain, { scenes: [['A', null], ['B', null]] });
    const foreign = await seedScript(cMain, { scenes: [['De outro roteiro', null]] });
    const [a, b] = script.sceneIds as [string, string];
    const before = await stateOf(script.id);

    for (const [label, scenes] of [
      ['drops B', [{ id: a, text: 'A' }]],
      ['empties the script', []],
      ['names a scene of another script', [{ id: a, text: 'A' }, { id: b, text: 'B' }, { id: foreign.sceneIds[0], text: 'Intrusa' }]],
      ['names an id that does not exist', [{ id: a, text: 'A' }, { id: b, text: 'B' }, { id: randomUUID(), text: 'Fantasma' }]]
    ] as const) {
      const reply = await call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', { scenes });
      expect({ label, status: reply.statusCode, code: reply.json().error.code }).toEqual({ label, status: 409, code: 'STORY_SCENES_MISMATCH' });
    }
    expect(await stateOf(script.id)).toEqual(before);
    expect((await stateOf(foreign.id)).scenes.map((scene) => scene.text)).toEqual(['De outro roteiro']);
    expect((await call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', { scenes: [{ id: a, text: 'A' }, { id: a, text: 'A de novo' }, { id: b, text: 'B' }] })).statusCode).toBe(400);
  });

  it('never edits a script that was sent or recorded: 409 STORY_SCRIPT_STATE, the day, the scenes and the state stay', async () => {
    for (const status of ['sent', 'recorded'] as const) {
      const script = await seedScript(cMain, { status, scenes: [['Fechada', null]] });
      const before = await stateOf(script.id);

      for (const body of [{ scriptOn: '2026-12-01' }, { scriptOn: before.scriptOn }, { scenes: [{ id: script.sceneIds[0], text: 'Mudei' }] }, { scenes: [{ id: script.sceneIds[0], text: 'Fechada' }, { text: 'Nova' }] }]) {
        const reply = await call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', body);
        expect({ status, body, http: reply.statusCode, code: reply.json().error.code }).toEqual({ status, body, http: 409, code: 'STORY_SCRIPT_STATE' });
      }
      expect(await stateOf(script.id)).toEqual(before);
    }
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone, or neither, is a 403 and changes nothing', async () => {
    const script = await seedScript(cMain);
    const before = await stateOf(script.id);

    for (const as of ['onlyOperar', 'onlyVisualizar', 'sales', 'dualBare']) {
      const reply = await call('PATCH', agencyScript(agencyA, cMain, script.id), as, { scriptOn: '2026-12-24', scenes: [] });
      expect({ as, status: reply.statusCode }).toEqual({ as, status: 403 });
    }
    expect(await stateOf(script.id)).toEqual(before);
    expect((await call('PATCH', agencyScript(agencyA, cMain, script.id), 'owner', { scriptOn: '2026-12-24' })).statusCode).toBe(200);
    expect((await call('PATCH', agencyScript(agencyA, cMain, script.id), 'dual', { scriptOn: '2026-12-25' })).statusCode).toBe(200);
    expectNotFound(await call('PATCH', agencyScript(agencyA, cMain, script.id), 'portalOne', { scriptOn: '2026-12-26' }), 'Agency not found.');
    expect((await stateOf(script.id)).scriptOn).toBe('2026-12-25');
  });

  it('answers the same 404 for a script of another client, of another agency, absent or malformed', async () => {
    const ofOther = await seedScript(cOther);
    const ofB = await seedScript(cB);
    const mine = await seedScript(cMain);
    const before = [await stateOf(ofOther.id), await stateOf(ofB.id)];

    for (const url of [
      agencyScript(agencyA, cMain, ofOther.id), agencyScript(agencyA, cMain, ofB.id), agencyScript(agencyA, cB, ofB.id),
      agencyScript(agencyA, cMain, randomUUID()), agencyScript(agencyA, cMain, 'not-a-uuid')
    ]) {
      const reply = await call('PATCH', url, 'opVis', { scriptOn: '2027-01-01' });
      expect({ url, status: reply.statusCode }).toEqual({ url, status: 404 });
    }
    expectNotFound(await call('PATCH', agencyScript(agencyA, cMain, ofOther.id), 'opVis', { scriptOn: '2027-01-01' }), 'Story script not found.');
    expectNotFound(await call('PATCH', agencyScript(agencyA, cB, mine.id), 'opVis', { scriptOn: '2027-01-01' }), 'Client not found.');
    expect([await stateOf(ofOther.id), await stateOf(ofB.id)]).toEqual(before);
  });

  it('refuses a script of an archived client with 409 and changes nothing', async () => {
    const script = await seedScript(cArchived);
    const before = await stateOf(script.id);

    expectClientArchived(await call('PATCH', agencyScript(agencyA, cArchived, script.id), 'opVis', { scriptOn: '2027-01-02' }));
    expectClientArchived(await call('PATCH', agencyScript(agencyA, cArchived, script.id), 'opVis', { scenes: [{ id: script.sceneIds[0], text: 'Tarde' }, { id: script.sceneIds[1], text: 'Cena dois' }] }));
    expect(await stateOf(script.id)).toEqual(before);
  });

  it('is a 409 CLIENT_ARCHIVED, and the script stays as it was, when the archive wins the race for a new scene (A0020 of the trigger)', async () => {
    const { prepared, reply } = await duringArchiveOfAFreshClient('in-progress', async (clientId) => seedScript(clientId, { scenes: [['Antiga', null]] }), (clientId, script) =>
      call('PATCH', agencyScript(agencyA, clientId, script.id), 'opVis', { scenes: [{ id: script.sceneIds[0], text: 'Antiga' }, { text: 'Nova' }] }));

    expectClientArchived(reply);
    expect((await stateOf(prepared.id)).scenes.map((scene) => scene.text)).toEqual(['Antiga']);
  });

  it.each([
    ['rewriting a scene', [['Antiga', null]], (script: Seeded) => ({ scenes: [{ id: script.sceneIds[0], text: 'Reescrita tarde' }] }), ['Antiga']],
    ['adding a scene to a script that has none', [], () => ({ scenes: [{ text: 'Nova tarde' }] }), []]
  ] as const)('is a 409 CLIENT_ARCHIVED, and the script stays as it was, when the archive committed before the statement that writes (42501 of the policy), %s', async (_label, scenes, bodyOf, remaining) => {
    const { prepared, reply } = await duringArchiveOfAFreshClient({ committedBeforeStatement: 'story_script_scenes' }, async (clientId) => seedScript(clientId, { scenes }), (clientId, script) =>
      call('PATCH', agencyScript(agencyA, clientId, script.id), 'opVis', bodyOf(script)));

    expectClientArchived(reply);
    expect((await stateOf(prepared.id)).scenes.map((scene) => scene.text)).toEqual(remaining);
  });

  it('is a 409 CLIENT_ARCHIVED when the archive committed while the edit waited for the lock of the script', async () => {
    const { prepared, reply } = await duringArchiveOfAFreshClient({ committedBeforeStatement: 'story_scripts' }, async (clientId) => seedScript(clientId), (clientId, script) =>
      call('PATCH', agencyScript(agencyA, clientId, script.id), 'opVis', { scriptOn: '2027-02-02' }));

    expectClientArchived(reply);
    expect((await stateOf(prepared.id)).scriptOn).toBe('2026-10-20');
  });

  it('serializes with the send: the edit that waits behind a send finds the script sent, and adds no scene', async () => {
    const script = await seedScript(cMain, { scenes: [['Antes do envio', null]] });
    const holder = await owner.knex.transaction();
    let released = false;
    try {
      expect(await holder('story_scripts').where({ id: script.id }).forUpdate().select('id')).toHaveLength(1);
      const send = call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, 'opVis');
      await waitUntilSomeoneWaitsOnALock(1);
      const edit = call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', { scenes: [{ id: script.sceneIds[0], text: 'Antes do envio' }, { text: 'Depois do envio' }] });
      await waitUntilSomeoneWaitsOnALock(2);
      await holder.commit();
      released = true;

      const [sent, edited] = [await send, await edit];
      expect(sent.statusCode).toBe(200);
      expect(sent.json().status).toBe('sent');
      expect({ status: edited.statusCode, code: edited.json().error.code }).toEqual({ status: 409, code: 'STORY_SCRIPT_STATE' });
    } finally {
      if (!released) await holder.rollback();
    }
    expect(await stateOf(script.id)).toMatchObject({ status: 'sent' });
    expect((await stateOf(script.id)).scenes.map((scene) => scene.text)).toEqual(['Antes do envio']);
  });

  it('serializes with the send: an edit that changes nothing, behind a send, is still refused as an edit of a sent script', async () => {
    const script = await seedScript(cMain, { scriptOn: '2026-11-30' });
    const holder = await owner.knex.transaction();
    let released = false;
    try {
      expect(await holder('story_scripts').where({ id: script.id }).forUpdate().select('id')).toHaveLength(1);
      const send = call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, 'opVis');
      await waitUntilSomeoneWaitsOnALock(1);
      const edit = call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', { scriptOn: '2026-11-30' });
      await waitUntilSomeoneWaitsOnALock(2);
      await holder.commit();
      released = true;

      expect((await send).statusCode).toBe(200);
      const edited = await edit;
      expect({ status: edited.statusCode, code: edited.json().error?.code }).toEqual({ status: 409, code: 'STORY_SCRIPT_STATE' });
    } finally {
      if (!released) await holder.rollback();
    }
  });

  it.each([['40P01', 409, 'TRY_AGAIN'], ['40001', 409, 'TRY_AGAIN'], ['A0020', 409, 'CLIENT_ARCHIVED'], ['A0050', 404, 'NOT_FOUND'], ['A0052', 409, 'STORY_SCRIPT_STATE'], ['XX000', 500, 'INTERNAL_ERROR']] as const)(
    'answers the failure %s of the UPDATE as %i %s, changes nothing, and works when repeated',
    async (errcode, status, code) => {
      const script = await seedScript(cMain, { scriptOn: '2026-11-20' });
      const before = await stateOf(script.id);

      await withFailing('update', `new.id = '${script.id}'::uuid`, errcode, async () => {
        const failed = await call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', { scriptOn: '2026-11-21' });
        expect({ status: failed.statusCode, code: failed.json().error.code }).toEqual({ status, code });
        expect(JSON.stringify(failed.json())).not.toMatch(NO_DATABASE_DETAIL);
      });

      expect(await stateOf(script.id)).toEqual(before);
      expect((await call('PATCH', agencyScript(agencyA, cMain, script.id), 'opVis', { scriptOn: '2026-11-21' })).statusCode).toBe(200);
    }
  );
});

describe('sending a story script (issue #258)', () => {
  it('sends a draft, and repeating the send is not an error and changes nothing', async () => {
    const script = await seedScript(cMain);

    const sent = await call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, 'opVis');

    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({
      id: script.id,
      scriptOn: '2026-10-20',
      status: 'sent',
      scenes: [
        { id: script.sceneIds[0], position: 1, text: 'Cena um', guidance: 'Orientação um' },
        { id: script.sceneIds[1], position: 2, text: 'Cena dois', guidance: null }
      ],
      recordedBy: null,
      recordedAt: null,
      createdAt: expect.any(String)
    });
    expect(await stateOf(script.id)).toMatchObject({ status: 'sent', recordedBy: null });

    const again = await call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, 'dual');
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('sent');
  });

  it('refuses a recorded script with 409 STORY_SCRIPT_STATE and leaves it recorded', async () => {
    const script = await seedScript(cMain, { status: 'recorded' });

    const reply = await call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, 'opVis');

    expect({ status: reply.statusCode, code: reply.json().error.code }).toEqual({ status: 409, code: 'STORY_SCRIPT_STATE' });
    expect(await stateOf(script.id)).toMatchObject({ status: 'recorded', recordedBy: users.portalOne!.id });
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone, or neither, is a 403 and the script stays a draft', async () => {
    const script = await seedScript(cMain);

    for (const as of ['onlyOperar', 'onlyVisualizar', 'sales', 'dualBare']) {
      expect({ as, status: (await call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, as)).statusCode }).toEqual({ as, status: 403 });
    }
    // A person who only has a link with the client never sends: the agency does not know them.
    for (const as of ['portalOne', 'crossDual']) expectNotFound(await call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, as), 'Agency not found.');
    expect((await call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`)).statusCode).toBe(401);
    expect((await stateOf(script.id)).status).toBe('draft');
    expect((await call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, 'owner')).statusCode).toBe(200);
  });

  it('answers the same 404 for a script of another client, of another agency, absent or malformed', async () => {
    const ofOther = await seedScript(cOther);
    const ofB = await seedScript(cB);

    for (const url of [
      agencyScript(agencyA, cMain, ofOther.id), agencyScript(agencyA, cMain, ofB.id), agencyScript(agencyA, cB, ofB.id),
      agencyScript(agencyA, cMain, randomUUID()), agencyScript(agencyA, cMain, 'not-a-uuid')
    ]) {
      const reply = await call('POST', `${url}/send`, 'opVis');
      expect({ url, status: reply.statusCode }).toEqual({ url, status: 404 });
    }
    expectNotFound(await call('POST', `${agencyScript(agencyA, cMain, ofOther.id)}/send`, 'opVis'), 'Story script not found.');
    expectNotFound(await call('POST', `${agencyScript(agencyA, cB, ofB.id)}/send`, 'opVis'), 'Client not found.');
    expect([(await stateOf(ofOther.id)).status, (await stateOf(ofB.id)).status]).toEqual(['draft', 'draft']);
  });

  it('refuses a draft of an archived client with 409 and leaves it a draft', async () => {
    const script = await seedScript(cArchived);

    expectClientArchived(await call('POST', `${agencyScript(agencyA, cArchived, script.id)}/send`, 'opVis'));
    expect((await stateOf(script.id)).status).toBe('draft');
  });

  it('is a 409 CLIENT_ARCHIVED, and the script stays a draft, when the archive committed before the send', async () => {
    const { prepared, reply } = await duringArchiveOfAFreshClient({ committedBeforeStatement: 'story_scripts' }, async (clientId) => seedScript(clientId), (clientId, script) =>
      call('POST', `${agencyScript(agencyA, clientId, script.id)}/send`, 'opVis'));

    expectClientArchived(reply);
    expect((await stateOf(prepared.id)).status).toBe('draft');
  });

  it.each([['40P01', 409, 'TRY_AGAIN'], ['40001', 409, 'TRY_AGAIN'], ['A0020', 409, 'CLIENT_ARCHIVED'], ['A0052', 409, 'STORY_SCRIPT_STATE'], ['XX000', 500, 'INTERNAL_ERROR']] as const)(
    'answers the failure %s of the state change as %i %s, leaves the draft and works when repeated',
    async (errcode, status, code) => {
      const script = await seedScript(cMain);

      await withFailing('update', `new.id = '${script.id}'::uuid`, errcode, async () => {
        const failed = await call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, 'opVis');
        expect({ status: failed.statusCode, code: failed.json().error.code }).toEqual({ status, code });
        expect(JSON.stringify(failed.json())).not.toMatch(NO_DATABASE_DETAIL);
      });

      expect((await stateOf(script.id)).status).toBe('draft');
      expect((await call('POST', `${agencyScript(agencyA, cMain, script.id)}/send`, 'opVis')).statusCode).toBe(200);
    }
  );
});

describe('the portal lists the sent scripts of a period (issue #258, format of #254)', () => {
  const period = (from: string, to: string): string => `?from=${from}&to=${to}`;

  it('lists only what was sent or recorded, of this client, inside the period, oldest day first, with scenes in order', async () => {
    const client = randomUUID();
    extraClientIds.push(client);
    await owner.knex('clients').insert({ id: client, agency_id: agencyA, name: `Cliente da listagem ${client}` });
    await owner.knex('client_memberships').insert([{ client_id: client, user_id: users.portalOne!.id }, { client_id: client, user_id: users.portalTwo!.id }]);
    const early = await seedScript(client, { scriptOn: '2026-10-05', status: 'sent', scenes: [['Cedo', 'Guia']] });
    const recorded = await seedScript(client, { scriptOn: '2026-10-12', status: 'recorded', recordedBy: users.portalTwo!.id, scenes: [['Gravada', null], ['Segunda cena', 'Com guia']], insertLastSceneFirst: true });
    const late = await seedScript(client, { scriptOn: '2026-10-31', status: 'sent', scenes: [] });
    await seedScript(client, { scriptOn: '2026-10-15', status: 'draft' });
    await seedScript(client, { scriptOn: '2026-09-30', status: 'sent' });
    await seedScript(client, { scriptOn: '2026-11-01', status: 'sent' });
    await seedScript(cMain, { scriptOn: '2026-10-15', status: 'sent' });
    await seedScript(cB, { scriptOn: '2026-10-15', status: 'sent' });

    const reply = await call('GET', `${portalScripts(client)}${period('2026-10-01', '2026-10-31')}`, 'portalOne');

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({
      data: [
        { id: early.id, scriptOn: '2026-10-05', status: 'sent', scenes: [{ position: 1, text: 'Cedo', guidance: 'Guia' }], recordedBy: null, recordedAt: null },
        {
          id: recorded.id,
          scriptOn: '2026-10-12',
          status: 'recorded',
          scenes: [{ position: 1, text: 'Gravada', guidance: null }, { position: 2, text: 'Segunda cena', guidance: 'Com guia' }],
          recordedBy: { name: names.portalTwo },
          recordedAt: '2026-10-19T15:00:00.000Z'
        },
        { id: late.id, scriptOn: '2026-10-31', status: 'sent', scenes: [], recordedBy: null, recordedAt: null }
      ],
      meta: { from: '2026-10-01', to: '2026-10-31', count: 3 }
    });
  });

  it('includes both ends of the period, and a single day', async () => {
    const client = randomUUID();
    extraClientIds.push(client);
    await owner.knex('clients').insert({ id: client, agency_id: agencyA, name: `Cliente dos extremos ${client}` });
    await owner.knex('client_memberships').insert({ client_id: client, user_id: users.portalOne!.id });
    const first = await seedScript(client, { scriptOn: '2026-10-10', status: 'sent', scenes: [] });
    const last = await seedScript(client, { scriptOn: '2026-10-12', status: 'sent', scenes: [] });

    const both = await call('GET', `${portalScripts(client)}${period('2026-10-10', '2026-10-12')}`, 'portalOne');
    expect(both.json().data.map((item: { id: string }) => item.id)).toEqual([first.id, last.id]);
    expect((await call('GET', `${portalScripts(client)}${period('2026-10-12', '2026-10-12')}`, 'portalOne')).json().data.map((item: { id: string }) => item.id)).toEqual([last.id]);
    expect((await call('GET', `${portalScripts(client)}${period('2026-10-11', '2026-10-11')}`, 'portalOne')).json()).toEqual({ data: [], meta: { from: '2026-10-11', to: '2026-10-11', count: 0 } });
  });

  it('never shows a draft, to anyone, even to a collaborator whose agency role reads drafts', async () => {
    const draft = await seedScript(cMain, { scriptOn: '2026-10-08', status: 'draft' });
    const sent = await seedScript(cMain, { scriptOn: '2026-10-08', status: 'sent' });
    // The agency branch of the policy shows `dual` the draft: this is the case where only the portal's own SQL hides it.
    expect((await call('PATCH', agencyScript(agencyA, cMain, draft.id), 'dual', { scriptOn: '2026-10-08' })).statusCode).toBe(200);

    for (const as of ['portalOne', 'portalTwo', 'dual', 'dualBare', 'crossDual']) {
      const ids = (await call('GET', `${portalScripts(cMain)}${period('2026-10-08', '2026-10-08')}`, as)).json().data.map((item: { id: string }) => item.id);
      expect({ as, ids: ids.includes(draft.id) }).toEqual({ as, ids: false });
      expect({ as, sent: ids.includes(sent.id) }).toEqual({ as, sent: true });
    }
  });

  it('serves every kind of person the portal has, the same list: a link only, a collaborator, one with no Conteúdo role and an Admin of another agency', async () => {
    await seedScript(cMain, { scriptOn: '2026-10-09', status: 'sent', scenes: [['Para todos', null]] });
    const lists = await Promise.all(['portalOne', 'portalTwo', 'dual', 'dualBare', 'crossDual'].map(async (as) => {
      const reply = await call('GET', `${portalScripts(cMain)}${period('2026-10-09', '2026-10-09')}`, as);
      expect({ as, status: reply.statusCode }).toEqual({ as, status: 200 });
      return reply.json().data;
    }));

    expect(lists[0]).toHaveLength(1);
    for (const list of lists) expect(list).toEqual(lists[0]);
  });

  it('shows who recorded by the link, also when the link was removed afterwards', async () => {
    const script = await seedScript(cMain, { scriptOn: '2026-10-07', status: 'recorded', recordedBy: users.portalRemoved!.id, scenes: [] });

    const item = (await call('GET', `${portalScripts(cMain)}${period('2026-10-07', '2026-10-07')}`, 'portalOne')).json().data.find((row: { id: string }) => row.id === script.id);

    expect(item.recordedBy).toEqual({ name: names.portalRemoved });
  });

  it('holds the period to 93 days, both ends included: 93 passes and 94 is a 400', async () => {
    expect((await call('GET', `${portalScripts(cMain)}${period('2026-10-01', '2027-01-01')}`, 'portalOne')).statusCode).toBe(200);
    const tooLong = await call('GET', `${portalScripts(cMain)}${period('2026-10-01', '2027-01-02')}`, 'portalOne');
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.details.issues).toEqual([{ path: 'to', code: 'custom', message: 'the period must span at most 93 days' }]);
  });

  it('refuses a period that runs backwards, an unreal day, a missing end and a stray parameter', async () => {
    for (const query of ['?from=2026-10-02&to=2026-10-01', '?from=2026-02-30&to=2026-03-01', '?from=2026-10-01', '?to=2026-10-01', '', '?from=2026-10-01&to=2026-10-02&page=1', '?from=2026-10-01&to=2026-10-02&clientId=x', '?from=ontem&to=hoje']) {
      const reply = await call('GET', `${portalScripts(cMain)}${query}`, 'portalOne');
      expect({ query, status: reply.statusCode }).toEqual({ query, status: 400 });
    }
  });

  it('holds the answer to 500 items: 500 pass whole, 501 is a 400 and nothing is cut', async () => {
    const rows = (count: number, offset: number) => Array.from({ length: count }, (_, index) => ({ client_id: cCap, script_on: '2026-10-10', status: 'sent', created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, offset + index)) }));
    await owner.knex.batchInsert('story_scripts', rows(500, 0), 250);

    const full = await call('GET', `${portalScripts(cCap)}${period('2026-10-01', '2026-10-31')}`, 'portalOne');
    expect(full.statusCode).toBe(200);
    expect(full.json().data).toHaveLength(500);
    expect(full.json().meta).toEqual({ from: '2026-10-01', to: '2026-10-31', count: 500 });

    await owner.knex.batchInsert('story_scripts', rows(1, 500), 1);
    const over = await call('GET', `${portalScripts(cCap)}${period('2026-10-01', '2026-10-31')}`, 'portalOne');
    expect(over.statusCode).toBe(400);
    expect(over.json().error.details.issues).toEqual([{ path: 'to', code: 'custom', message: 'the period has more than 500 items' }]);
    expect(over.json().data).toBeUndefined();
    expect((await call('GET', `${portalScripts(cCap)}${period('2026-10-11', '2026-10-31')}`, 'portalOne')).json().data).toEqual([]);
  });

  it('answers a stranger to the client the same 404: another client\'s person, a removed link, an archived client, an agency person with no link, another agency', async () => {
    await seedScript(cMain, { scriptOn: '2026-10-06', status: 'sent' });
    await seedScript(cArchived, { scriptOn: '2026-10-06', status: 'sent' });

    for (const [as, client] of [
      ['portalOther', cMain], ['portalRemoved', cMain], ['portalArchived', cArchived], ['sales', cMain], ['opVis', cMain], ['portalB', cMain], ['portalOne', cB], ['portalOne', randomUUID()], ['portalOne', 'not-a-uuid']
    ] as const) {
      const reply = await call('GET', `${portalScripts(client)}${period('2026-10-06', '2026-10-06')}`, as);
      expect({ as, client, status: reply.statusCode, error: reply.json().error }).toEqual({ as, client, status: 404, error: { code: 'NOT_FOUND', message: 'Client not found.' } });
    }
    expect((await call('GET', `${portalScripts(cMain)}${period('2026-10-06', '2026-10-06')}`)).statusCode).toBe(401);
  });
});

describe('the portal marks a script as recorded (issue #258)', () => {
  it('records a sent script: who and when are the database\'s, and the answer names the person by their link', async () => {
    const script = await seedScript(cMain, { status: 'sent', scenes: [['Gravar', 'Com calma']] });

    const reply = await call('POST', recordedUrl(cMain, script.id), 'portalOne');

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({
      id: script.id,
      scriptOn: '2026-10-20',
      status: 'recorded',
      scenes: [{ position: 1, text: 'Gravar', guidance: 'Com calma' }],
      recordedBy: { name: names.portalOne },
      recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    });
    const stored = await owner.knex('story_scripts').where({ id: script.id }).first('status', 'recorded_by', 'recorded_at');
    expect({ status: stored.status, by: stored.recorded_by }).toEqual({ status: 'recorded', by: users.portalOne!.id });
    expect(new Date(stored.recorded_at).toISOString()).toBe(reply.json().recordedAt);
  });

  it('is idempotent, and the first person who recorded stays the one who recorded', async () => {
    const script = await seedScript(cMain, { status: 'sent' });
    const first = await call('POST', recordedUrl(cMain, script.id), 'portalOne');
    const second = await call('POST', recordedUrl(cMain, script.id), 'portalTwo');

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(second.json().recordedBy).toEqual({ name: names.portalOne });
    expect(second.json().recordedAt).toBe(first.json().recordedAt);
    expect((await stateOf(script.id)).recordedBy).toBe(users.portalOne!.id);
  });

  it.each(['dual', 'dualBare', 'crossDual'] as const)('lets %s record, because an active link is what makes a person of the portal', async (as) => {
    const script = await seedScript(cMain, { status: 'sent' });

    const reply = await call('POST', recordedUrl(cMain, script.id), as);

    expect(reply.statusCode).toBe(200);
    expect(reply.json().recordedBy).toEqual({ name: names[as] });
    expect((await stateOf(script.id)).recordedBy).toBe(users[as]!.id);
  });

  it('refuses a draft with the same 404 as an absent script, even to a collaborator whose role reads drafts, and it stays a draft', async () => {
    const draft = await seedScript(cMain, { status: 'draft' });

    for (const as of ['portalOne', 'dual', 'dualBare', 'crossDual']) {
      expectNotFound(await call('POST', recordedUrl(cMain, draft.id), as), 'Story script not found.');
    }
    expectNotFound(await call('POST', recordedUrl(cMain, randomUUID()), 'dual'), 'Story script not found.');
    expect(await stateOf(draft.id)).toMatchObject({ status: 'draft', recordedBy: null });
  });

  it('refuses a script of another client or of another agency with the same 404, and nothing is recorded', async () => {
    const ofOther = await seedScript(cOther, { status: 'sent' });
    const ofB = await seedScript(cB, { status: 'sent' });
    // `portalOne` also has a link with cCap, so the row-level security SHOWS them this script: only the route's own client filter refuses it.
    const ofCap = await seedScript(cCap, { status: 'sent' });

    for (const [as, client, script] of [
      ['portalOne', cMain, ofCap.id], ['portalOne', cMain, ofOther.id], ['portalOne', cMain, ofB.id], ['portalOther', cMain, ofOther.id], ['portalOther', cOther, 'not-a-uuid'], ['portalOne', cMain, 'not-a-uuid'],
      ['crossDual', cMain, ofB.id], ['portalB', cB, ofOther.id]
    ] as const) {
      const reply = await call('POST', recordedUrl(client, script), as);
      expect({ as, client, script, status: reply.statusCode }).toEqual({ as, client, script, status: 404 });
    }
    expectNotFound(await call('POST', recordedUrl(cMain, ofOther.id), 'portalOne'), 'Story script not found.');
    expect([(await stateOf(ofCap.id)).status, (await stateOf(ofOther.id)).status, (await stateOf(ofB.id)).status]).toEqual(['sent', 'sent', 'sent']);
  });

  it('answers a stranger to the client with the 404 of the client: a removed link, another client\'s person, an archived client, an agency person with no link', async () => {
    const script = await seedScript(cMain, { status: 'sent' });
    const archived = await seedScript(cArchived, { status: 'sent' });

    for (const [as, client, id] of [
      ['portalRemoved', cMain, script.id], ['portalOther', cMain, script.id], ['sales', cMain, script.id], ['opVis', cMain, script.id], ['owner', cMain, script.id], ['portalArchived', cArchived, archived.id]
    ] as const) {
      const reply = await call('POST', recordedUrl(client, id), as);
      expect({ as, client, status: reply.statusCode, error: reply.json().error }).toEqual({ as, client, status: 404, error: { code: 'NOT_FOUND', message: 'Client not found.' } });
    }
    expect((await call('POST', recordedUrl(cMain, script.id))).statusCode).toBe(401);
    expect([(await stateOf(script.id)).status, (await stateOf(archived.id)).status]).toEqual(['sent', 'sent']);
  });

  it('is a 404 for the portal when the archive committed before the script was recorded, and nothing is recorded', async () => {
    const { prepared, reply } = await duringArchiveOfAFreshClient({ committedBeforeStatement: 'story_scripts' }, async (clientId) => {
      await owner.knex('client_memberships').insert({ client_id: clientId, user_id: users.portalOne!.id });
      return seedScript(clientId, { status: 'sent' });
    }, (clientId, script) => call('POST', recordedUrl(clientId, script.id), 'portalOne'));

    expect(reply.statusCode).toBe(404);
    expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
    expect(await stateOf(prepared.id)).toMatchObject({ status: 'sent', recordedBy: null });
  });

  it('is a 404 for the collaborator with a link too, when the archive committed before: the function answers it, not the policy', async () => {
    const { prepared, reply } = await duringArchiveOfAFreshClient({ committedBeforeStatement: 'story_scripts' }, async (clientId) => {
      await owner.knex('client_memberships').insert({ client_id: clientId, user_id: users.dual!.id });
      return seedScript(clientId, { status: 'sent' });
    }, (clientId, script) => call('POST', recordedUrl(clientId, script.id), 'dual'));

    expect(reply.statusCode).toBe(404);
    expect(await stateOf(prepared.id)).toMatchObject({ status: 'sent', recordedBy: null });
  });

  it('serializes two people at the same instant: both get 200 and the first in line is the one who recorded', async () => {
    const script = await seedScript(cMain, { status: 'sent' });
    const holder = await owner.knex.transaction();
    let released = false;
    try {
      expect(await holder('story_scripts').where({ id: script.id }).forUpdate().select('id')).toHaveLength(1);
      const first = call('POST', recordedUrl(cMain, script.id), 'portalTwo');
      await waitUntilSomeoneWaitsOnALock(1);
      const second = call('POST', recordedUrl(cMain, script.id), 'portalOne');
      await waitUntilSomeoneWaitsOnALock(2);
      await holder.commit();
      released = true;

      const [one, two] = [await first, await second];
      expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
      expect(two.json().recordedBy).toEqual({ name: names.portalTwo });
      expect(two.json().recordedAt).toBe(one.json().recordedAt);
    } finally {
      if (!released) await holder.rollback();
    }
    expect((await stateOf(script.id)).recordedBy).toBe(users.portalTwo!.id);
  });

  it.each([
    ['40P01', 409, 'TRY_AGAIN'], ['40001', 409, 'TRY_AGAIN'], ['A0020', 404, 'NOT_FOUND'], ['A0050', 404, 'NOT_FOUND'], ['A0051', 404, 'NOT_FOUND'],
    ['A0052', 409, 'STORY_SCRIPT_STATE'], ['42501', 403, 'FORBIDDEN'], ['XX000', 500, 'INTERNAL_ERROR']
  ] as const)('answers the failure %s of the state change as %i %s, records nothing and works when repeated', async (errcode, status, code) => {
    const script = await seedScript(cMain, { status: 'sent' });

    await withFailing('update', `new.id = '${script.id}'::uuid`, errcode, async () => {
      const failed = await call('POST', recordedUrl(cMain, script.id), 'portalOne');
      expect({ status: failed.statusCode, code: failed.json().error.code }).toEqual({ status, code });
      expect(JSON.stringify(failed.json())).not.toMatch(NO_DATABASE_DETAIL);
    });

    expect(await stateOf(script.id)).toMatchObject({ status: 'sent', recordedBy: null });
    expect((await call('POST', recordedUrl(cMain, script.id), 'portalOne')).statusCode).toBe(200);
  });
});

describe('reading a story script (issue #268)', () => {
  it('reads a script in any state with its scenes in the order of their positions, and writes nothing', async () => {
    const draft = await seedScript(cMain, { scenes: [['Primeira', 'Filmar de perto'], ['Segunda', null], ['Terceira', 'Com a equipe']], insertLastSceneFirst: true });
    const sent = await seedScript(cMain, { status: 'sent', scriptOn: '2026-10-21', scenes: [['Só uma', null]] });
    const recorded = await seedScript(cMain, { status: 'recorded', scriptOn: '2026-10-22', recordedBy: users.portalOne!.id, scenes: [['Gravada', 'Pronto']] });
    const before = await Promise.all([draft, sent, recorded].map((script) => stateOf(script.id)));

    const draftReply = await call('GET', agencyScript(agencyA, cMain, draft.id), 'opVis');
    expect(draftReply.statusCode).toBe(200);
    expect(draftReply.json()).toEqual({
      id: draft.id,
      scriptOn: '2026-10-20',
      status: 'draft',
      scenes: [
        { id: draft.sceneIds[0], position: 1, text: 'Primeira', guidance: 'Filmar de perto' },
        { id: draft.sceneIds[1], position: 2, text: 'Segunda', guidance: null },
        { id: draft.sceneIds[2], position: 3, text: 'Terceira', guidance: 'Com a equipe' }
      ],
      recordedBy: null,
      recordedAt: null,
      createdAt: expect.any(String)
    });
    const sentReply = await call('GET', agencyScript(agencyA, cMain, sent.id), 'opVis');
    expect(sentReply.statusCode).toBe(200);
    expect(sentReply.json()).toMatchObject({ id: sent.id, status: 'sent', scriptOn: '2026-10-21', scenes: [{ id: sent.sceneIds[0], position: 1, text: 'Só uma', guidance: null }] });
    const recordedReply = await call('GET', agencyScript(agencyA, cMain, recorded.id), 'opVis');
    expect(recordedReply.statusCode).toBe(200);
    expect(recordedReply.json()).toMatchObject({
      id: recorded.id,
      status: 'recorded',
      scriptOn: '2026-10-22',
      recordedBy: { name: names.portalOne },
      recordedAt: '2026-10-19T15:00:00.000Z'
    });
    expect(await Promise.all([draft, sent, recorded].map((script) => stateOf(script.id)))).toEqual(before);
  });

  it('reads with conteudo.visualizar alone, and the Owner without a role; conteudo.operar alone, Vendas, Financeiro and no key are a 403', async () => {
    const script = await seedScript(cMain);
    const url = agencyScript(agencyA, cMain, script.id);

    for (const as of ['onlyVisualizar', 'owner', 'opVis', 'dual']) {
      expect({ as, status: (await call('GET', url, as)).statusCode }).toEqual({ as, status: 200 });
    }
    for (const as of ['onlyOperar', 'sales', 'finance', 'dualBare']) {
      const reply = await call('GET', url, as);
      expect({ as, status: reply.statusCode, code: reply.json().error.code }).toEqual({ as, status: 403, code: 'FORBIDDEN' });
      expect(JSON.stringify(reply.json())).not.toContain('Cena um');
    }
    expect((await call('GET', url)).statusCode).toBe(401);
  });

  it('answers a person who has only a client link, or another agency\'s admin, as a stranger to the agency', async () => {
    const script = await seedScript(cMain, { status: 'sent' });

    for (const as of ['portalOne', 'portalTwo', 'crossDual', 'ownerB']) {
      const reply = await call('GET', agencyScript(agencyA, cMain, script.id), as);
      expectNotFound(reply, 'Agency not found.');
      expect(JSON.stringify(reply.json())).not.toContain('Cena um');
    }
  });

  it('answers the same 404 for a script of another client, of another agency, absent or malformed', async () => {
    const ofOther = await seedScript(cOther);
    const ofB = await seedScript(cB);

    for (const url of [
      agencyScript(agencyA, cMain, ofOther.id), agencyScript(agencyA, cMain, ofB.id), agencyScript(agencyA, cB, ofB.id),
      agencyScript(agencyA, cMain, randomUUID()), agencyScript(agencyA, cMain, 'not-a-uuid'), agencyScript(agencyA, 'not-a-uuid', ofOther.id)
    ]) {
      const reply = await call('GET', url, 'opVis');
      expect({ url, status: reply.statusCode }).toEqual({ url, status: 404 });
      expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
    }
    expectNotFound(await call('GET', agencyScript(agencyA, cMain, ofOther.id), 'opVis'), 'Story script not found.');
    expectNotFound(await call('GET', agencyScript(agencyA, cMain, ofB.id), 'opVis'), 'Story script not found.');
    expectNotFound(await call('GET', agencyScript(agencyA, cB, ofB.id), 'opVis'), 'Client not found.');
  });

  it('keeps the two agencies apart for a person who reads Conteúdo in both: the client is the agency\'s of the URL', async () => {
    const ofMain = await seedScript(cMain);
    const ofB = await seedScript(cB);

    expect((await call('GET', agencyScript(agencyA, cMain, ofMain.id), 'twoAgencies')).statusCode).toBe(200);
    expect((await call('GET', agencyScript(agencyB, cB, ofB.id), 'twoAgencies')).statusCode).toBe(200);
    expectNotFound(await call('GET', agencyScript(agencyB, cMain, ofMain.id), 'twoAgencies'), 'Client not found.');
    expectNotFound(await call('GET', agencyScript(agencyA, cB, ofB.id), 'twoAgencies'), 'Client not found.');
  });

  it('reads the script of an archived client, drafts included: archived is read-only, not hidden', async () => {
    const draft = await seedScript(cArchived);
    const sent = await seedScript(cArchived, { status: 'sent' });

    for (const script of [draft, sent]) {
      const reply = await call('GET', agencyScript(agencyA, cArchived, script.id), 'opVis');
      expect({ id: script.id, status: reply.statusCode }).toEqual({ id: script.id, status: 200 });
      expect(reply.json().scenes.map((scene: { id: string }) => scene.id)).toEqual(script.sceneIds);
    }
    expect((await stateOf(draft.id)).status).toBe('draft');
  });
});

describe('what the agency and the portal never share (issue #258)', () => {
  it('does not let the portal reach the agency routes, nor the agency the portal ones', async () => {
    const script = await seedScript(cMain, { status: 'sent' });

    for (const as of ['portalOne', 'portalTwo', 'crossDual']) {
      expectNotFound(await call('PATCH', agencyScript(agencyA, cMain, script.id), as, { scriptOn: '2026-12-30' }), 'Agency not found.');
    }
    expect((await stateOf(script.id)).scriptOn).toBe('2026-10-20');
    for (const as of ['sales', 'onlyOperar']) {
      expectNotFound(await call('POST', recordedUrl(cMain, script.id), as), 'Client not found.');
    }
    expect((await stateOf(script.id)).status).toBe('sent');
  });
});
