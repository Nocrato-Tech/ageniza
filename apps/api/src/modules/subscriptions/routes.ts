import {
  AgencyPathParamsSchema,
  SimulatedPaymentRequestSchema,
  SimulatedPaymentResponseSchema,
  SubscriptionChangeRequestSchema,
  SubscriptionChargePathParamsSchema,
  SubscriptionChargeResponseSchema,
  SubscriptionOverviewResponseSchema,
  SubscriptionPlansResponseSchema,
  SubscriptionQuoteResponseSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { ChargeResult, PaymentProvider } from '@ageniza/payments';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeParams, routeResponse } from '../../plugins/infra/zod.js';
import { chargeNotFound, chargeNotOpen, paymentProviderFailed, translateSubscriptionError } from './errors.js';
import { SUBSCRIPTION_PERMISSION, isProviderReference } from './policy.js';
import {
  confirmCharge,
  loadOwnCharge,
  loadPlans,
  loadSubscription,
  quoteChange,
  requestChange,
  runLifecycleOperation,
  type LifecycleOperation
} from './service.js';

export type SubscriptionPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface SubscriptionModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Injected by the tenancy module so this module never duplicates agency-access guard SQL. */
  readonly requireAgencyAccess: SubscriptionPreHandler;
  readonly requirePermission: (key: string) => SubscriptionPreHandler;
  /** `PAYMENTS_PROVIDER`: absent, nobody can pay and the routes of the simulated provider do not exist. */
  readonly paymentProvider?: PaymentProvider;
  /** The real production (not the dev environment): the simulated routes are left out there, besides the provider being refused at startup. */
  readonly production: boolean;
}

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });

const agencyNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

const params = { params: AgencyPathParamsSchema };
const changeParams = { ...params, body: SubscriptionChangeRequestSchema };

const plansDocs = { permission: SUBSCRIPTION_PERMISSION, responseStatus: 200, schemas: { ...params, response: SubscriptionPlansResponseSchema } } satisfies DocumentedRouteConfig;
const overviewDocs = { permission: SUBSCRIPTION_PERMISSION, responseStatus: 200, schemas: { ...params, response: SubscriptionOverviewResponseSchema } } satisfies DocumentedRouteConfig;
const quoteDocs = { permission: SUBSCRIPTION_PERMISSION, responseStatus: 200, schemas: { ...changeParams, response: SubscriptionQuoteResponseSchema } } satisfies DocumentedRouteConfig;
const chargeDocs = { permission: SUBSCRIPTION_PERMISSION, responseStatus: 201, schemas: { ...changeParams, response: SubscriptionChargeResponseSchema } } satisfies DocumentedRouteConfig;
const cancelDocs = { permission: SUBSCRIPTION_PERMISSION, responseStatus: 204, schemas: { ...params } } satisfies DocumentedRouteConfig;
const reactivateDocs = { permission: SUBSCRIPTION_PERMISSION, responseStatus: 204, schemas: { ...params } } satisfies DocumentedRouteConfig;
const advanceDocs = { permission: SUBSCRIPTION_PERMISSION, responseStatus: 204, schemas: { ...params } } satisfies DocumentedRouteConfig;
const simulatedPaymentDocs = {
  permission: SUBSCRIPTION_PERMISSION,
  responseStatus: 200,
  schemas: { params: SubscriptionChargePathParamsSchema, body: SimulatedPaymentRequestSchema, response: SimulatedPaymentResponseSchema }
} satisfies DocumentedRouteConfig;

/**
 * Billing of the agency (issue #772). Every route is for the Owner: `assinatura.gerenciar` is held by ownership alone, and the
 * database checks it again in each function. The plan and the ceilings change only in `confirmCharge`, and only after the provider
 * approved a charge the Owner opened. One transaction per call of the database: cancel, reactivate and advance take only the lock
 * of the agency, so none of them may share a transaction with a request or a confirmation, which take the storage lock first.
 */
