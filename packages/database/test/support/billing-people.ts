import type { Harness } from './subscriptions.js';

// The people a billing test attacks from: the Owner of an agency, and everybody who must read and write nothing of its billing. `assinatura.gerenciar`
// is held by the Owner by ownership and by no role, so each of the others has some other claim on the agency (a role, a link to a client, another
// agency) that a looser rule would wrongly honor.
export interface BillingWorld {
  readonly agencyId: string;
  readonly ownerId: string;
  /** Another agency with its own Owner, who is also a person of a client of `agencyId`. */
  readonly other: { readonly agencyId: string; readonly ownerId: string };
  readonly clientId: string;
  readonly denied: ReadonlyArray<{ readonly who: string; readonly user: string | undefined }>;
  cleanUp(): Promise<void>;
}

export const buildBillingWorld = async (h: Harness): Promise<BillingWorld> => {
  const { agencyId, ownerId } = await h.trialAgency();
  const other = await h.trialAgency();
  const clientId = await h.insertClient(ownerId, agencyId);
  const linked: string[] = [];
  const link = async (user: string, status: 'active' | 'removed' = 'active'): Promise<string> => {
    await h.owner()('client_memberships').insert({ client_id: clientId, user_id: user, status });
    linked.push(user);
    return user;
  };

  const admin = await h.withRole(agencyId, 'admin');
  const wide = await h.withPermissions(agencyId, 'cliente.visualizar', 'conteudo.visualizar', 'colaborador.visualizar');
  const oneKey = await h.withPermissions(agencyId, 'colaborador.visualizar');
  const removed = await h.withRole(agencyId, 'admin');
  await h.owner()('agency_memberships').where({ agency_id: agencyId, user_id: removed }).update({ status: 'removed' });
  const portal = await link(await h.person());
  const removedFromPortal = await link(await h.person(), 'removed');
  const dual = await link(await h.withRole(agencyId, 'admin'));
  await link(other.ownerId);

  return {
    agencyId,
    ownerId,
    other,
    clientId,
    denied: [
      { who: 'an Admin', user: admin },
      { who: 'a role with three other permissions', user: wide },
      { who: 'a role with one other permission', user: oneKey },
      { who: 'a collaborator whose link was removed', user: removed },
      { who: 'a person of the portal', user: portal },
      { who: 'a person whose link to the client was removed', user: removedFromPortal },
      { who: 'a collaborator who is also a client\'s person', user: dual },
      { who: 'the Owner of another agency who is a client\'s person here', user: other.ownerId },
      { who: 'nobody bound to the transaction', user: undefined }
    ],
    cleanUp: async () => {
      await h.owner()('client_memberships').whereIn('user_id', linked).delete();
    }
  };
};
