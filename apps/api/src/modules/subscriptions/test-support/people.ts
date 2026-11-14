import { randomUUID } from 'node:crypto';

import type { Person, World } from './world.js';

/** Everybody who must read and write nothing of an agency's billing, as the guards of the routes see them. */
export interface BillingPeople {
  /** Agency members: the route is refused for their role, 403. */
  readonly members: ReadonlyArray<{ readonly who: string; readonly person: Person }>;
  /** Not members of the agency: the guard answers as if it did not exist, 404. */
  readonly strangers: ReadonlyArray<{ readonly who: string; readonly person: Person }>;
  /** The Owner of another agency, who is also a person of a client of this one. */
  readonly crossDual: Person;
  readonly otherAgencyId: string;
  cleanUp(): Promise<void>;
}

/** Builds them around `agencyId`: Admin, roles without the permission, the portal person, the dual ones and the neighbours. */
export const buildBillingPeople = async (world: World, agencyId: string, label: string): Promise<BillingPeople> => {
  const clientId = randomUUID();
  await world.owner.knex('clients').insert({ id: clientId, agency_id: agencyId, name: `Cliente ${clientId.slice(0, 8)}` });
  const linkToClient = async (person: Person): Promise<void> => {
    await world.owner.knex('client_memberships').insert({ client_id: clientId, user_id: person.user.id });
  };

  const admin = await world.person(`${label}-admin`);
  await world.withRole(agencyId, admin.user.id, 'admin');

  const oneOther = await world.person(`${label}-one`);
  await world.withPermissions(agencyId, oneOther.user.id, 'cliente.operar');

  const everythingElse = await world.person(`${label}-wide`);
  const keys = (await world.owner.knex('permissions').whereNot({ key: 'assinatura.gerenciar' }).select('key')).map((row: { key: string }) => row.key);
  await world.withPermissions(agencyId, everythingElse.user.id, ...keys);

  const dual = await world.person(`${label}-dual`);
  await world.withRole(agencyId, dual.user.id, 'admin');
  await linkToClient(dual);

  const dualBare = await world.person(`${label}-dualbare`);
  await world.withPermissions(agencyId, dualBare.user.id, 'midia.enviar');
  await linkToClient(dualBare);

  const portal = await world.person(`${label}-portal`);
  await linkToClient(portal);

  const outsider = await world.person(`${label}-outsider`);

  const crossDual = await world.person(`${label}-cross`);
  const otherAgencyId = await world.agency(crossDual);
  await linkToClient(crossDual);

  return {
    members: [
      { who: 'admin', person: admin },
      { who: 'a role with one other permission', person: oneOther },
      { who: 'a role with every other permission', person: everythingElse },
      { who: 'dual (admin and person of a client)', person: dual },
      { who: 'dualBare (a role with no client permission and a client link)', person: dualBare }
    ],
    strangers: [
      { who: 'person of the portal', person: portal },
      { who: 'nobody of the agency', person: outsider },
      { who: 'crossDual (Owner of another agency, person of a client of this one)', person: crossDual }
    ],
    crossDual,
    otherAgencyId,
    cleanUp: async () => {
      await world.owner.knex('client_memberships').where({ client_id: clientId }).delete();
    }
  };
};
