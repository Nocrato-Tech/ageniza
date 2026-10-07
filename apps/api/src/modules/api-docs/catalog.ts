import type { z } from 'zod';

import { COLLABORATOR_ROLES_READ_PERMISSIONS, COLLABORATOR_UPDATE_PERMISSIONS } from '../collaborators/permissions.js';
import type { RoutePermission } from '../../plugins/infra/route-metadata.js';
import {
  AcceptLegalDocumentRequestSchema,
  AgencyClientPathParamsSchema,
  AgencyClientPersonaPathParamsSchema,
  AgencyClientSectionPathParamsSchema,
  AgencyCollaboratorPathParamsSchema,
  AgencyInvitationPathParamsSchema,
  AgencyMeResponseSchema,
  AgencyMediaAssetPathParamsSchema,
  AgencyPathParamsSchema,
  AgencyRolesQuerySchema,
  AgencyRolesResponseSchema,
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  AuthPasswordForgotRequestSchema,
  AuthPasswordForgotResponseSchema,
  AuthPasswordResetRequestSchema,
  AuthPasswordResetResponseSchema,
  AuthSessionResponseSchema,
  BrandStudyResponseSchema,
  BrandStudySectionSchema,
  BrandStudySectionUpdateRequestSchema,
  ClientDetailResponseSchema,
  ClientInvitationRequestSchema,
  ClientListQuerySchema,
  ClientListResponseSchema,
  ClientPathParamsSchema,
  ClientSchema,
  CollaboratorDetailQuerySchema,
  CollaboratorInvitationRequestSchema,
  CollaboratorJobTitlesQuerySchema,
  CollaboratorJobTitlesResponseSchema,
  CollaboratorListQuerySchema,
  CollaboratorListResponseSchema,
  CollaboratorSchema,
  CompleteMediaUploadRequestSchema,
  CompleteMediaUploadResponseSchema,
  ContextResolveQuerySchema,
  ContextResolveResponseSchema,
  CreateClientRequestSchema,
  CreateMediaUploadRequestSchema,
  CreatePersonaRequestSchema,
  CreateMediaUploadResponseSchema,
  EmailChangeConfirmRequestSchema,
  EmailChangeConfirmResponseSchema,
  EmailChangeRequestResponseSchema,
  EmailChangeRequestSchema,
  HealthResponseSchema,
  InvitationAcceptNewAccountRequestSchema,
  InvitationAcceptNewAccountResponseSchema,
  InvitationAcceptRequestSchema,
  InvitationAcceptResponseSchema,
  InvitationCreatedResponseSchema,
  InvitationPreviewResponseSchema,
  LegalAcceptancesResponseSchema,
  MeContextsResponseSchema,
  MediaDownloadUrlQuerySchema,
  MediaDownloadUrlResponseSchema,
  PaginationInputSchema,
  PendingInvitationListResponseSchema,
  PersonaSchema,
  PublicInvitationTokenPathParamsSchema,
  PutLastContextRequestSchema,
  RequestMediaUploadPartsRequestSchema,
  RequestMediaUploadPartsResponseSchema,
  UpdateClientRequestSchema,
  UpdateCollaboratorRequestSchema,
  UpdateMyProfileRequestSchema,
  UpdateMyProfileResponseSchema,
  UpdatePersonaRequestSchema,
  UploadClientPhotoRequestSchema,
  UploadClientPhotoResponseSchema,
  UploadMyPhotoRequestSchema,
  UploadMyPhotoResponseSchema
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

export type ApiModule = 'system' | 'auth' | 'invitations' | 'contexts' | 'agencies' | 'clients' | 'collaborators' | 'media' | 'profile' | 'legal' | 'email-change';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Every route rendered with a list of permissions says so in prose, in both outputs. */
export const permissionLabel = (permission: RoutePermission): string =>
  permission === null
    ? '—'
    : Array.isArray(permission)
      ? permission.map((key) => `\`${key}\``).join(' ou ')
      : `\`${permission}\``;

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
  /** Permission(s) the route's guard demands, or null when it has none; a list means any one. */
  readonly permission: RoutePermission;
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
  clients: 'Cadastro do cliente da agência: carteira com triagem, criar, ler o detalhe com o resumo, editar e trocar a foto.',
  collaborators: 'A equipe da agência: listagem com paginação, busca e filtros, detalhe e alteração de cargo e papel.',
  media: 'Upload direto ao armazenamento, confirmação e URLs assinadas de mídia.',
  profile: 'Edição do próprio nome e da própria foto de perfil.',
  legal: 'Versão dos Termos e da Privacidade que a conta aceitou, e o aceite de um documento por vez.',
  'email-change': 'Pedido de troca do e-mail da conta, aprovado pela operação, e a confirmação pelo link enviado ao e-mail novo.'
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
  CLIENT_NAME_IN_USE: 'Já existe um cliente ativo com este nome.',
  CLIENT_ARCHIVED: 'Cliente arquivado não pode ser editado.',
  INVALID_PASSWORD: 'A senha atual não confere.',
  SAME_EMAIL: 'Informe um e-mail diferente do atual.',
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
const clientId = '77777777-7777-4777-8777-777777777777';
const personaId = '88888888-8888-4888-8888-888888888888';

const agencyContextExample = {
  type: 'agency',
  agencyId,
  agencyName: 'Agência Exemplo',
  roleKey: 'admin',
  roleName: 'Admin',
  isOwner: true
} as const;

const legalAcceptancesExample = {
  documents: [
    { document: 'terms', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false },
    { document: 'privacy', currentVersion: '2026-10-01', acceptedVersion: '2026-02-01', pending: true }
  ]
} as const;

const signedStorageUrl ='https://storage.exemplo.test/arquivo.png?assinatura=ficticia';

const clientExample = {
  id: clientId,
  name: 'Padaria Central',
  status: 'active',
  photoUrl: null,
  legalName: 'Padaria Central Ltda',
  taxId: '12345678000190',
  segment: 'Alimentação',
  website: 'https://padariacentral.exemplo.test',
  instagramHandle: 'padariacentral',
  contactName: 'Maria Souza',
  contactPhone: '+55 11 90000-0000',
  contactEmail: 'maria@padariacentral.exemplo.test',
  closingDate: null,
  archivedAt: null
} as const;

const personaExample = {
  id: personaId,
  name: 'Dona Maria',
  description: 'Dona de casa, 58 anos.',
  pains: 'Pouco tempo para pesquisar.',
  desires: 'Reconhecimento da comunidade.',
  objections: 'Preço acima do esperado.',
  status: 'active',
  updatedBy: { id: userId, name: 'Dono da Agência' },
  updatedAt: '2026-09-30T12:00:00.000Z'
} as const;

const brandSectionExample = {
  key: 'colors',
  body: null,
  colors: [{ name: 'Vinho', hex: '#7A1F2B' }],
  archetype: null,
  updatedBy: { id: userId, name: 'Dono da Agência' },
  updatedAt: '2026-09-30T12:00:00.000Z'
} as const;

const emptyBrandSection = (key: string) => ({
  key,
  body: null,
  colors: null,
  archetype: null,
  updatedBy: null,
  updatedAt: null
});

const brandStudyExample = {
  filled: 3,
  sections: [
    { key: 'branding', body: 'Marca acolhedora.', colors: null, archetype: null, updatedBy: { id: userId, name: 'Dono da Agência' }, updatedAt: '2026-09-30T12:00:00.000Z' },
    emptyBrandSection('tone_of_voice'),
    brandSectionExample,
    emptyBrandSection('positioning'),
    { key: 'archetype', body: null, colors: null, archetype: 'caregiver', updatedBy: null, updatedAt: null },
    emptyBrandSection('personas'),
    emptyBrandSection('observations')
  ],
  personas: [personaExample]
} as const;

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
    description: 'O papel vem preso ao convite; o e-mail sai pelo serviço de e-mail e o token só existe nele. Convidar com o papel `admin` exige também `colaborador.atribuir_admin`, que só o Owner tem (403).',
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
    description: 'Revoga o convite atual e cria outro com token novo, para o link antigo deixar de valer. Reenviar um convite com o papel `admin` exige também `colaborador.atribuir_admin`, que só o Owner tem (403).',
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
    body: InvitationAcceptRequestSchema,
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
      'cargo e status (somente ativos). A lista é a mesma para todos os papéis; a foto vem como URL',
      'assinada. O filtro de removidos chega com a guarda administrativa da #98.'
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
      'Um vínculo de outra agência, inexistente, malformado ou removido devolve o mesmo 404, sem',
      'revelar existência.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.visualizar',
    params: AgencyCollaboratorPathParamsSchema,
    query: CollaboratorDetailQuerySchema,
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
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' }
    ]
  },

  {
    method: 'patch',
    path: '/agencies/:agencyId/collaborators/:membershipId',
    operationId: 'updateCollaborator',
    module: 'collaborators',
    summary: 'Altera o cargo e/ou o papel de um colaborador',
    description: [
      'Aceita `jobTitle` (texto de 1 a 256 caracteres, sem caracteres de controle, ou `null` para limpar),',
      '`roleId`, ou os dois; corpo vazio é 400. Basta uma das duas permissões para chegar à rota, mas a exigida',
      'é a de cada campo presente:',
      '`jobTitle` pede `colaborador.alterar_funcao`, `roleId` pede `colaborador.alterar_papel`, e os dois pedem',
      'as duas. Se o papel for `admin`, pede também `colaborador.atribuir_admin`, que só o Owner tem.',
      'O papel do Owner não muda e ninguém altera o próprio papel (403). Um vínculo de outra agência,',
      'inexistente, malformado ou removido devolve o mesmo 404. Devolve o vínculo atualizado, no',
      'mesmo contrato do detalhe; nunca há 200 sem uma linha alterada.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: COLLABORATOR_UPDATE_PERMISSIONS,
    params: AgencyCollaboratorPathParamsSchema,
    body: UpdateCollaboratorRequestSchema,
    requestExample: { jobTitle: 'Editor de Vídeo', roleId },
    responses: [{
      status: 200,
      description: 'O colaborador atualizado.',
      schema: CollaboratorSchema,
      example: {
        membershipId,
        name: 'Camila Nogueira',
        email: 'camila@exemplo.test',
        photoUrl: signedStorageUrl,
        jobTitle: 'Editor de Vídeo',
        role: { key: 'production', name: 'Produção' },
        isOwner: false,
        status: 'active',
        joinedAt: '2026-03-12T12:00:00.000Z'
      }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'INVALID_ROLE' },
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' }
    ]
  },

  {
    method: 'get',
    path: '/agencies/:agencyId/collaborators/job-titles',
    operationId: 'listCollaboratorJobTitles',
    module: 'collaborators',
    summary: 'Lista os cargos que existem na agência',
    description: [
      'Cargos distintos (depois de trim, sem nulos e sem vazios) dos vínculos ativos da agência, em',
      'ordem alfabética e até 200 valores. Alimenta o filtro de cargo da grade; a listagem paginada',
      'não serve porque devolve só uma página.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.visualizar',
    params: AgencyPathParamsSchema,
    query: CollaboratorJobTitlesQuerySchema,
    responses: [{
      status: 200,
      description: 'Cargos existentes na agência.',
      schema: CollaboratorJobTitlesResponseSchema,
      example: { data: ['Editor de Vídeo', 'Gestora de contas', 'Designer'] }
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
path: '/agencies/:agencyId/roles',
    operationId: 'listAgencyRoles',
    module: 'collaborators',
    summary: 'Lista os papéis atribuíveis na agência',
    description: [
      'Papéis de sistema e papéis próprios da agência, com o id que o convite, a troca de papel e a',
      'reativação exigem -- a única rota em que esses ids aparecem. O papel Admin só aparece para o',
      'Owner.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: COLLABORATOR_ROLES_READ_PERMISSIONS,
    params: AgencyPathParamsSchema,
    query: AgencyRolesQuerySchema,
    responses: [{
      status: 200,
      description: 'Papéis atribuíveis na agência.',
      schema: AgencyRolesResponseSchema,
      example: {
        data: [
          { id: roleId, key: 'admin', name: 'Admin' },
          { id: '66666666-6666-4666-8666-666666666667', key: 'account_manager', name: 'Gestor de conta' }
        ]
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
    path: '/agencies/:agencyId/clients',
    operationId: 'listClients',
    module: 'clients',
    summary: 'Lista a carteira de clientes com ordem de triagem',
    description: [
      'Paginada pelo contrato global de listagem, com busca por nome, razão social e @ (sem',
      'diferenciar maiúsculas nem acento), filtro de status e ordem `attention` por padrão: quem tem',
      'thread aguardando a agência vem primeiro, depois nome ascendente, com `id` como desempate.',
      '`pendingInvitations` só vem para quem tem `cliente.convidar_usuario`; para os demais o campo',
      'é omitido, não zerado.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.visualizar',
    params: AgencyPathParamsSchema,
    query: ClientListQuerySchema,
    requestExample: { page: 1, pageSize: 20, search: 'padaria', status: 'active', sort: 'attention' },
    responses: [{
      status: 200,
      description: 'Página da carteira.',
      schema: ClientListResponseSchema,
      example: {
        data: [{
          id: clientId,
          name: 'Padaria Central',
          photoUrl: null,
          instagramHandle: 'padariacentral',
          status: 'active',
          closingDate: null,
          threadsAwaitingAgency: 2,
          pendingInvitations: 1
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
    path: '/agencies/:agencyId/clients',
    operationId: 'createClient',
    module: 'clients',
    summary: 'Cadastra um cliente',
    description: 'Só o nome. O nome é aparado, exige ao menos uma letra ou número e recusa caracteres de controle, invisíveis e overrides bidi (a regra compartilhada de nome de exibição). Nome já ativo na agência, mesmo com outra caixa ou espaços, responde 409 pela violação do índice único.',
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.cadastrar',
    params: AgencyPathParamsSchema,
    body: CreateClientRequestSchema,
    requestExample: { name: 'Padaria Central' },
    responses: [{ status: 201, description: 'Cliente criado.', schema: ClientSchema, example: clientExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' },
      { status: 409, code: 'CLIENT_NAME_IN_USE' }
    ]
  },
  {
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId',
    operationId: 'getClient',
    module: 'clients',
    summary: 'Lê o detalhe do cliente com o resumo da aba Geral',
    description: [
      'Cliente de outra agência, inexistente ou `:clientId` inválido devolvem o mesmo 404. O resumo',
      'conta o estudo preenchido (0 a 7, com personas só quando ativas) e as conversas aguardando',
      'resposta, pela mesma definição que a listagem e o portal usam.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.visualizar',
    params: AgencyClientPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Detalhe do cliente.',
      schema: ClientDetailResponseSchema,
      example: {
        ...clientExample,
        summary: { brandStudyFilled: 3, threadsAwaitingAgency: 1, threadsAnsweredByAgency: 2, activePortalMembers: 3 }
      }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' }
    ]
  },
  {
    method: 'patch',
    path: '/agencies/:agencyId/clients/:clientId',
    operationId: 'updateClient',
    module: 'clients',
    summary: 'Edita o cadastro do cliente',
    description: [
      'Aceita qualquer subconjunto dos campos de cadastro, mas exige ao menos um: corpo vazio é 400.',
      '`null` limpa um campo e texto em branco vira `null`; nome, razão social e contatos seguem a',
      'mesma regra do nome de exibição. Cliente arquivado responde 409 e nada muda; nome em uso entre',
      'os ativos responde 409 pelo índice único.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.operar',
    params: AgencyClientPathParamsSchema,
    body: UpdateClientRequestSchema,
    requestExample: { taxId: '12.345.678/0001-90', instagramHandle: '@padariacentral' },
    responses: [{ status: 200, description: 'Cliente atualizado.', schema: ClientSchema, example: clientExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_NAME_IN_USE' },
      { status: 409, code: 'CLIENT_ARCHIVED' }
    ]
  },
  {
    method: 'put',
    path: '/agencies/:agencyId/clients/:clientId/photo',
    operationId: 'uploadClientPhoto',
    module: 'clients',
    summary: 'Envia a foto do cliente',
    description: [
      'A imagem vai em base64 pelo servidor, que valida o tipo pelos bytes reais (nunca pelo rótulo',
      'declarado) e o tamanho antes de gravar; a resposta traz a URL assinada. A foto anterior é',
      'removida. A foto vive no armazenamento de identidade e nunca entra em quota de agência.',
      'Cliente arquivado responde 409 e nada é gravado.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.operar',
    params: AgencyClientPathParamsSchema,
    body: UploadClientPhotoRequestSchema,
    requestExample: { imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    responses: [{
      status: 200,
      description: 'Foto atualizada.',
      schema: UploadClientPhotoResponseSchema,
      example: { photoUrl: signedStorageUrl }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
      { status: 429, code: 'RATE_LIMITED' }
    ]
  },
  {
    method: 'delete',
    path: '/agencies/:agencyId/clients/:clientId/photo',
    operationId: 'deleteClientPhoto',
    module: 'clients',
    summary: 'Remove a foto do cliente',
    description: 'Apaga o objeto e limpa a referência; sem foto, continua 204. Cliente arquivado responde 409.',
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.operar',
    params: AgencyClientPathParamsSchema,
    responses: [{ status: 204, description: 'Foto removida.' }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' }
    ]
  },
  {
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId/brand-study',
    operationId: 'getBrandStudy',
    module: 'clients',
    summary: 'Lê o estudo de marca com as sete seções e as personas',
    description: [
      'As sete seções são fixas e sempre vêm, preenchidas ou não; `filled` (0 a 7) conta as seções',
      'com conteúdo e `personas` quando há ao menos uma persona ativa. A agência vê personas',
      'arquivadas também.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.visualizar',
    params: AgencyClientPathParamsSchema,
    responses: [{ status: 200, description: 'Estudo de marca.', schema: BrandStudyResponseSchema, example: brandStudyExample }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' }
    ]
  },
  {
    method: 'put',
    path: '/agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey',
    operationId: 'updateBrandStudySection',
    module: 'clients',
    summary: 'Grava uma seção do estudo de marca (upsert)',
    description: [
      'O corpo depende da chave: texto para `branding`, `tone_of_voice`, `positioning` e',
      '`observations`; até 24 `{ name, hex }` (`hex` `#RRGGBB`) para `colors`; uma das doze chaves',
      'para `archetype`. O texto é aparado, não pode ficar vazio e limita a 20.000 bytes; `personas`',
      'não aceita `PUT` e responde 400. Cliente arquivado responde 409.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.operar',
    params: AgencyClientSectionPathParamsSchema,
    body: BrandStudySectionUpdateRequestSchema,
    requestExample: { body: 'Marca acolhedora.' },
    responses: [{ status: 200, description: 'Seção gravada.', schema: BrandStudySectionSchema, example: brandSectionExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/personas',
    operationId: 'createPersona',
    module: 'clients',
    summary: 'Cria uma persona do cliente',
    description: 'A persona nasce ativa; `updated_by` é o usuário da sessão. Cliente arquivado responde 409.',
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.operar',
    params: AgencyClientPathParamsSchema,
    body: CreatePersonaRequestSchema,
    requestExample: { name: 'Dona Maria', description: 'Dona de casa, 58 anos.' },
    responses: [{ status: 201, description: 'Persona criada.', schema: PersonaSchema, example: personaExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' }
    ]
  },
  {
    method: 'patch',
    path: '/agencies/:agencyId/clients/:clientId/personas/:personaId',
    operationId: 'updatePersona',
    module: 'clients',
    summary: 'Edita uma persona',
    description: 'Aceita um subconjunto dos campos; `null` limpa. Persona de outro cliente é o mesmo 404.',
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.operar',
    params: AgencyClientPersonaPathParamsSchema,
    body: UpdatePersonaRequestSchema,
    requestExample: { name: 'Dona Maria', desires: 'Reconhecimento da comunidade.' },
    responses: [{ status: 200, description: 'Persona atualizada.', schema: PersonaSchema, example: personaExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Persona not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/personas/:personaId/archive',
    operationId: 'archivePersona',
    module: 'clients',
    summary: 'Arquiva uma persona',
    description: 'A persona sai do portal e as conversas dela ficam somente leitura; o histórico continua na agência.',
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.operar',
    params: AgencyClientPersonaPathParamsSchema,
    responses: [{ status: 200, description: 'Persona arquivada.', schema: PersonaSchema, example: { ...personaExample, status: 'archived' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Persona not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/personas/:personaId/unarchive',
    operationId: 'unarchivePersona',
    module: 'clients',
    summary: 'Desarquiva uma persona',
    description: 'A persona volta a aparecer no portal.',
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.operar',
    params: AgencyClientPersonaPathParamsSchema,
    responses: [{ status: 200, description: 'Persona reativada.', schema: PersonaSchema, example: personaExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Persona not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' }
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
  },

  {
    method: 'patch',
    path: '/me/profile',
    operationId: 'updateMyProfile',
    module: 'profile',
    summary: 'Altera o nome da própria pessoa',
    description: [
      'O alvo é sempre a pessoa da sessão: não há identificador de usuário no corpo, na query nem',
      'na rota, e o corpo `.strict()` recusa qualquer campo a mais. O e-mail não é editável por',
      'nenhuma rota deste módulo.'
    ].join('\n'),
    access: 'Sessão',
    permission: null,
    body: UpdateMyProfileRequestSchema,
    requestExample: { name: 'Novo Nome' },
    responses: [{
      status: 200,
      description: 'Nome atualizado.',
      schema: UpdateMyProfileResponseSchema,
      example: { id: userId, name: 'Novo Nome' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' }
    ]
  },
  {
    method: 'post',
    path: '/me/photo',
    operationId: 'uploadMyPhoto',
    module: 'profile',
    summary: 'Envia a própria foto de perfil',
    description: [
      'A imagem vai em base64 pelo servidor, que valida o tipo pelos bytes reais (nunca pelo rótulo',
      'declarado) e o tamanho antes de gravar; a resposta traz a URL assinada. A foto vive no',
      'armazenamento de identidade e nunca entra em quota de agência.'
    ].join('\n'),
    access: 'Sessão',
    permission: null,
    body: UploadMyPhotoRequestSchema,
    requestExample: { imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    responses: [{
      status: 200,
      description: 'Foto atualizada.',
      schema: UploadMyPhotoResponseSchema,
      example: { imageUrl: signedStorageUrl }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }
    ]
  },

  {
    method: 'get',
    path: '/me/legal-acceptances',
    operationId: 'getMyLegalAcceptances',
    module: 'legal',
    summary: 'Consulta a versão aceita dos Termos e da Privacidade',
    description: [
      'Uma entrada por documento, Termos primeiro: a versão em vigor no servidor, a versão mais nova',
      'que a conta aceitou (`null` se nunca aceitou) e se há aceite pendente. Pendente não bloqueia',
      'nenhuma funcionalidade; só alimenta o aviso da interface.'
    ].join('\n'),
    access: 'Sessão',
    permission: null,
    responses: [{
      status: 200,
      description: 'Situação dos dois documentos.',
      schema: LegalAcceptancesResponseSchema,
      example: legalAcceptancesExample
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' }
    ]
  },
  {
    method: 'post',
    path: '/me/legal-acceptances',
    operationId: 'acceptLegalDocument',
    module: 'legal',
    summary: 'Aceita um documento legal, na versão em vigor',
    description: [
      'O corpo nomeia só o documento; a versão gravada é sempre a que está em vigor no servidor, e',
      'o corpo `.strict()` recusa um campo `version`. O aceite é por documento: aceitar a Privacidade',
      'não marca os Termos. É idempotente e nunca regride: repetir, ou aceitar uma versão que a conta',
      'já superou, responde 200 sem gravar nada. A resposta traz a situação dos dois documentos.'
    ].join('\n'),
    access: 'Sessão',
    permission: null,
    body: AcceptLegalDocumentRequestSchema,
    requestExample: { document: 'privacy' },
    responses: [{
      status: 200,
      description: 'Situação dos dois documentos depois do aceite.',
      schema: LegalAcceptancesResponseSchema,
      example: legalAcceptancesExample
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' }
    ]
  },

  {
    method: 'post',
    path: '/me/email-change',
    operationId: 'requestEmailChange',
    module: 'email-change',
    summary: 'Pede a troca do e-mail da própria conta',
    description: [
      'A pessoa não troca o e-mail sozinha: ela pede, e a operação da plataforma aprova pelo CLI',
      '(`cli:email-change`), porque a conta é global e o pedido não pertence a nenhuma agência. O',
      'corpo traz só o e-mail novo e a senha atual; a conta é sempre a da sessão. Há um pedido',
      'aberto por conta, e um novo substitui o anterior. O endereço atual recebe um aviso.',
      'A resposta é a mesma 202 vazia quando o e-mail novo já pertence a outra conta: a rota não',
      'revela quais e-mails têm conta. O teto é de 5 pedidos por hora e por conta.'
    ].join('\n'),
    access: 'Sessão',
    permission: null,
    body: EmailChangeRequestSchema,
    requestExample: { newEmail: 'novo.endereco@exemplo.test', currentPassword: '<senha-do-exemplo>' },
    responses: [{
      status: 202,
      description: 'Pedido registrado; o endereço atual foi avisado.',
      schema: EmailChangeRequestResponseSchema,
      example: {}
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'SAME_EMAIL' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'INVALID_PASSWORD' },
      { status: 429, code: 'RATE_LIMITED' }
    ]
  },
  {
    method: 'post',
    path: '/email-change/confirm',
    operationId: 'confirmEmailChange',
    module: 'email-change',
    summary: 'Confirma a troca de e-mail pelo link enviado ao e-mail novo',
    description: [
      'Pública: quem prova que lê o e-mail novo é o token do link, de uso único. Troca o e-mail,',
      'encerra todas as sessões da conta e os links de redefinição de senha pendentes, e avisa o',
      'endereço antigo. Link usado, vencido, substituído, ou cujo e-mail já pertence a outra conta',
      'respondem todos o mesmo 400 `INVALID_LINK`.'
    ].join('\n'),
    access: 'Pública, pelo token do link',
    permission: null,
    body: EmailChangeConfirmRequestSchema,
    requestExample: { token: '<token-do-link>' },
    responses: [{
      status: 200,
      description: 'E-mail trocado e sessões encerradas.',
      schema: EmailChangeConfirmResponseSchema,
      example: {}
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'INVALID_LINK' },
      { status: 429, code: 'RATE_LIMITED' }
    ]
  }
];
