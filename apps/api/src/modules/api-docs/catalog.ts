import type { z } from 'zod';

import {
  AgencyClientPathParamsSchema,
  AgencyCollaboratorPathParamsSchema,
  AgencyInvitationPathParamsSchema,
  AgencyMeResponseSchema,
  AgencyMediaAssetPathParamsSchema,
  AgencyPathParamsSchema,
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  AuthPasswordForgotRequestSchema,
  AuthPasswordForgotResponseSchema,
  AuthPasswordResetRequestSchema,
  AuthPasswordResetResponseSchema,
  AuthSessionResponseSchema,
  ClientInvitationRequestSchema,
  ClientPathParamsSchema,
  CollaboratorInvitationRequestSchema,
  CollaboratorListQuerySchema,
  CollaboratorListResponseSchema,
  CollaboratorSchema,
  CompleteMediaUploadRequestSchema,
  CompleteMediaUploadResponseSchema,
  ContextResolveQuerySchema,
  ContextResolveResponseSchema,
  CreateMediaUploadRequestSchema,
  CreateMediaUploadResponseSchema,
  HealthResponseSchema,
  InvitationAcceptNewAccountRequestSchema,
  InvitationAcceptNewAccountResponseSchema,
  InvitationAcceptResponseSchema,
  InvitationCreatedResponseSchema,
  InvitationPreviewResponseSchema,
  MeContextsResponseSchema,
  MediaDownloadUrlQuerySchema,
  MediaDownloadUrlResponseSchema,
  PaginationInputSchema,
  PendingInvitationListResponseSchema,
  PublicInvitationTokenPathParamsSchema,
  PutLastContextRequestSchema,
  ReactivateCollaboratorRequestSchema,
  RequestMediaUploadPartsRequestSchema,
  RequestMediaUploadPartsResponseSchema
} from '@ageniza/contracts';

/**
 * The single source of the generated API documentation (issue #182). Every route registered in
 * `apps/api` has exactly one entry here; `api-docs.integration.test.ts` builds the real app and
 * fails when the two lists diverge, so a new route without documentation cannot pass CI.
 *
 * Request, path and response schemas are imported from `@ageniza/contracts` -- the same objects
 * the routes validate with -- never restated. Examples are fictional and validated against their
 * schema at generation time; secret-shaped values are angle-bracket placeholders on purpose.
 */

export type ApiModule = 'system' | 'auth' | 'invitations' | 'contexts' | 'agencies' | 'collaborators' | 'media';

export type HttpMethod = 'get' | 'post' | 'put' | 'delete';

export interface ApiErrorDoc {
  readonly status: number;
  readonly code: string;
  /** Overrides the default message for the code in examples; the API varies it per resource. */
  readonly message?: string;
}

export interface ApiSuccessDoc {
  readonly status: number;
  readonly description: string;
  /** Absent for 204; every body is the same schema the route validates its response with. */
  readonly schema?: z.ZodTypeAny;
  readonly example?: unknown;
}

export interface DocumentedRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly module: ApiModule;
  readonly summary: string;
  readonly description: string;
  readonly access: string;
  /** Named permission `requirePermission` demands, or null when the route has none. */
  readonly permission: string | null;
  // Path and query schemas are always strict objects, which is what the OpenAPI registry accepts
  // as route parameters; a body may be any schema (a discriminated union, for instance).
  readonly params?: z.AnyZodObject;
  readonly query?: z.AnyZodObject;
  readonly body?: z.ZodTypeAny;
  /** Validated against `body` (or `query` when there is no body) during generation. */
  readonly requestExample?: unknown;
  readonly responses: readonly ApiSuccessDoc[];
  readonly errors: readonly ApiErrorDoc[];
}

export const API_DOCUMENT_INFO = {
  title: 'API do Ageniza',
  version: '0.1.0',
  description: [
    'API HTTP do Ageniza. A sessão é um cookie httpOnly emitido por `POST /auth/login`;',
    'as rotas autenticadas usam esse cookie e nunca um token no corpo ou na URL.',
    'Erros seguem o mesmo corpo: `{ error: { code, message }, meta: { requestId } }`.',
    'A permissão exigida por cada rota aparece na extensão `x-permission` e no resumo em Markdown.'
  ].join('\n')
} as const;

