import { randomUUID } from 'node:crypto';

import type { AgencySearchResponse } from '@ageniza/contracts';
import { createVerifiedUserClaims, withAuthenticatedUserTransaction } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captureLogs, insertTestUser, TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { createPortalFixtures } from '../contents/test-support/portal-fixtures.js';
import { createContentsWorld, type Reply, type SeedContent } from '../contents/test-support/world.js';
import { searchAgency, type SearchTransaction } from './service.js';

// Scope redesign-igual, subtask W9-S1 (specs/busca.md, decision 2026-11-11): the search of the agency's top bar. It is probed with what a
// person who may not read a group could infer (the shape of the answer, the statements that ran), with the agency of the route against
// people who belong to two, with the term as text and never as a pattern, and with the log. The last test takes the policies of
// `clients`, `contents` and `media_assets` away to prove the agency and the permissions are in the route and the query themselves.
const logs = captureLogs('debug');
const w = createContentsWorld('search');
const p = createPortalFixtures(w);
const { people } = w;

const knex = () => w.getOwner().knex;
// 12:00 in São Paulo, on 2026-11-13: the instant "today" and "scheduled" are read at.
const NOW = new Date('2026-11-13T15:00:00.000Z');
let failPresign = false;

type Body = AgencySearchResponse;
type SearchPerson = Parameters<typeof w.call>[1];

const searchUrl = (q: string, agencyId = w.agencyA): string => `/agencies/${agencyId}/search?q=${encodeURIComponent(q)}`;
const search = (cookie: SearchPerson, q: string, agencyId = w.agencyA): Promise<Reply> => w.call('GET', cookie, searchUrl(q, agencyId));
const bodyOf = (reply: Reply): Body => {
  expect(reply.statusCode).toBe(200);
  return reply.json<Body>();
};
const textOf = (reply: Reply): string => (reply as unknown as { readonly body: string }).body;
const found = async (cookie: SearchPerson, q: string, agencyId = w.agencyA): Promise<Body['data']> => bodyOf(await search(cookie, q, agencyId)).data;
const clientNames = (data: Body['data']): string[] => data.clients.map((client) => client.name);
const titles = (data: Body['data']): string[] => data.contents.map((content) => content.title);
const fileNames = (data: Body['data']): string[] => data.files.map((file) => file.name);

/** Which of the three queries reached the database since the last `forget`. */
const ran = (): { clients: boolean; contents: boolean; files: boolean } => ({
  clients: w.statements.some((statement) => statement.includes('client.photo_key')),
  contents: w.statements.some((statement) => /public\.contents\b/.test(statement)),
  files: w.statements.some((statement) => /public\.media_assets\b/.test(statement))
});
const forget = (): void => { w.statements.length = 0; };

const extraUserIds: string[] = [];
const newClients: string[] = [];

/** A person with the Admin role of agency A and a login of their own: each has a bucket of the rate limit of their own too. */
const freshAdmin = async (label: string): Promise<{ id: string; cookie: string }> => {
  const user = await insertTestUser(w.getApp().pool, w.getApp().auth, { emailLabel: `search-${label}`, name: `Busca ${label}` });
  extraUserIds.push(user.id);
  const admin = await knex()('roles').whereNull('agency_id').where({ key: 'admin' }).first('id');
  await knex()('agency_memberships').insert({ agency_id: w.agencyA, user_id: user.id, role_id: admin!.id });
  const login = await w.getApp().app.inject({ method: 'POST', url: '/auth/login', headers: { origin: TEST_APP_PUBLIC_URL }, payload: { email: user.email, password: user.password } });
  expect(login.statusCode).toBe(200);
  return { id: user.id, cookie: login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') };
};

interface ClientSeed {
  readonly agencyId?: string;
  readonly legalName?: string;
  readonly handle?: string;
  readonly archived?: boolean;
  readonly photoKey?: string;
}

let clientCount = 0;
const newClient = async (name: string, seed: ClientSeed = {}): Promise<string> => {
  clientCount += 1;
  const id = await w.newClient(`s${clientCount}`, { ...(seed.agencyId === undefined ? {} : { agencyId: seed.agencyId }), status: seed.archived === true ? 'archived' : 'active' });
  await knex()('clients').where({ id }).update({
    name,
    legal_name: seed.legalName ?? null,
    instagram_handle: seed.handle ?? null,
    photo_key: seed.photoKey ?? null
  });
  newClients.push(id);
  return id;
};

const newContent = (clientId: string, title: string, extra: SeedContent = {}): Promise<string> =>
  w.seedContent(clientId, { title, publishOn: '2026-11-20', ...extra });

interface FileSeed {
  readonly category?: 'image' | 'video';
  readonly status?: 'pending' | 'confirmed';
  readonly removed?: boolean;
  readonly video?: 'pending' | 'ready' | 'failed';
  readonly folderId?: string;
}

const newFile = async (clientId: string, name: string, extra: FileSeed = {}): Promise<string> => {
  const id = await w.seedAsset(clientId, extra.folderId ?? await w.folderOf(clientId), {
    ...(extra.category === undefined ? {} : { category: extra.category }),
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.removed === undefined ? {} : { removed: extra.removed }),
    ...(extra.video === undefined ? {} : { video: extra.video })
  });
  await knex()('media_assets').where({ id }).update({ file_name: name });
  return id;
};

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

beforeAll(async () => {
  await w.setup({
    contentsClock: () => NOW,
    logger: logs.logger,
    wrapIdentityStorage: (real) => ({
      ...real,
      presignGetObject: async (input) => {
        if (failPresign) throw new Error('the storage refused the signature');
        return real.presignGetObject(input);
      }
    })
  });
  await p.setup();
  // The Owner of agency A owns agency B too: the Owner of two agencies must still get only the agency of the route.
  await knex()('agencies').where({ id: w.agencyB }).update({ owner_user_id: people.owner.id });
});