export const registerSubscriptionModule = (app: FastifyInstance, dependencies: SubscriptionModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const guards = (docs: DocumentedRouteConfig): SubscriptionPreHandler[] => [
    requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(docs.permission as string)
  ];
  const tenantOf = (request: FastifyRequest): { auth: NonNullable<FastifyRequest['auth']>; agencyId: string } => {
    const auth = requireAuth(request);
    if (request.tenant === undefined) throw agencyNotFound();
    return { auth, agencyId: request.tenant.agencyId };
  };
  // Runs the work as the person, in a transaction of its own, with the database's refusals translated.
  const asOwner = async <TResult>(
    request: FastifyRequest,
    work: (transaction: Parameters<Parameters<DatabaseClient['transaction']>[0]>[0], agencyId: string) => Promise<TResult>
  ): Promise<TResult> => {
    const { auth, agencyId } = tenantOf(request);
    try {
      return await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) => work(transaction, agencyId));
    } catch (error) {
      throw translateSubscriptionError(error) ?? error;
    }
  };
  const lifecycle = (path: string, docs: typeof cancelDocs, operation: LifecycleOperation): void => {
    app.post(`/agencies/:agencyId/subscription/${path}`, { preHandler: guards(docs), config: docs }, async (request, reply) => {
      routeParams(docs, request);
      await asOwner(request, (transaction, agencyId) => runLifecycleOperation(transaction, agencyId, operation));
      return reply.status(204).send();
    });
  };

  app.get('/agencies/:agencyId/subscription/plans', { preHandler: guards(plansDocs), config: plansDocs }, async (request, reply) => {
    routeParams(plansDocs, request);
    const plans = await asOwner(request, (transaction) => loadPlans(transaction));
    return reply.send(routeResponse(plansDocs, request, plans));
  });

  app.get('/agencies/:agencyId/subscription', { preHandler: guards(overviewDocs), config: overviewDocs }, async (request, reply) => {
    routeParams(overviewDocs, request);
    const subscription = await asOwner(request, (transaction, agencyId) => loadSubscription(transaction, agencyId));
    return reply.send(routeResponse(overviewDocs, request, { subscription, paymentProvider: dependencies.paymentProvider?.name ?? null }));
  });

  app.post('/agencies/:agencyId/subscription/quote', { preHandler: guards(quoteDocs), config: quoteDocs }, async (request, reply) => {
    routeParams(quoteDocs, request);
    const change = routeBody(quoteDocs, request);
    const quote = await asOwner(request, (transaction, agencyId) => quoteChange(transaction, agencyId, change));
    return reply.send(routeResponse(quoteDocs, request, quote));
  });

  app.post('/agencies/:agencyId/subscription/charges', { preHandler: guards(chargeDocs), config: chargeDocs }, async (request, reply) => {
    routeParams(chargeDocs, request);
    const change = routeBody(chargeDocs, request);
    const charge = await asOwner(request, (transaction, agencyId) => requestChange(transaction, agencyId, change));
    return reply.status(201).send(routeResponse(chargeDocs, request, charge));
  });

  lifecycle('cancel', cancelDocs, 'cancel_subscription');
  lifecycle('reactivate', reactivateDocs, 'reactivate_subscription');

  const provider = dependencies.paymentProvider;
  if (provider === undefined || provider.name !== 'simulado' || dependencies.production) return;

  lifecycle('simulated-period-advance', advanceDocs, 'advance_simulated_period');

  app.post('/agencies/:agencyId/subscription/charges/:chargeId/simulated-payment', {
    preHandler: guards(simulatedPaymentDocs), config: simulatedPaymentDocs
  }, async (request, reply) => {
    const { chargeId } = routeParams(simulatedPaymentDocs, request);
    const { outcome } = routeBody(simulatedPaymentDocs, request);

    // First transaction, as the person: the charge has to be one of this agency's, read under the policy that lets only its Owner see it.
    // The confirmation below runs with nobody bound and takes the charge id on trust, so this is the only place that ties them.
    const charge = await asOwner(request, (transaction, agencyId) => loadOwnCharge(transaction, agencyId, chargeId));
    if (charge === undefined) throw chargeNotFound();
    if (charge.status !== 'pending') throw chargeNotOpen();

    let result: ChargeResult;
    try {
      result = await provider.charge({ idempotencyKey: charge.id, amountCents: charge.amountCents, reference: charge.id, testOutcome: outcome });
    } catch {
      throw paymentProviderFailed();
    }
    if (result.status === 'declined') return reply.send(routeResponse(simulatedPaymentDocs, request, { status: 'declined' }));
    if (!isProviderReference(result.providerRef)) throw paymentProviderFailed();

    // Second transaction, with nobody bound: the database refuses a confirmation that comes with a person.
    try {
      await dependencies.database.transaction((transaction) => confirmCharge(transaction, {
        chargeId: charge.id, provider: provider.name, providerRef: result.providerRef, paidCents: result.paidCents
      }));
    } catch (error) {
      throw translateSubscriptionError(error) ?? error;
    }
    return reply.send(routeResponse(simulatedPaymentDocs, request, { status: 'confirmed' }));
  });
};