export const MODULE_DESCRIPTIONS: Record<ApiModule, string> = {
  system: 'Saúde e prontidão do processo.',
  auth: 'Login, sessão, logout e recuperação de senha.',
  invitations: 'Convite de colaborador e de pessoa do portal, aceite e administração dos pendentes.',
  contexts: 'Listagem, resolução e troca de contexto, e o primeiro acesso ao portal do cliente.',
  agencies: 'Dados do contexto de agência, incluindo as permissões efetivas.',
  collaborators: 'A equipe da agência: listagem com paginação, busca e filtros.',
  media: 'Upload direto ao armazenamento, confirmação e URLs assinadas de mídia.'
};

export const ERROR_MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'Request validation failed',
  UNAUTHENTICATED: 'Authentication is required.',
  SESSION_EXPIRED: 'Session has expired.',
  INVALID_CREDENTIALS: 'Credenciais inválidas.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  NO_CONTEXT_ACCESS: 'Sua conta não tem acesso a nenhum espaço de trabalho. Fale com quem administra a agência para receber um convite.',
  NOT_FOUND: 'Resource not found.',
  CSRF_REJECTED: 'Request origin is not allowed',
  PAYLOAD_TOO_LARGE: 'Request payload is too large',
  RATE_LIMITED: 'Too many requests',
  NOT_READY: 'Service is not ready',
  INTERNAL_ERROR: 'An unexpected error occurred',
  INVALID_LINK: 'Este link não é mais válido.',
  ACCOUNT_EXISTS: 'Já existe uma conta para este endereço.',
  INVITATION_ACCOUNT_MISMATCH: 'A conta autenticada não corresponde ao convite.',
  INVITATION_NOT_PENDING: 'O convite não está pendente.',
  MEMBERSHIP_EXISTS: 'Este endereço já possui o vínculo solicitado.',
  INVALID_ROLE: 'O papel informado não é válido para esta agência.',
  EMAIL_DELIVERY_FAILED: 'Não foi possível entregar o e-mail.',
  QUOTA_EXCEEDED: 'This agency has reached its storage quota.',
  UPLOAD_NOT_PENDING: 'This upload is not pending confirmation.',
  UNSUPPORTED_MEDIA_TYPE: 'This content type is not accepted.',
  UPLOAD_REJECTED: 'The uploaded object was rejected.',
  VARIANT_NOT_READY: 'This variant has not been generated yet.',
  VARIANT_PROCESSING_FAILED: 'Video processing failed.'
};

/** Global middlewares every route inherits; documented per route so the OpenAPI matches reality. */
export const COMMON_ERRORS = {
  internal: { status: 500, code: 'INTERNAL_ERROR' },
  csrf: { status: 403, code: 'CSRF_REJECTED' },
  payloadTooLarge: { status: 413, code: 'PAYLOAD_TOO_LARGE' }
} as const satisfies Record<string, ApiErrorDoc>;

const agencyId = '11111111-1111-4111-8111-111111111111';
const membershipId = '22222222-2222-4222-8222-222222222222';
const invitationId = '33333333-3333-4333-8333-333333333333';
const assetId = '44444444-4444-4444-8444-444444444444';
const userId = '55555555-5555-4555-8555-555555555555';
const roleId = '66666666-6666-4666-8666-666666666666';

const agencyContextExample = {
  type: 'agency',
  agencyId,
  agencyName: 'Agência Exemplo',
  roleKey: 'admin',
  roleName: 'Admin',
  isOwner: true
} as const;

const signedStorageUrl = 'https://storage.exemplo.test/arquivo.png?assinatura=ficticia';