afterAll(async () => {
  await p.cleanup();
  await knex()('agency_memberships').whereIn('user_id', extraUserIds).delete();
  await w.getApp().pool.query('delete from auth."user" where id = any($1::uuid[])', [extraUserIds]);
  await w.teardown();
});

describe('what a name matches', () => {
  let admin: { id: string; cookie: string };
  let byName: string;
  let byLegalName: string;
  let byHandle: string;
  let archived: string;
  let inB: string;

  beforeAll(async () => {
    admin = await freshAdmin('match');
    byName = await newClient('Pádua Móveis');
    byLegalName = await newClient('Alfa Estofados', { legalName: 'Móveis Pádua Ltda' });
    byHandle = await newClient('Beta Design', { handle: 'padua.loja' });
    archived = await newClient('Velha Pádua Casa', { archived: true });
    await newClient('Nada Aqui');
    inB = await newClient('Pádua da Agência B', { agencyId: w.agencyB });
  });

  it('finds a client by name, legal name and handle with no accent and no case, the archived one marked, and never one of another agency', async () => {
    const data = await found(admin.cookie, 'PADUA');

    expect(clientNames(data)).toEqual(['Pádua Móveis', 'Alfa Estofados', 'Beta Design', 'Velha Pádua Casa']);
    expect(data.clients.map((client) => client.id)).toEqual([byName, byLegalName, byHandle, archived]);
    expect(data.clients.map((client) => client.archived)).toEqual([false, false, false, true]);
    expect(data.clients.map((client) => client.instagramHandle)).toEqual([null, null, 'padua.loja', null]);
    expect(data.clients.map((client) => client.id)).not.toContain(inB);
    expect(Object.keys(data.clients[0]!).sort()).toEqual(['archived', 'id', 'instagramHandle', 'name', 'photoUrl']);
  });

  it('reads an @ as the handle, which is stored without it, and does not match the name with it', async () => {
    expect((await found(admin.cookie, '@padua')).clients.map((client) => client.id)).toEqual([byHandle]);
    expect((await found(admin.cookie, '@PADUA.lo')).clients.map((client) => client.id)).toEqual([byHandle]);
    expect((await found(admin.cookie, 'padua.loja')).clients.map((client) => client.id)).toEqual([byHandle]);
  });

  it('folds the accent of the term too, and the NFD form of it', async () => {
    expect(clientNames(await found(admin.cookie, 'pádua')).slice(0, 1)).toEqual(['Pádua Móveis']);
    expect(clientNames(await found(admin.cookie, 'padua'.replace('a', 'á'.normalize('NFD')))).slice(0, 1)).toEqual(['Pádua Móveis']);
    expect((await found(admin.cookie, 'ESTOFADOS')).clients.map((client) => client.id)).toEqual([byLegalName]);
    expect((await found(admin.cookie, 'moveis padua ltda')).clients.map((client) => client.id)).toEqual([byLegalName]);
  });

  it('folds the accent and the case of a title and of a file name as well, whichever way the term is written', async () => {
    const client = await newClient('Gráfica Rápida');
    const content = await newContent(client, 'Cartão de Visita');
    const file = await newFile(client, 'Ação Cartão.png');

    for (const term of ['CARTAO', 'cartão', 'CARTÃO', 'Cartão'.normalize('NFD')]) {
      const data = await found(admin.cookie, term);
      expect({ term, contents: data.contents.map((item) => item.id), files: data.files.map((item) => item.id) }).toEqual({ term, contents: [content], files: [file] });
    }
    expect((await found(admin.cookie, 'acao')).files.map((item) => item.id)).toEqual([file]);
    expect((await found(admin.cookie, 'RAPIDA')).clients.map((item) => item.id)).toEqual([client]);
  });

  it('takes % and _ and the backslash as text, in each of the three groups', async () => {
    const lots = await newClient('Lote 50%');
    await newClient('Lote 500');
    const kit = await newClient('Kit_um');
    await newClient('Kit um');
    const slash = await newClient('Rota\\sul');
    await newClient('Rota sul');
    const carrier = await newClient('Texto Literal');
    const offer = await newContent(carrier, 'Oferta 50%');
    await newContent(carrier, 'Oferta 500');
    const underscore = await newContent(carrier, 'Pack_dois');
    await newContent(carrier, 'Pack dois');
    const photo = await newFile(carrier, 'foto_1.png');
    await newFile(carrier, 'fotoX1.png');
    const wildcardPercent = await newFile(carrier, 'tela 20%.png');
    await newFile(carrier, 'tela 2000.png');

    expect((await found(admin.cookie, '50%')).clients.map((client) => client.id)).toEqual([lots]);
    expect((await found(admin.cookie, 'kit_um')).clients.map((client) => client.id)).toEqual([kit]);
    expect((await found(admin.cookie, 'rota\\sul')).clients.map((client) => client.id)).toEqual([slash]);
    expect((await found(admin.cookie, 'oferta 50%')).contents.map((content) => content.id)).toEqual([offer]);
    expect((await found(admin.cookie, 'pack_dois')).contents.map((content) => content.id)).toEqual([underscore]);
    expect((await found(admin.cookie, 'foto_1')).files.map((file) => file.id)).toEqual([photo]);
    expect((await found(admin.cookie, 'tela 20%')).files.map((file) => file.id)).toEqual([wildcardPercent]);
    // A term that is only wildcards matches nothing that has none of them.
    expect(await found(admin.cookie, '%%')).toEqual({ clients: [], contents: [], files: [] });
    expect(await found(admin.cookie, '__')).toEqual({ clients: [], contents: [], files: [] });
  });

  it('finds a content by title, a cancelled one too, with the state it has and the two derived ones read at the clock of São Paulo', async () => {
    const client = await newClient('Casa Conteúdo');
    const late = await newContent(client, 'Promoção de Pães', { status: 'in_production', publishOn: '2026-11-10' });
    const scheduled = await newContent(client, 'Promoção Relâmpago', { status: 'approved', publishOn: '2026-11-20', publishAtTime: '18:30' });
    const passedToday = await newContent(client, 'Promoção Antiga', { status: 'approved', publishOn: '2026-11-13', publishAtTime: '11:00' });
    const laterToday = await newContent(client, 'Promoção Noturna', { status: 'approved', publishOn: '2026-11-13', publishAtTime: '20:00' });
    const noHour = await newContent(client, 'Promoção Sem Hora', { status: 'approved', publishOn: '2026-11-25', publishAtTime: null });
    const cancelled = await newContent(client, 'Promoção Cancelada', { status: 'cancelled', publishOn: '2026-11-01' });
    await newContent(client, 'Outra Coisa');

    const data = await found(admin.cookie, 'PROMOCAO');
    const byId = new Map(data.contents.map((content) => [content.id, content]));

    expect(data.contents).toHaveLength(6);
    expect(byId.get(late)).toMatchObject({ title: 'Promoção de Pães', status: 'in_production', overdue: true, scheduled: false, publishOn: '2026-11-10', clientId: client, clientName: 'Casa Conteúdo', format: 'reels' });
    expect(byId.get(scheduled)).toMatchObject({ status: 'approved', overdue: false, scheduled: true });
    expect(byId.get(passedToday)).toMatchObject({ status: 'approved', overdue: false, scheduled: false });
    expect(byId.get(laterToday)).toMatchObject({ status: 'approved', overdue: false, scheduled: true });
    expect(byId.get(noHour)).toMatchObject({ status: 'approved', overdue: false, scheduled: false });
    expect(byId.get(cancelled)).toMatchObject({ status: 'cancelled', overdue: false, scheduled: false });
    expect(Object.keys(data.contents[0]!).sort()).toEqual(['clientId', 'clientName', 'format', 'id', 'overdue', 'publishOn', 'scheduled', 'status', 'title']);
  });

  it('finds a file by name, not the removed one nor the one that is not confirmed, with its client, its folder and its picture', async () => {
    const client = await newClient('Casa Arquivos');
    const folder = await w.folderOf(client);
    const image = await newFile(client, 'padaria-fachada.jpg', { category: 'image' });
    const ready = await newFile(client, 'Padaria Vídeo Pronto.mp4', { category: 'video', video: 'ready' });
    const processing = await newFile(client, 'padaria-video-novo.mp4', { category: 'video', video: 'pending' });
    const removed = await newFile(client, 'padaria-removida.jpg', { removed: true });
    const pending = await newFile(client, 'padaria-pendente.jpg', { status: 'pending' });
    const inOtherAgency = await newFile(await newClient('Casa Arquivos B', { agencyId: w.agencyB }), 'padaria-b.jpg');
    // The constraint of the table lets a file of a client sit outside every folder, and the answer has no shape for it.
    const noFolder = await newFile(client, 'padaria-sem-pasta.jpg');
    await knex()('media_assets').where({ id: noFolder }).update({ folder_id: null });

    const data = await found(admin.cookie, 'PADARIA');
    const byId = new Map(data.files.map((file) => [file.id, file]));

    expect([...byId.keys()].sort()).toEqual(sorted([image, ready, processing]));
    expect(data.files.map((file) => file.id)).not.toEqual(expect.arrayContaining([removed]));
    expect([removed, pending, inOtherAgency, noFolder].some((id) => byId.has(id))).toBe(false);
    expect(byId.get(image)).toEqual({ id: image, clientId: client, clientName: 'Casa Arquivos', folderId: folder, name: 'padaria-fachada.jpg', category: 'image', thumbnailAssetId: image });
    expect(byId.get(ready)).toMatchObject({ category: 'video', thumbnailAssetId: ready });
    expect(byId.get(processing)).toMatchObject({ category: 'video', thumbnailAssetId: null });
  });

  it('keeps a file with no name out: it matches nothing, so the media of before the name was kept is not found', async () => {
    const client = await newClient('Casa Sem Nome');
    const id = await w.seedAsset(client, await w.folderOf(client));
    await knex()('media_assets').where({ id }).update({ file_name: null });

    expect(await found(admin.cookie, 'sem nome')).toMatchObject({ files: [] });
    expect((await found(admin.cookie, 'Casa Sem Nome')).clients).toHaveLength(1);
  });
});

