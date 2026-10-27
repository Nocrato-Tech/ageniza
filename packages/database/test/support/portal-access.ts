import type { Knex } from 'knex';

/**
 * Removes or reactivates the portal access of an account the way the owner of the database may (a fixture): the access first, then
 * its membership, in one transaction. The state of `client_memberships` follows the access (issue #711), so a test that moves only
 * the membership is refused; the function the application uses (`app_private.remove_client_portal_access`) needs an actor with a
 * permission, which a fixture does not have.
 */
export const setPortalAccessStatus = async (
  knex: Knex,
  clientId: string,
  userId: string,
  status: 'active' | 'removed'
): Promise<void> => {
  await knex.transaction(async (transaction) => {
    const access = await transaction('client_portal_accesses').where({ client_id: clientId, user_id: userId }).first('id', 'status');
    if (access === undefined) throw new Error(`No portal access of ${userId} in ${clientId}.`);
    if (access.status !== status) {
      await transaction('client_portal_accesses')
        .where({ id: access.id })
        .update(status === 'removed' ? { status, generation: transaction.raw('generation + 1') } : { status });
    }
    await transaction('client_memberships').where({ client_id: clientId, user_id: userId }).update({ status });
  });
};