export const DOCUMENTED_ROUTES: readonly DocumentedRoute[] = [
  {
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    module: 'system',
    summary: 'Verifica se o processo está vivo',
    description: 'Responde sempre que o processo HTTP está de pé, sem checar dependências.',
    access: 'Público',
    permission: null,
    responses: [{ status: 200, description: 'Processo vivo.', schema: HealthResponseSchema, example: { status: 'ok' } }],
    errors: []
  },
  {
    method: 'get',
    path: '/ready',
    operationId: 'getReadiness',
    module: 'system',
    summary: 'Verifica se a API está pronta para receber tráfego',
    description: 'Checa as dependências configuradas; qualquer falha vira 503.',
    access: 'Público',
    permission: null,
    responses: [{ status: 200, description: 'Pronta.', schema: HealthResponseSchema, example: { status: 'ok' } }],
    errors: [{ status: 503, code: 'NOT_READY' }]
  },

  {
    method: 'post',
    path: '/auth/login',
    operationId: 'postAuthLogin',
    module: 'auth',
    summary: 'Autentica com e-mail e senha',
    description: [
      'Credencial correta sem nenhum contexto não cria sessão e responde 403 `NO_CONTEXT_ACCESS`,',
      'salvo quando o corpo traz um `inviteToken` válido para o mesmo e-mail.'
    ].join('\n'),
    access: 'Público',
    permission: null,
    body: AuthLoginRequestSchema,
    requestExample: { email: 'dono@exemplo.test', password: '<senha-do-exemplo>' },
    responses: [{
      status: 200,
      description: 'Sessão criada; o cookie httpOnly vem na resposta.',
      schema: AuthLoginResponseSchema,
      example: { user: { id: userId, name: 'Dono da Agência', email: 'dono@exemplo.test' } }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'INVALID_CREDENTIALS' },
      { status: 403, code: 'NO_CONTEXT_ACCESS' },
      { status: 429, code: 'RATE_LIMITED' }
    ]
  },
  {
    method: 'post',
    path: '/auth/logout',
    operationId: 'postAuthLogout',
    module: 'auth',
    summary: 'Encerra a sessão atual',
    description: 'Revoga a sessão do cookie da requisição e limpa o cookie.',
    access: 'Sessão',
    permission: null,
    responses: [{ status: 204, description: 'Sessão encerrada.' }],
    errors: [COMMON_ERRORS.csrf, COMMON_ERRORS.internal, { status: 401, code: 'UNAUTHENTICATED' }]
  },
  {
    method: 'post',
    path: '/auth/logout-all',
    operationId: 'postAuthLogoutAll',
    module: 'auth',
    summary: 'Encerra todas as sessões da conta',
    description: 'Revoga todas as sessões da pessoa autenticada, inclusive a atual.',
    access: 'Sessão',
    permission: null,
    responses: [{ status: 204, description: 'Todas as sessões encerradas.' }],
    errors: [COMMON_ERRORS.csrf, COMMON_ERRORS.internal, { status: 401, code: 'UNAUTHENTICATED' }]
  },
  {
    method: 'get',
    path: '/auth/session',
    operationId: 'getAuthSession',
    module: 'auth',
    summary: 'Devolve a sessão e a pessoa autenticada',
    description: 'Usado pelo cliente para saber se a sessão continua válida e quando expira.',
    access: 'Sessão',
    permission: null,
    responses: [{
      status: 200,
      description: 'Sessão válida.',
      schema: AuthSessionResponseSchema,
      example: {
        user: { id: userId, name: 'Dono da Agência', email: 'dono@exemplo.test' },
        session: { expiresAt: '2026-10-01T12:00:00.000Z' }
      }
    }],
    errors: [COMMON_ERRORS.internal, { status: 401, code: 'UNAUTHENTICATED' }, { status: 401, code: 'SESSION_EXPIRED' }]
  },
  {
    method: 'post',
    path: '/auth/password/forgot',
    operationId: 'postAuthPasswordForgot',
    module: 'auth',
    summary: 'Pede o link de recuperação de senha',
    description: 'Responde igual exista ou não a conta, para não virar oráculo de e-mail.',
    access: 'Público',
    permission: null,
    body: AuthPasswordForgotRequestSchema,
    requestExample: { email: 'dono@exemplo.test' },
    responses: [{ status: 202, description: 'Pedido aceito.', schema: AuthPasswordForgotResponseSchema, example: {} }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 429, code: 'RATE_LIMITED' }
    ]
  },
  {
    method: 'post',
    path: '/auth/password/reset',
    operationId: 'postAuthPasswordReset',
    module: 'auth',
    summary: 'Redefine a senha e tenta autenticar de volta',
    description: [
      'A senha é sempre trocada e todas as sessões antigas encerradas. Com contexto confirmado,',
      'a resposta é `signedIn: true`; com zero contextos confirmados, `signedIn: false` e',
      '`reason: NO_CONTEXT_ACCESS`; se a sessão não puder ser criada por outro motivo,',
      '`signedIn: false` e `reason: SIGN_IN_REQUIRED`.'
    ].join('\n'),
    access: 'Público',
    permission: null,
    body: AuthPasswordResetRequestSchema,
    requestExample: { token: '<token-do-exemplo>', newPassword: '<nova-senha-do-exemplo>' },
    responses: [{
      status: 200,
      description: 'Senha redefinida; a sessão depende do resultado.',
      schema: AuthPasswordResetResponseSchema,
      example: { signedIn: true }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'INVALID_LINK' },
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 429, code: 'RATE_LIMITED' }
    ]
  },

  {
    method: 'get',
    path: '/agencies/:agencyId/invitations',
    operationId: 'listPendingCollaboratorInvitations',
    module: 'invitations',
    summary: 'Lista os convites de colaborador pendentes',
    description: 'Paginado pelo contrato global de listagem; nunca devolve o token, só o hash existe no banco.',
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.convidar',
    params: AgencyPathParamsSchema,
    query: PaginationInputSchema,
    requestExample: { page: 1, pageSize: 20 },
    responses: [{
      status: 200,
      description: 'Página de convites pendentes.',
      schema: PendingInvitationListResponseSchema,
      example: {
        data: [{
          id: invitationId,
          email: 'colaborador@exemplo.test',
          purpose: 'collaborator_invite',
          role: { key: 'production', name: 'Produção' },
          client: null,
          createdAt: '2026-09-25T12:00:00.000Z',
          expiresAt: '2026-10-02T12:00:00.000Z'
        }],
        meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 }
      }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/invitations/collaborators',
    operationId: 'createCollaboratorInvitation',
    module: 'invitations',
    summary: 'Convida uma pessoa para a agência',
    description: 'O papel vem preso ao convite; o e-mail sai pelo serviço de e-mail e o token só existe nele.',
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.convidar',
    params: AgencyPathParamsSchema,
    body: CollaboratorInvitationRequestSchema,
    requestExample: { email: 'colaborador@exemplo.test', roleId },
    responses: [{
      status: 201,
      description: 'Convite criado e enviado.',
      schema: InvitationCreatedResponseSchema,
      example: { invitationId, expiresAt: '2026-10-02T12:00:00.000Z' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'INVALID_ROLE' },
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' },
      { status: 409, code: 'MEMBERSHIP_EXISTS' },
      { status: 502, code: 'EMAIL_DELIVERY_FAILED' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/invitations',
    operationId: 'createClientInvitation',
    module: 'invitations',
    summary: 'Convida uma pessoa para o portal de um cliente',
    description: 'Cria o vínculo de portal, que é independente do vínculo de colaborador.',
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.convidar_usuario',
    params: AgencyClientPathParamsSchema,
    body: ClientInvitationRequestSchema,
    requestExample: { email: 'pessoa@exemplo.test' },
    responses: [{
      status: 201,
      description: 'Convite criado e enviado.',
      schema: InvitationCreatedResponseSchema,
      example: { invitationId, expiresAt: '2026-10-02T12:00:00.000Z' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'MEMBERSHIP_EXISTS' },
      { status: 502, code: 'EMAIL_DELIVERY_FAILED' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/invitations/:invitationId/resend',
    operationId: 'resendInvitation',
    module: 'invitations',
    summary: 'Reenvia um convite pendente',
    description: 'Revoga o convite atual e cria outro com token novo, para o link antigo deixar de valer.',
    access: 'Sessão + vínculo com a agência',
    permission: 'convite.reenviar',
    params: AgencyInvitationPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Convite reenviado.',
      schema: InvitationCreatedResponseSchema,
      example: { invitationId, expiresAt: '2026-10-02T12:00:00.000Z' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Invitation not found.' },
      { status: 409, code: 'INVITATION_NOT_PENDING' },
      { status: 502, code: 'EMAIL_DELIVERY_FAILED' }
    ]
  },
  {
    method: 'delete',
    path: '/agencies/:agencyId/invitations/:invitationId',
    operationId: 'cancelInvitation',
    module: 'invitations',
    summary: 'Cancela um convite pendente',
    description: 'Marca o convite como revogado; o link deixa de valer imediatamente.',
    access: 'Sessão + vínculo com a agência',
    permission: 'convite.cancelar',
    params: AgencyInvitationPathParamsSchema,
    responses: [{ status: 204, description: 'Convite cancelado.' }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Invitation not found.' },
      { status: 409, code: 'INVITATION_NOT_PENDING' }
    ]
  },
  {
    method: 'get',
    path: '/invitations/:token',
    operationId: 'getInvitationPreview',
    module: 'invitations',
    summary: 'Mostra o convite antes do aceite',
    description: 'Token inválido, usado, expirado ou revogado devolvem o mesmo 410 `INVALID_LINK`, sem dizer qual.',
    access: 'Token do convite',
    permission: null,
    params: PublicInvitationTokenPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Convite válido.',
      schema: InvitationPreviewResponseSchema,
      example: {
        purpose: 'collaborator_invite',
        email: 'pessoa@exemplo.test',
        agency: { name: 'Agência Exemplo' },
        client: null,
        accountExists: true
      }
    }],
    errors: [COMMON_ERRORS.internal, { status: 410, code: 'INVALID_LINK' }]
  },
  {
    method: 'post',
    path: '/invitations/:token/accept-new-account',
    operationId: 'acceptInvitationNewAccount',
    module: 'invitations',
    summary: 'Cria a conta e aceita o convite',
    description: 'A conta nasce com o e-mail do convite, verificado, e a sessão já vem no cookie da resposta.',
    access: 'Token do convite',
    permission: null,
    params: PublicInvitationTokenPathParamsSchema,
    body: InvitationAcceptNewAccountRequestSchema,
    requestExample: { name: 'Pessoa Convidada', password: '<senha-do-exemplo>', acceptTerms: true },
    responses: [{
      status: 201,
      description: 'Conta criada, convite aceito e sessão iniciada.',
      schema: InvitationAcceptNewAccountResponseSchema,
      example: { status: 'accepted', context: { agencyId, clientId: null } }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 409, code: 'ACCOUNT_EXISTS' },
      { status: 410, code: 'INVALID_LINK' }
    ]
  },
  {
    method: 'post',
    path: '/invitations/:token/accept',
    operationId: 'acceptInvitation',
    module: 'invitations',
    summary: 'Aceita o convite com a conta já autenticada',
    description: 'O e-mail da conta precisa ser o mesmo do convite; `already_member` não é erro.',
    access: 'Sessão + token do convite',
    permission: null,
    params: PublicInvitationTokenPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Convite aceito ou vínculo já existente.',
      schema: InvitationAcceptResponseSchema,
      example: { status: 'accepted', context: { agencyId, clientId: null } }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'INVITATION_ACCOUNT_MISMATCH' },
      { status: 410, code: 'INVALID_LINK' }
    ]
  },

  {
    method: 'get',
    path: '/me/contexts',
    operationId: 'listMyContexts',
    module: 'contexts',
    summary: 'Lista os contextos válidos da pessoa',
    description: 'Traz agências e portais de cliente ativos, já ordenados pela regra do resolve.',
    access: 'Sessão',
    permission: null,
    responses: [{
      status: 200,
      description: 'Contextos válidos.',
      schema: MeContextsResponseSchema,
      example: { contexts: [agencyContextExample] }
    }],
    errors: [COMMON_ERRORS.internal, { status: 401, code: 'UNAUTHENTICATED' }]
  },
  {
    method: 'get',
    path: '/me/contexts/resolve',
    operationId: 'resolveMyContext',
    module: 'contexts',
    summary: 'Resolve em qual contexto entrar',
    description: [
      '`none` encerra a sessão quando não há contexto algum; `enter` traz o contexto único (ou o',
      'último usado); `select` traz a lista para escolher. Um `preferred` inválido é ignorado em',
      'silêncio, nunca vira 400.'
    ].join('\n'),
    access: 'Sessão',
    permission: null,
    query: ContextResolveQuerySchema,
    requestExample: { preferred: `agency:${agencyId}` },
    responses: [{
      status: 200,
      description: 'Decisão de contexto.',
      schema: ContextResolveResponseSchema,
      example: { decision: 'enter', context: agencyContextExample }
    }],
    errors: [COMMON_ERRORS.internal, { status: 401, code: 'UNAUTHENTICATED' }]
  },
  {
    method: 'put',
    path: '/me/last-context',
    operationId: 'putMyLastContext',
    module: 'contexts',
    summary: 'Grava o último contexto usado',
    description: 'Não recria a sessão; o contexto continua vindo da rota a cada requisição.',
    access: 'Sessão',
    permission: null,
    body: PutLastContextRequestSchema,
    requestExample: { type: 'agency', agencyId },
    responses: [{ status: 204, description: 'Preferência gravada.' }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Context not found.' }
    ]
  },
  {
    method: 'post',
    path: '/clients/:clientId/onboarding/seen',
    operationId: 'markClientOnboardingSeen',
    module: 'contexts',
    summary: 'Marca o primeiro acesso ao portal do cliente',
    description: 'Idempotente: só a primeira chamada grava.',
    access: 'Sessão + vínculo com o cliente',
    permission: null,
    params: ClientPathParamsSchema,
    responses: [{ status: 204, description: 'Registrado.' }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' }
    ]
  },

  {
    method: 'get',
    path: '/agencies/:agencyId/me',
    operationId: 'getAgencyMe',
    module: 'agencies',
    summary: 'Devolve as permissões efetivas do contexto de agência',
    description: [
      'O Owner recebe todas as chaves do catálogo por posse; os demais recebem as chaves do papel',
      'do vínculo ativo, restritas à agência. É só UX: toda operação continua validada pela guarda',
      'e pela RLS, então forjar esta lista não concede nada.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: null,
    params: AgencyPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Permissões efetivas.',
      schema: AgencyMeResponseSchema,
      example: {
        agencyId,
        agencyName: 'Agência Exemplo',
        isOwner: false,
        role: { key: 'admin', name: 'Admin' },
        permissions: ['cliente.visualizar', 'colaborador.visualizar', 'midia.enviar']
      }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' }
    ]
  },

  {
    method: 'get',
    path: '/agencies/:agencyId/collaborators',
    operationId: 'listCollaborators',
    module: 'collaborators',
    summary: 'Lista a equipe da agência',
    description: [
      'Paginada pelo contrato global de listagem, com busca por nome e e-mail e filtros por papel,',
      'cargo e status. A lista é a mesma para todos os papéis; a foto vem como URL assinada. Pedir',
      '`status=removed` exige a permissão administrativa de remover ou reativar.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.visualizar',
    params: AgencyPathParamsSchema,
    query: CollaboratorListQuerySchema,
    requestExample: { page: 1, pageSize: 24, q: 'camila', role: 'account_manager', status: 'active' },
    responses: [{
      status: 200,
      description: 'Página da equipe.',
      schema: CollaboratorListResponseSchema,
      example: {
        data: [{
          membershipId,
          name: 'Camila Nogueira',
          email: 'camila@exemplo.test',
          photoUrl: signedStorageUrl,
          jobTitle: 'Gestora de contas',
          role: { key: 'account_manager', name: 'Gestor de conta' },
          isOwner: false,
          status: 'active',
          joinedAt: '2026-03-12T12:00:00.000Z'
        }],
        meta: { page: 1, pageSize: 24, totalItems: 1, totalPages: 1 }
      }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' }
    ]
  },

  {
    method: 'get',
    path: '/agencies/:agencyId/collaborators/:membershipId',
    operationId: 'getCollaborator',
    module: 'collaborators',
    summary: 'Devolve um colaborador da agência',
    description: [
      'Carrega o mesmo contrato do item da listagem, com URL própria para o link ser compartilhável.',
      'Um vínculo de outra agência, inexistente ou malformado devolve o mesmo 404. Um vínculo removido',
      'é 404 para quem não tem a permissão administrativa de remover ou reativar.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.visualizar',
    params: AgencyCollaboratorPathParamsSchema,
    responses: [{
      status: 200,
      description: 'O colaborador pedido.',
      schema: CollaboratorSchema,
      example: {
        membershipId,
        name: 'Camila Nogueira',
        email: 'camila@exemplo.test',
        photoUrl: signedStorageUrl,
        jobTitle: 'Gestora de contas',
        role: { key: 'account_manager', name: 'Gestor de conta' },
        isOwner: false,
        status: 'active',
        joinedAt: '2026-03-12T12:00:00.000Z'
      }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Collaborator not found.' }
    ]
  },

  {
    method: 'post',
    path: '/agencies/:agencyId/collaborators/:membershipId/remove',
    operationId: 'removeCollaborator',
    module: 'collaborators',
    summary: 'Remove um colaborador do quadro',
    description: [
      'O vínculo vai para `removed` e a linha permanece -- nenhuma rota apaga entidade de negócio.',
      'O Owner não é removido e ninguém remove a si mesmo. Remover um vínculo já removido é',
      'idempotente.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.remover',
    params: AgencyCollaboratorPathParamsSchema,
    responses: [{
      status: 200,
      description: 'O vínculo em `removed`.',
      schema: CollaboratorSchema,
      example: {
        membershipId,
        name: 'Camila Nogueira',
        email: 'camila@exemplo.test',
        photoUrl: signedStorageUrl,
        jobTitle: 'Gestora de contas',
        role: { key: 'account_manager', name: 'Gestor de conta' },
        isOwner: false,
        status: 'removed',
        joinedAt: '2026-03-12T12:00:00.000Z'
      }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Collaborator not found.' }
    ]
  },

  {
    method: 'post',
    path: '/agencies/:agencyId/collaborators/:membershipId/reactivate',
    operationId: 'reactivateCollaborator',
    module: 'collaborators',
    summary: 'Reativa um vínculo removido',
    description: [
      'O `role_id` é obrigatório: quem volta pode voltar em outra função, e herdar o papel antigo em',
      'silêncio é o que a regra proíbe. Conceder `admin` exige a permissão de conceder admin (403 para',
      'Admin, 200 para o Owner).'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.alterar_papel',
    params: AgencyCollaboratorPathParamsSchema,
    body: ReactivateCollaboratorRequestSchema,
    requestExample: { roleId },
    responses: [{
      status: 200,
      description: 'O vínculo em `active`, no mesmo id.',
      schema: CollaboratorSchema,
      example: {
        membershipId,
        name: 'Camila Nogueira',
        email: 'camila@exemplo.test',
        photoUrl: signedStorageUrl,
        jobTitle: 'Gestora de contas',
        role: { key: 'production', name: 'Produção' },
        isOwner: false,
        status: 'active',
        joinedAt: '2026-03-12T12:00:00.000Z'
      }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Collaborator not found.' }
    ]
  },

  {
    method: 'post',
    path: '/agencies/:agencyId/media/uploads',
    operationId: 'createMediaUpload',
    module: 'media',
    summary: 'Inicia um upload de mídia',
    description: 'Devolve a URL assinada de PUT ou o plano de multipart; o tipo real é validado no fim, pelo conteúdo.',
    access: 'Sessão + vínculo com a agência',
    permission: 'midia.enviar',
    params: AgencyPathParamsSchema,
    body: CreateMediaUploadRequestSchema,
    requestExample: { fileName: 'foto.png', contentType: 'image/png', declaredSizeBytes: 1048576 },
    responses: [{
      status: 201,
      description: 'Upload iniciado.',
      schema: CreateMediaUploadResponseSchema,
      example: {
        assetId,
        objectKey: `${agencyId}/${assetId}/original.png`,
        category: 'image',
        upload: { type: 'single', url: signedStorageUrl, expiresAt: '2026-09-29T12:15:00.000Z' }
      }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' },
      { status: 409, code: 'QUOTA_EXCEEDED' },
      { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/media/uploads/:assetId/parts',
    operationId: 'requestMediaUploadParts',
    module: 'media',
    summary: 'Pede URLs assinadas de partes do multipart',
    description: 'Repetível para retomar um upload interrompido; pede só os números que ainda faltam.',
    access: 'Sessão + vínculo com a agência',
    permission: 'midia.enviar',
    params: AgencyMediaAssetPathParamsSchema,
    body: RequestMediaUploadPartsRequestSchema,
    requestExample: { partNumbers: [1, 2] },
    responses: [{
      status: 200,
      description: 'URLs assinadas das partes.',
      schema: RequestMediaUploadPartsResponseSchema,
      example: { parts: [{ partNumber: 1, url: signedStorageUrl }], expiresAt: '2026-09-29T12:15:00.000Z' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Media asset not found.' },
      { status: 409, code: 'UPLOAD_NOT_PENDING' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/media/uploads/:assetId/complete',
    operationId: 'completeMediaUpload',
    module: 'media',
    summary: 'Confirma o upload e valida o objeto',
    description: 'Valida tipo e tamanho pelo conteúdo observado no armazenamento; rejeição vira 422 e fica registrada.',
    access: 'Sessão + vínculo com a agência',
    permission: 'midia.enviar',
    params: AgencyMediaAssetPathParamsSchema,
    body: CompleteMediaUploadRequestSchema,
    requestExample: { parts: [{ partNumber: 1, eTag: '"exemplo-de-etag"' }] },
    responses: [{
      status: 200,
      description: 'Upload confirmado.',
      schema: CompleteMediaUploadResponseSchema,
      example: { assetId, status: 'confirmed', sizeBytes: 1048576, contentType: 'image/png' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Media asset not found.' },
      { status: 409, code: 'QUOTA_EXCEEDED' },
      { status: 409, code: 'UPLOAD_NOT_PENDING' },
      { status: 422, code: 'UPLOAD_REJECTED' }
    ]
  },
  {
    method: 'get',
    path: '/agencies/:agencyId/media/:assetId/download-url',
    operationId: 'getMediaDownloadUrl',
    module: 'media',
    summary: 'Emite uma URL assinada de leitura',
    description: 'Válida por poucos minutos, só GET, e apenas para um objeto confirmado da agência.',
    access: 'Sessão + vínculo com a agência',
    permission: 'midia.enviar',
    params: AgencyMediaAssetPathParamsSchema,
    query: MediaDownloadUrlQuerySchema,
    requestExample: { variant: 'original' },
    responses: [{
      status: 200,
      description: 'URL assinada.',
      schema: MediaDownloadUrlResponseSchema,
      example: { url: signedStorageUrl, expiresAt: '2026-09-29T12:05:00.000Z' }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Media asset not found.' },
      { status: 409, code: 'VARIANT_NOT_READY' },
      { status: 409, code: 'VARIANT_PROCESSING_FAILED' }
    ]
  }
];