describe('the order and the ceiling of six', () => {
  let admin: { id: string; cookie: string };

  beforeAll(async () => {
    admin = await freshAdmin('order');
  });

  it('puts a name that starts with the term before one that only contains it, then goes by the folded name', async () => {
    const substringLate = await newClient('Loja Zeta');
    const prefixB = await newClient('Zeta Norte');
    const substringEarly = await newClient('Casa Zeta');
    const prefixA = await newClient('Zeta Alfa');
    const lastByName = await newClient('Terra Zeta');
    const carrier = await newClient('Cliente Ordem');
    for (const title of ['Dia Zeta', 'Zeta Prime', 'Antes Zeta', 'zeta minúsculo']) await newContent(carrier, title);
    for (const name of ['arquivo-zeta.png', 'zeta-b.png', 'zeta-a.png', 'Zeta-C.png']) await newFile(carrier, name);

    const data = await found(admin.cookie, 'zeta');

    expect(data.clients.map((client) => client.id)).toEqual([prefixA, prefixB, substringEarly, substringLate, lastByName]);
    expect(titles(data)).toEqual(['zeta minúsculo', 'Zeta Prime', 'Antes Zeta', 'Dia Zeta']);
    expect(fileNames(data)).toEqual(['zeta-a.png', 'zeta-b.png', 'Zeta-C.png', 'arquivo-zeta.png']);
  });

  it('sorts the accented name where the unaccented letter is, not after z', async () => {
    await newClient('Zumbi Ordem');
    await newClient('Álamo Ordem');
    await newClient('Bruno Ordem');

    expect(clientNames(await found(admin.cookie, 'ordem'))).toEqual(['Álamo Ordem', 'Bruno Ordem', 'Cliente Ordem', 'Zumbi Ordem']);
  });

  it('cuts every group at six and keeps the six that come first, not any six', async () => {
    const carrier = await newClient('Cliente do Teto');
    for (let n = 8; n >= 1; n -= 1) {
      await newClient(`Teto ${n}`);
      await newContent(carrier, `Teto ${n}`);
      await newFile(carrier, `teto-${n}.png`, { folderId: await w.newFolder(carrier, `Pasta ${n}`) });
    }

    const data = await found(admin.cookie, 'teto');

    expect(clientNames(data)).toEqual(['Teto 1', 'Teto 2', 'Teto 3', 'Teto 4', 'Teto 5', 'Teto 6']);
    expect(titles(data)).toEqual(['Teto 1', 'Teto 2', 'Teto 3', 'Teto 4', 'Teto 5', 'Teto 6']);
    expect(fileNames(data)).toEqual(['teto-1.png', 'teto-2.png', 'teto-3.png', 'teto-4.png', 'teto-5.png', 'teto-6.png']);
  });

  it('breaks a tie of the name by the id, in every group, and always the same way', async () => {
    // Six twins of each: the cut of six keeps all of them, so only the id decides their order, and the chance that the order they were
    // written in is already the order of their ids is 1 in 720.
    const clients: string[] = [];
    const contents: string[] = [];
    const files: string[] = [];
    const carrier = await newClient('Cliente dos Pares');
    for (let n = 1; n <= 6; n += 1) {
      clients.push(await newClient('Gêmeo Cliente', n === 1 ? {} : { archived: true }));
      contents.push(await newContent(carrier, 'Gêmeo Título'));
      files.push(await newFile(carrier, 'gêmeo.png', { folderId: await w.newFolder(carrier, `G${n}`) }));
    }

    const first = await found(admin.cookie, 'gemeo');
    const second = await found(admin.cookie, 'gemeo');

    expect(first.clients.map((client) => client.id)).toEqual(sorted(clients));
    expect(first.contents.map((content) => content.id)).toEqual(sorted(contents));
    expect(first.files.map((file) => file.id)).toEqual(sorted(files));
    expect(second).toEqual(first);
  });
});

describe('the two agencies', () => {
  let clientA: string;
  let clientB: string;

  beforeAll(async () => {
    clientA = await newClient('Fronteira Alfa');
    clientB = await newClient('Fronteira Beta', { agencyId: w.agencyB });
    await newContent(clientA, 'Fronteira em A');
    await newContent(clientB, 'Fronteira em B', { ownerUserId: people.adminB.id });
    await newFile(clientA, 'fronteira-a.png');
    await newFile(clientB, 'fronteira-b.png');
  });

  it('gives the person who is in both only the agency of the route, in each', async () => {
    const inA = await found(people.dual.cookie, 'fronteira', w.agencyA);
    const inB = await found(people.dual.cookie, 'fronteira', w.agencyB);

    expect(clientNames(inA)).toEqual(['Fronteira Alfa']);
    expect(titles(inA)).toEqual(['Fronteira em A']);
    expect(fileNames(inA)).toEqual(['fronteira-a.png']);
    expect(clientNames(inB)).toEqual(['Fronteira Beta']);
    expect(titles(inB)).toEqual(['Fronteira em B']);
    expect(fileNames(inB)).toEqual(['fronteira-b.png']);
  });

  it('gives the Owner of both agencies only the agency of the route, though the policy shows him both', async () => {
    const inA = await found(people.owner.cookie, 'fronteira', w.agencyA);
    const inB = await found(people.owner.cookie, 'fronteira', w.agencyB);

    expect([clientNames(inA), titles(inA), fileNames(inA)]).toEqual([['Fronteira Alfa'], ['Fronteira em A'], ['fronteira-a.png']]);
    expect([clientNames(inB), titles(inB), fileNames(inB)]).toEqual([['Fronteira Beta'], ['Fronteira em B'], ['fronteira-b.png']]);
  });

  it('keeps out of agency B the client of agency A that an Admin of B reaches through a link to him, and answers 404 in A to that person', async () => {
    // crossDual is an Admin of B and has a link to client A1: `clients_select` shows him A1, and only the route keeps it out.
    await knex()('clients').where({ id: p.clientA1 }).update({ name: 'Fronteira do Portal' });

    expect(clientNames(await found(p.people.crossDual.cookie, 'fronteira', w.agencyB))).toEqual(['Fronteira Beta']);
    const refused = await search(p.people.crossDual.cookie, 'fronteira', w.agencyA);
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe('NOT_FOUND');
  });

  it('refuses a person with no link to the agency as it refuses a stranger: the same 404', async () => {
    const stranger = await search(people.adminB.cookie, 'fronteira', w.agencyA);
    const nonexistent = await search(people.adminB.cookie, 'fronteira', randomUUID());

    expect(stranger.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(stranger.json().error).toEqual(nonexistent.json().error);
  });
});

describe('who may read each group', () => {
  let clientId: string;
  const forbiddenFor = ['sales', 'finance', 'noContent'] as const;
  const emptyForSearch = { clients: [], contents: [], files: [] } satisfies Body['data'];

  beforeAll(async () => {
    clientId = await newClient('Permissão Cliente');
    await newContent(clientId, 'Permissão Conteúdo');
    await newFile(clientId, 'permissao-arquivo.png');
  });

  it('gives Admin, Gestor de conta, Produção, the reader of content and the Owner the groups they hold, and nobody else a group they do not', async () => {
    forget();
    expect(Object.keys(await found(people.admin.cookie, 'permissao'))).toEqual(['clients', 'contents', 'files']);
    for (const person of ['admin', 'manager', 'production', 'owner'] as const) {
      const data = await found(people[person].cookie, 'permissao');
      expect({ person, clients: data.clients.length, contents: data.contents.length, files: data.files.length }).toEqual({ person, clients: 1, contents: 1, files: 1 });
    }
    const reader = await found(people.reader.cookie, 'permissao');
    expect({ clients: reader.clients, contents: reader.contents.length, files: reader.files.length }).toEqual({ clients: [], contents: 1, files: 1 });
  });

  it('answers the person who may read only clients with the shape of one who may read all and found nothing: [] for both groups', async () => {
    for (const person of forbiddenFor) {
      const reply = await search(people[person].cookie, 'permissao');
      const data = bodyOf(reply).data;
      expect({ person, clients: data.clients.length, contents: data.contents, files: data.files }).toEqual({ person, clients: 1, contents: [], files: [] });
    }

    // What the two have in common is everything but the term: the keys, their order, the types and the empty groups.
    const blocked = bodyOf(await search(people.sales.cookie, 'zzpermissao-nada'));
    const empty = bodyOf(await search(people.admin.cookie, 'zzpermissao-nada'));
    expect(blocked).toEqual(empty);
    expect(Object.keys(blocked.data)).toEqual(Object.keys(empty.data));
    expect(textOf(await search(people.sales.cookie, 'zzpermissao-nada'))).toBe(textOf(await search(people.admin.cookie, 'zzpermissao-nada')));
    // And for the term only a content or a file has: the answer of who may not read it is the answer of nothing found.
    const hidden = await search(people.sales.cookie, 'permissao-arquivo');
    const nothing = await search(people.admin.cookie, 'permissao-arquivo-inexistente');
    expect(JSON.parse(textOf(hidden)).data).toEqual(emptyForSearch);
    expect(JSON.parse(textOf(nothing)).data).toEqual(emptyForSearch);
    expect(textOf(hidden).replace('permissao-arquivo', 'q')).toBe(textOf(nothing).replace('permissao-arquivo-inexistente', 'q'));
  });

  it('answers 200 with three empty groups to the person who may read neither', async () => {
    const reply = await search(people.operateOnly.cookie, 'permissao');
    expect(reply.statusCode).toBe(200);
    expect(reply.json().data).toEqual(emptyForSearch);
  });

  it('does not run the query of a group the person may not read: no statement reaches the table', async () => {
    forget();
    await search(people.admin.cookie, 'permissao');
    expect(ran()).toEqual({ clients: true, contents: true, files: true });

    forget();
    await search(people.sales.cookie, 'permissao');
    expect(ran()).toEqual({ clients: true, contents: false, files: false });

    forget();
    await search(people.reader.cookie, 'permissao');
    expect(ran()).toEqual({ clients: false, contents: true, files: true });

    forget();
    await search(people.operateOnly.cookie, 'permissao');
    expect(ran()).toEqual({ clients: false, contents: false, files: false });

    forget();
    await search(people.owner.cookie, 'permissao');
    expect(ran()).toEqual({ clients: true, contents: true, files: true });
  });

  it('does not let the term decide which statements run: an invalid term reaches no table', async () => {
    forget();
    expect((await search(people.admin.cookie, 'x')).statusCode).toBe(400);
    expect(ran()).toEqual({ clients: false, contents: false, files: false });
  });
});

describe('the term', () => {
  let admin: { id: string; cookie: string };
  const echoes = (reply: Reply, term: string): boolean => textOf(reply).includes(term);

  beforeAll(async () => {
    admin = await freshAdmin('term');
  });

  it('is trimmed, kept to 2 to 80 characters, and answered back on `meta.q` as it was cleaned', async () => {
    const reply = bodyOf(await search(admin.cookie, '  Termo Limpo  '));
    expect(reply.meta).toEqual({ q: 'Termo Limpo' });
    expect(bodyOf(await search(admin.cookie, 'ab')).meta).toEqual({ q: 'ab' });
    expect(bodyOf(await search(admin.cookie, 'a'.repeat(80))).meta.q).toHaveLength(80);
    expect(bodyOf(await search(admin.cookie, `${' '.repeat(5)}${'b'.repeat(80)}${' '.repeat(5)}`)).meta.q).toHaveLength(80);
  });

  it('answers 400 to a term of one character, of 81, of spaces only and with a control character, and never says the term back', async () => {
    const cases: Array<[string, string]> = [
      ['one character', 'z'],
      ['81 characters', `zzterm${'k'.repeat(75)}`],
      ['spaces only', '     '],
      ['a line feed', 'zzterm\nline'],
      ['a NUL', 'zzterm\u0000nul'],
      ['an escape', 'zzterm\u001bxx'],
      ['a delete', 'zzterm\u007fxx'],
      ['a tab', 'zzterm\tab']
    ];
    for (const [label, term] of cases) {
      const reply = await search(admin.cookie, term);
      expect({ label, status: reply.statusCode, code: reply.json().error.code }).toEqual({ label, status: 400, code: 'VALIDATION_ERROR' });
      expect({ label, echoed: echoes(reply, 'zzterm') }).toEqual({ label, echoed: false });
    }
  });

  it('measures the minimum after the accents are folded: marks alone, a letter with a mark and an @ with a mark are as short as one character, and reach no table', async () => {
    const tooShort = await search(admin.cookie, 'z');
    expect(tooShort.statusCode).toBe(400);
    const cases: Array<[string, string]> = [
      ['two combining marks', '́́'],
      ['one letter and a mark', 'á'],
      ['the composed letter', 'á'],
      ['an @ and a mark', '@́'],
      ['the @ alone', '@'],
      ['an @ and one letter', '@a'],
      ['an @ and a letter with a mark', '@á']
    ];

    for (const [label, term] of cases) {
      forget();
      const reply = await search(admin.cookie, term);
      expect({ label, status: reply.statusCode }).toEqual({ label, status: 400 });
      // The same refusal a short term gets, field and rule only: nothing tells the two apart.
      expect({ label, error: { ...reply.json().error, requestId: undefined } }).toEqual({ label, error: { ...tooShort.json().error, requestId: undefined } });
      expect({ label, ran: ran() }).toEqual({ label, ran: { clients: false, contents: false, files: false } });
    }
  });

  it('keeps a term that is two characters or more once the accents are folded, and an @ with two letters', async () => {
    for (const term of ['áb', 'áb', 'á́b', '@ab', '@áb', 'ab́']) {
      const reply = await search(admin.cookie, term);
      expect({ term, status: reply.statusCode }).toEqual({ term, status: 200 });
    }
  });

  it('answers 400 to a missing term, to a term sent twice and to any other parameter', async () => {
    for (const url of [
      `/agencies/${w.agencyA}/search`,
      `/agencies/${w.agencyA}/search?q=`,
      `/agencies/${w.agencyA}/search?q=ab&q=cd`,
      `/agencies/${w.agencyA}/search?q=ab&limit=100`,
      `/agencies/${w.agencyA}/search?q=ab&page=2`,
      `/agencies/${w.agencyA}/search?Q=ab`
    ]) {
      const reply = await w.call('GET', admin.cookie, url);
      expect({ url, status: reply.statusCode, code: reply.json().error.code }).toEqual({ url, status: 400, code: 'VALIDATION_ERROR' });
    }
  });

  it('is data and never SQL: a term made of quotes, comments and a statement finds nothing and breaks nothing', async () => {
    for (const term of ["' or '1'='1", "'; drop table clients; --", '" or 1=1 --', '$1', '??', ':q', '{{x}}', '%_%\\%']) {
      const reply = await search(admin.cookie, term);
      expect({ term, status: reply.statusCode }).toEqual({ term, status: 200 });
      expect(reply.json().data).toEqual({ clients: [], contents: [], files: [] });
    }
    expect(Number((await knex()('clients').count<Array<{ count: string }>>('id as count'))[0]!.count)).toBeGreaterThan(0);
  });
});

describe('the person of the portal and the guards', () => {
  it('refuses the person of the portal as it refuses a stranger to the agency, whichever client they hold', async () => {
    for (const person of ['portalOne', 'portalMulti', 'portalOther', 'portalB'] as const) {
      const reply = await search(p.people[person].cookie, 'fronteira');
      expect({ person, status: reply.statusCode, code: reply.json().error.code }).toEqual({ person, status: 404, code: 'NOT_FOUND' });
    }
  });

  it('answers 401 without a session, and 400 to an agency id that is not a uuid', async () => {
    const anonymous = await w.getApp().app.inject({ method: 'GET', url: searchUrl('fronteira'), headers: { origin: TEST_APP_PUBLIC_URL } });
    expect(anonymous.statusCode).toBe(401);
    const malformed = await w.call('GET', people.admin.cookie, '/agencies/not-a-uuid/search?q=ab');
    expect(malformed.statusCode).toBe(400);
  });

  it('searches in an agency that is read-only, and an agency that is suspended is closed to every route, this one included', async () => {
    const before = await knex()('agencies').where({ id: w.agencyB }).first('plan', 'trial_ends_at', 'trial_owner_email_key', 'status');
    const probe = await newClient('Somente Leitura Cliente', { agencyId: w.agencyB });
    try {
      await knex()('agencies').where({ id: w.agencyB }).update({
        plan: 'trial',
        trial_ends_at: knex().raw("now() - interval '1 minute'"),
        trial_owner_email_key: `search-${randomUUID()}`
      });
      const write = await w.call('POST', people.adminB.cookie, `/agencies/${w.agencyB}/clients`, { name: 'Escrita Recusada' });
      expect(write.statusCode).toBe(409);
      expect(write.json().error.code).toBe('AGENCY_READ_ONLY');

      expect((await found(people.adminB.cookie, 'somente leitura', w.agencyB)).clients.map((client) => client.id)).toEqual([probe]);

      await knex()('agencies').where({ id: w.agencyB }).update({ status: 'suspended' });
      const suspended = await search(people.adminB.cookie, 'somente leitura', w.agencyB);
      expect(suspended.statusCode).toBe(404);
      expect(suspended.json().error.message).toBe('Agency not found.');
    } finally {
      await knex()('agencies').where({ id: w.agencyB }).update({
        plan: before!.plan,
        trial_ends_at: before!.trial_ends_at,
        trial_owner_email_key: before!.trial_owner_email_key,
        status: before!.status
      });
    }
  });
});

describe('the rate limit', () => {
  it('answers the 61st request of the minute with 429 RATE_LIMITED and a Retry-After, and does not count the ones the guards refuse', async () => {
    const person = await freshAdmin('limit');
    for (let n = 0; n < 5; n += 1) expect((await search(person.cookie, 'ab', randomUUID())).statusCode).toBe(404);

    for (let n = 1; n <= 60; n += 1) {
      const reply = await search(person.cookie, 'limite');
      if (reply.statusCode !== 200) throw new Error(`Request ${n} answered ${reply.statusCode}.`);
    }
    const refused = await search(person.cookie, 'limite');

    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(textOf(refused)).not.toContain('limite');
  });

  it('counts per person and not per address: another person on the same address is not limited, and the person is limited in every agency', async () => {
    const limited = await freshAdmin('shared-a');
    const other = await freshAdmin('shared-b');
    for (let n = 0; n < 60; n += 1) await search(limited.cookie, 'ab');

    expect((await search(limited.cookie, 'ab')).statusCode).toBe(429);
    expect((await search(other.cookie, 'ab')).statusCode).toBe(200);
  });

  it('shares the one bucket between the agencies a person belongs to', async () => {
    const dual = await freshAdmin('dual-bucket');
    const admin = await knex()('roles').whereNull('agency_id').where({ key: 'admin' }).first('id');
    await knex()('agency_memberships').insert({ agency_id: w.agencyB, user_id: dual.id, role_id: admin!.id });
    for (let n = 0; n < 30; n += 1) {
      await search(dual.cookie, 'ab', w.agencyA);
      await search(dual.cookie, 'ab', w.agencyB);
    }

    expect((await search(dual.cookie, 'ab', w.agencyA)).statusCode).toBe(429);
    expect((await search(dual.cookie, 'ab', w.agencyB)).statusCode).toBe(429);
  });
});

describe('the photo of a client', () => {
  let admin: { id: string; cookie: string };

  beforeAll(async () => {
    admin = await freshAdmin('photo');
  });

  it('signs a photo that is exactly the avatar key of the client, and gives null to a key that is not, to no key, and to a signature the storage refuses', async () => {
    const own = await newClient('Foto Própria');
    await knex()('clients').where({ id: own }).update({ photo_key: `agencies/${w.agencyA}/clients/${own}/avatar/${randomUUID()}.png` });
    const foreign = await newClient('Foto Alheia');
    await knex()('clients').where({ id: foreign }).update({ photo_key: `agencies/${w.agencyA}/clients/${own}/avatar/${randomUUID()}.png` });
    const bare = await newClient('Foto Nenhuma');

    const data = await found(admin.cookie, 'foto');
    const photoOf = (id: string): string | null | undefined => data.clients.find((client) => client.id === id)?.photoUrl;

    expect(photoOf(own)).toMatch(/^https?:\/\//);
    expect(photoOf(foreign)).toBeNull();
    expect(photoOf(bare)).toBeNull();

    // The guard takes the agency id in any case, and the key is stored in lowercase: the scope comes from the row, not from the URL.
    const upper = await found(admin.cookie, 'foto', w.agencyA.toUpperCase() as typeof w.agencyA);
    expect(upper.clients.find((client) => client.id === own)?.photoUrl).toMatch(/^https?:\/\//);
    expect(upper.clients.find((client) => client.id === foreign)?.photoUrl).toBeNull();

    failPresign = true;
    try {
      const refused = await search(admin.cookie, 'foto');
      expect(refused.statusCode).toBe(200);
      expect(refused.json<Body>().data.clients.map((client) => client.photoUrl)).toEqual([null, null, null]);
    } finally {
      failPresign = false;
    }
  });
});

describe('the log', () => {
  it('never carries the term: not in the line of the request, not in the line of a refusal and not in the one of a failure', async () => {
    const person = await freshAdmin('log');
    const secret = 'ZZSEGREDO-do-cliente';
    const before = logs.lines().length;

    expect((await search(person.cookie, secret)).statusCode).toBe(200);
    expect((await search(person.cookie, `${secret}\u0001x`)).statusCode).toBe(400);
    expect((await search(person.cookie, secret.repeat(5))).statusCode).toBe(400);
    w.runBeforeStatement(/client\.photo_key/, async () => { throw Object.assign(new Error(`failed for ${secret}`), { code: '42501' }); });
    expect((await search(person.cookie, secret)).statusCode).toBe(403);
    w.runBeforeStatement(/client\.photo_key/, async () => { throw new Error(`unexpected ${secret}`); });
    expect((await search(person.cookie, secret)).statusCode).toBe(500);

    const written = logs.lines().slice(before).join('\n');
    expect(written).toContain('Request completed');
    expect(written).toContain('/agencies/:agencyId/search');
    expect(written).not.toContain(secret);
    expect(written).not.toContain('ZZSEGREDO');
    expect(written).not.toContain(encodeURIComponent(secret));
  });
});

describe('what the database may raise', () => {
  it('maps 42501 to 403, and a deadlock and a serialization failure to 409 TRY_AGAIN, never to 500, and says nothing of the error', async () => {
    const person = await freshAdmin('errors');
    const cases: Array<[string, number, string]> = [['42501', 403, 'FORBIDDEN'], ['40P01', 409, 'TRY_AGAIN'], ['40001', 409, 'TRY_AGAIN']];

    for (const group of [/client\.photo_key/, /public\.contents\b/, /public\.media_assets\b/]) {
      for (const [code, status, error] of cases) {
        w.runBeforeStatement(group, async () => { throw Object.assign(new Error('relation app_private.secret exploded'), { code }); });
        const reply = await search(person.cookie, 'erro');
        expect({ group: String(group), code, status: reply.statusCode, error: reply.json().error.code }).toEqual({ group: String(group), code, status, error });
        expect(textOf(reply)).not.toMatch(/app_private|exploded|relation/);
      }
    }
    expect((await search(person.cookie, 'erro')).statusCode).toBe(200);
  });
});

describe('the cost of the files query', () => {
  const VOLUME = 30_000;
  let admin: { id: string; cookie: string };

  // The statement of the files group as `ageniza_app` plans it, with the person bound, and never run: `searchAgency` is given a transaction
  // that asks for the plan instead of the rows.
  const planOfFiles = async (agencyId: string, term: string): Promise<string> => {
    let plan = '';
    await withAuthenticatedUserTransaction(w.getApp().database, createVerifiedUserClaims({ userId: admin.id }), async (transaction) => {
      const planner = {
        raw: async (statement: string, bindings: readonly unknown[]) => {
          const result = await transaction.raw<{ rows: Array<{ 'QUERY PLAN': string }> }>(`explain ${statement}`, bindings as never[]);
          plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
          return { rows: [] };
        }
      } as unknown as SearchTransaction;
      await searchAgency(planner, { agencyId, term, access: { clients: false, contents: false, files: true }, now: undefined });
    });
    return plan;
  };

  beforeAll(async () => {
    admin = await freshAdmin('plan');
    // Agency B holds the volume, on one client (a distribution the planner reads as "this client is most of the table"); the person is not in B.
    const big = await newClient('Cliente do Volume', { agencyId: w.agencyB });
    const folder = await w.folderOf(big);
    await knex().raw(`
      insert into public.media_assets (id, agency_id, client_id, folder_id, category, declared_content_type, extension, object_key, upload_object_key,
        declared_size_bytes, created_by_user_id, status, confirmed_size_bytes, confirmed_content_type, confirmed_at, file_name)
      select s.id, ?::uuid, ?::uuid, ?::uuid, 'image', 'image/png', 'png', ?::text || '/' || s.id || '/original.png', 'staging/' || ?::text || '/' || s.id || '/upload.png',
        1000, ?::uuid, 'confirmed', 1000, 'image/png', now(), 'volume-' || s.n
      from (select gen_random_uuid() as id, n from generate_series(1, ?::int) as n) as s
    `, [w.agencyB, big, folder, w.agencyB, w.agencyB, people.admin.id, VOLUME]);
    await newFile(await newClient('Cliente Pequeno'), 'volume-poucos.png');
    await knex().raw('analyze public.media_assets');
  });

  afterAll(async () => {
    await knex()('media_assets').where('file_name', 'like', 'volume-%').delete();
    await knex().raw('analyze public.media_assets');
  });

  it('plans the files of an agency by the index of the agency, never by a scan of the table that holds the files of every agency', async () => {
    const plan = await planOfFiles(w.agencyA, 'volume');

    expect(plan).not.toMatch(/Seq Scan on media_assets/);
    // Tied to the index of the protected table, by name: `clients` has an index by agency too, so a bare `agency_id = ` condition proves nothing. The planner reads that index plain or as a bitmap.
    expect(plan).toMatch(/(Index Scan using|Bitmap Index Scan on) media_assets_agency_status_idx/);
  });

  it('still finds the file of the agency while another agency holds the volume', async () => {
    expect(fileNames(await found(admin.cookie, 'volume'))).toEqual(['volume-poucos.png']);
  });
});

describe('the queries themselves, apart from the policies', () => {
  const POLICIES = [['clients', 'clients_select'], ['contents', 'contents_select'], ['media_assets', 'media_assets_select']] as const;

  // The three policies are made as permissive as they can be: whatever the route returns now, its own predicate and its own permission decided it.
  const withPoliciesOpen = async (run: () => Promise<void>): Promise<void> => {
    const saved = new Map<string, string>();
    for (const [table, name] of POLICIES) {
      const policy = (await knex().raw(`select qual from pg_policies where schemaname = 'public' and tablename = ? and policyname = ?`, [table, name])).rows[0]?.qual as string | undefined;
      expect(policy).toBeDefined();
      saved.set(name, policy!);
    }
    for (const [table, name] of POLICIES) await knex().raw(`alter policy ${name} on public.${table} using (true)`);
    try {
      await run();
    } finally {
      for (const [table, name] of POLICIES) await knex().raw(`alter policy ${name} on public.${table} using (${saved.get(name)!})`);
    }
  };

  beforeAll(async () => {
    const a = await newClient('Isolada Alfa');
    const b = await newClient('Isolada Beta', { agencyId: w.agencyB });
    await newContent(a, 'Isolada em A');
    await newContent(b, 'Isolada em B', { ownerUserId: people.adminB.id });
    await newFile(a, 'isolada-a.png');
    await newFile(b, 'isolada-b.png');
  });

  it('still gives the agency of the route and the permission of each group, though the policies would show the person every client, content and file of every agency', async () => {
    await withPoliciesOpen(async () => {
      const open = await knex().raw(`select count(*) as count from pg_policies where schemaname = 'public' and policyname in ('clients_select', 'contents_select', 'media_assets_select') and qual = 'true'`);
      expect(Number(open.rows[0].count)).toBe(3);

      const dualInA = await found(people.dual.cookie, 'isolada', w.agencyA);
      expect([clientNames(dualInA), titles(dualInA), fileNames(dualInA)]).toEqual([['Isolada Alfa'], ['Isolada em A'], ['isolada-a.png']]);
      const dualInB = await found(people.dual.cookie, 'isolada', w.agencyB);
      expect([clientNames(dualInB), titles(dualInB), fileNames(dualInB)]).toEqual([['Isolada Beta'], ['Isolada em B'], ['isolada-b.png']]);
      const ownerInA = await found(people.owner.cookie, 'isolada', w.agencyA);
      expect([clientNames(ownerInA), titles(ownerInA), fileNames(ownerInA)]).toEqual([['Isolada Alfa'], ['Isolada em A'], ['isolada-a.png']]);
      expect(clientNames(await found(p.people.crossDual.cookie, 'isolada', w.agencyB))).toEqual(['Isolada Beta']);

      // The permission of the group is the route's: the person who may read clients only still gets no content and no file.
      forget();
      expect(bodyOf(await search(people.sales.cookie, 'isolada')).data).toEqual({ clients: expect.any(Array), contents: [], files: [] });
      expect(ran()).toEqual({ clients: true, contents: false, files: false });
      forget();
      expect(bodyOf(await search(people.reader.cookie, 'isolada')).data.clients).toEqual([]);
      expect(ran().clients).toBe(false);
      expect(bodyOf(await search(people.operateOnly.cookie, 'isolada')).data).toEqual({ clients: [], contents: [], files: [] });

      // The guards are the route's too: the portal person and the stranger are still refused.
      expect((await search(p.people.portalOne.cookie, 'isolada')).statusCode).toBe(404);
      expect((await search(people.adminB.cookie, 'isolada', w.agencyA)).statusCode).toBe(404);
    });

    const restored = await knex().raw(`select count(*) as count from pg_policies where schemaname = 'public' and policyname in ('clients_select', 'contents_select', 'media_assets_select') and qual <> 'true'`);
    expect(Number(restored.rows[0].count)).toBe(3);
  });
});
