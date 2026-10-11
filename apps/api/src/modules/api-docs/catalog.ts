import type { z } from 'zod';

import { COLLABORATOR_ROLES_READ_PERMISSIONS, COLLABORATOR_UPDATE_PERMISSIONS } from '../collaborators/permissions.js';
import { CONVERSATION_READ_PERMISSIONS, CONVERSATION_WRITE_PERMISSIONS } from '../clients/policy.js';
import { MEDIA_READ_PERMISSIONS, MEDIA_UPLOAD_PERMISSIONS } from '../media/policy.js';
import type { RoutePermission } from '../../plugins/infra/route-metadata.js';
import {
  AcceptLegalDocumentRequestSchema,
  AgencyClientMediaFolderAssetPathParamsSchema,
  AgencyClientMediaFolderPathParamsSchema,
  AgencyClientMemberPathParamsSchema,
  AgencyClientPathParamsSchema,
  AgencyClientContentPathParamsSchema,
  AgencyClientContentTaskPathParamsSchema,
  AgencyClientPersonaPathParamsSchema,
  AgencyClientStoryScriptPathParamsSchema,
  AgencyClientThreadPathParamsSchema,
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
  ClientInvitationListQuerySchema,
  ClientInvitationListResponseSchema,
  ClientInvitationRequestSchema,
  ClientListQuerySchema,
  ClientListResponseSchema,
  ClientMemberListQuerySchema,
  ClientMemberListResponseSchema,
  ClientMemberSchema,
  ClientPathParamsSchema,
  ClientStoryScriptPathParamsSchema,
  ClientSchema,
  ClientThreadPathParamsSchema,
  CommentListQuerySchema,
  CommentListResponseSchema,
  CommentSchema,
  ApproveContentByAgencyRequestSchema,
  ContentDetailSchema,
  ContentPeriodQuerySchema,
  ContentPeriodResponseSchema,
  ContentTaskSchema,
  CreateContentRequestSchema,
  CreateContentTaskRequestSchema,
  PublishContentRequestSchema,
  RescheduleContentRequestSchema,
  ReturnContentTaskRequestSchema,
  CollaboratorDetailQuerySchema,
  CollaboratorInvitationRequestSchema,
  CollaboratorJobTitlesQuerySchema,
  CollaboratorJobTitlesResponseSchema,
  CollaboratorListQuerySchema,
  CollaboratorListResponseSchema,
  CollaboratorSchema,
  CompleteMediaUploadRequestSchema,
  CompleteMediaUploadResponseSchema,
  CollaboratorInvitationCreatedResponseSchema,
  ContextResolveQuerySchema,
  ContextResolveResponseSchema,
  CreateClientRequestSchema,
  CreateCommentRequestSchema,
  CreateThreadRequestSchema,
  CreateStoryScriptRequestSchema,
  CreateThreadResponseSchema,
  CreateMediaFolderRequestSchema,
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
  MediaFolderAssetListQuerySchema,
  MediaFolderAssetListResponseSchema,
  MediaFolderListQuerySchema,
  MediaFolderListResponseSchema,
  MediaFolderSchema,
  MediaDownloadUrlResponseSchema,
  PaginationInputSchema,
  PortalStoryScriptPeriodResponseSchema,
  PortalStoryScriptSchema,
  PendingInvitationListResponseSchema,
  PersonaSchema,
  PortalBrandStudyResponseSchema,
  PortalClientQuerySchema,
  PortalClientResponseSchema,
  PublicInvitationTokenPathParamsSchema,
  PutLastContextRequestSchema,
  SetClientClosingRequestSchema,
  ThreadListQuerySchema,
  ThreadListResponseSchema,
  ThreadSchema,
  RemoveMediaAssetResponseSchema,
  RequestMediaUploadPartsRequestSchema,
  RequestMediaUploadPartsResponseSchema,
  UpdateClientRequestSchema,
  ReactivateCollaboratorRequestSchema,
  UpdateCollaboratorRequestSchema,
  UpdateMyProfileRequestSchema,
  UpdateMyProfileResponseSchema,
  StoryScriptPeriodQuerySchema,
  StoryScriptSchema,
  UpdatePersonaRequestSchema,
  UpdateStoryScriptRequestSchema,
  UploadClientPhotoRequestSchema,
  UploadClientPhotoResponseSchema,
  UpdateContentRequestSchema,
  UpdateContentTaskRequestSchema,
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

export type ApiModule = 'system' | 'auth' | 'invitations' | 'contexts' | 'agencies' | 'clients' | 'contents' | 'collaborators' | 'media' | 'profile' | 'legal' | 'email-change' | 'story-scripts';

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
  clients: 'Cadastro do cliente da agência: carteira com triagem, criar, ler o detalhe com o resumo, editar e trocar a foto; agendar, desmarcar, arquivar e reativar o contrato; estudo de marca e personas; a conversa em thread entre a agência e o cliente, pelos dois lados; as leituras do próprio cliente no portal; e os acessos ao portal vistos pela agência.',
  contents: 'Conteúdo do cliente na agência: a consulta por período (calendário e feed), criar, ler o detalhe, editar e mover de data; e as transições: enviar para aprovação, aprovar fora da plataforma, publicar, desfazer a publicação, cancelar e reagendar; e as subtarefas: criar, editar, entregar, aprovar e devolver.',
  collaborators: 'A equipe da agência: listagem com paginação, busca e filtros, detalhe, alteração de cargo e papel, remoção e reativação.',
  media: 'Upload direto ao armazenamento, confirmação e URLs assinadas de mídia; as pastas de mídia de um cliente, a listagem do que há nelas e a remoção.',
  profile: 'Edição do próprio nome e da própria foto de perfil.',
  legal: 'Versão dos Termos e da Privacidade que a conta aceitou, e o aceite de um documento por vez.',
  'email-change': 'Pedido de troca do e-mail da conta, aprovado pela operação, e a confirmação pelo link enviado ao e-mail novo.',
  'story-scripts': 'Roteiros de stories de um cliente: a agência cria, edita e envia; o portal lê os enviados de um período e marca como gravado.'
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
  MEDIA_IN_USE: 'Esta mídia está em um conteúdo enviado para aprovação, aprovado ou publicado e não pode ser removida.',
  CLIENT_NOT_ARCHIVED: 'Este cliente já está ativo.',
  CLOSING_DATE_NOT_SET: 'Este cliente não tem encerramento agendado.',
  PERSONA_ARCHIVED: 'Persona arquivada: a conversa é somente leitura.',
  SECTION_NOT_FILLED: 'Esta seção ainda não foi preenchida pela agência.',
  CONTENT_PERIOD_TOO_LARGE: 'O período tem mais de 500 itens. Consulte um período menor.',
  CONTENT_NOT_EDITABLE: 'Conteúdo publicado ou cancelado não pode ser editado.',
  CONTENT_MEDIA_INCOMPLETE: 'A mídia do conteúdo não cobre este formato. Para trocar entre carrossel e formato de uma mídia só depois do envio para aprovação, cancele e reagende o conteúdo.',
  CONTENT_MEDIA_INVALID: 'A mídia ou a capa escolhida não pode ser usada neste conteúdo.',
  CONTENT_FOLDER_INVALID: 'A pasta escolhida não é uma pasta deste cliente.',
  CONTENT_FOLDER_IN_USE: 'A pasta não muda enquanto o conteúdo tem mídia ou capa.',
  CONTENT_OWNER_INVALID: 'O responsável precisa ser um colaborador ativo que vê Conteúdo.',
  CONTENT_STATE: 'O conteúdo não está no estado que esta ação exige.',
  CONTENT_REVISION_CHANGED: 'O conteúdo mudou desde que você o leu. Recarregue e confira antes de aprovar.',
  CONTENT_UNPUBLISH_EXPIRED: 'A publicação só se desfaz no dia em que foi marcada.',
  CONTENT_TASKS_NOT_APPROVED: 'Todas as subtarefas precisam estar aprovadas antes do envio.',
  CONTENT_MEDIA_NOT_CONFIRMED: 'O conteúdo tem mídia que ainda não terminou de subir. Espere o envio terminar ou troque a mídia.',
  CONTENT_PUBLISHED_ON_INVALID: 'A data real da publicação não pode ser futura (dia de São Paulo).',
  CONTENT_REASON_INVALID: 'Informe o motivo da aprovação, com até 5000 bytes.',
  TRY_AGAIN: 'Houve um conflito momentâneo. Tente de novo.',
  STORY_SCRIPT_STATE: 'O roteiro não está no estado que esta ação exige.',
  STORY_SCENES_MISMATCH: 'O roteiro mudou: recarregue e envie todas as cenas, na ordem desejada.',
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
const threadId = '99999999-9999-4999-8999-999999999999';
const commentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const folderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const storyScriptId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const storySceneId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const storyScriptExample = {
  id: storyScriptId,
  scriptOn: '2026-10-20',
  status: 'draft',
  scenes: [
    { id: storySceneId, position: 1, text: 'Abrir a loja e mostrar a vitrine nova.', guidance: 'Filmar na vertical, com luz natural.' },
    { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', position: 2, text: 'Contar a promoção da semana.', guidance: null }
  ],
  recordedBy: null,
  recordedAt: null,
  createdAt: '2026-10-11T12:00:00.000Z'
} as const;

const portalStoryScriptExample = {
  id: storyScriptId,
  scriptOn: '2026-10-20',
  status: 'sent',
  scenes: [
    { position: 1, text: 'Abrir a loja e mostrar a vitrine nova.', guidance: 'Filmar na vertical, com luz natural.' },
    { position: 2, text: 'Contar a promoção da semana.', guidance: null }
  ],
  recordedBy: null,
  recordedAt: null
} as const;

const contentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const contentExample = {
  id: contentId,
  clientId,
  title: 'Lançamento da coleção de outono',
  platform: 'instagram',
  format: 'reels',
  publishOn: '2026-10-20',
  publishAtTime: '18:30',
  caption: 'A coleção chegou. Vem ver.',
  folderId,
  coverAssetId: null,
  owner: { membershipId, name: 'Ana Souza' },
  status: 'in_production',
  revision: 1,
  approvedBy: null,
  approvedAt: null,
  approvedByAgencyReason: null,
  publishedOn: null,
  cancelledAt: null,
  createdAt: '2026-10-11T12:00:00.000Z'
} as const;

const contentTaskExample = {
  id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
  title: 'Gravar o vídeo',
  description: null,
  assignee: { membershipId, name: 'Ana Souza' },
  dueOn: '2026-10-15',
  status: 'pending',
  returnComment: null,
  approvedBy: null,
  approvedAt: null
} as const;

const contentDetailExample = {
  ...contentExample,
  media: [{ id: assetId, position: 1 }],
  tasks: [contentTaskExample],
  conversation: { threadId: null, commentCount: 0, lastCommentAt: null }
} as const;

const contentPeriodExample = {
  data: {
    contents: [{
      id: contentId,
      title: 'Lançamento da coleção de outono',
      platform: 'instagram',
      format: 'reels',
      publishOn: '2026-10-20',
      publishAtTime: '18:30',
      status: 'in_production',
      owner: { membershipId, name: 'Ana Souza' },
      coverAssetId: null,
      revision: 1,
      publishedOn: null,
      tasksTotal: 3,
      tasksApproved: 1
    }],
    storyScripts: [{ id: storyScriptId, scriptOn: '2026-10-21', status: 'draft' }]
  },
  meta: { from: '2026-10-01', to: '2026-10-31', count: 2 }
} as const;

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

const commentExample = {
  id: commentId,
  body: 'Podemos aproximar o tom de voz do que usamos nas redes?',
  side: 'client',
  author: { name: 'Ana, da Padaria Central', photoUrl: null },
  createdAt: '2026-10-07T12:00:00.000Z'
} as const;

const threadExample = {
  id: threadId,
  subject: { sectionKey: 'tone_of_voice' },
  state: 'open',
  openedBy: { name: 'Ana, da Padaria Central', side: 'client' },
  lastComment: { side: 'client', at: '2026-10-07T12:00:00.000Z', excerpt: 'Podemos aproximar o tom de voz do que usamos nas redes?' },
  commentCount: 1,
  resolvedBy: null,
  resolvedAt: null
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

const clientMemberExample = {
  membershipId,
  name: 'Maria Souza',
  email: 'maria@padariacentral.exemplo.test',
  status: 'active',
  since: '2026-09-02T12:00:00.000Z'
} as const;

const portalBrandStudyExample = {
  filled: 3,
  sections: [
    { key: 'branding', body: 'Marca acolhedora.', colors: null, archetype: null, updatedAt: '2026-09-30T12:00:00.000Z' },
    { key: 'tone_of_voice', body: null, colors: null, archetype: null, updatedAt: null },
    { key: 'colors', body: null, colors: [{ name: 'Vinho', hex: '#7A1F2B' }], archetype: null, updatedAt: '2026-09-30T12:00:00.000Z' },
    { key: 'positioning', body: null, colors: null, archetype: null, updatedAt: null },
    { key: 'archetype', body: null, colors: null, archetype: 'caregiver', updatedAt: '2026-09-30T12:00:00.000Z' },
    { key: 'personas', body: null, colors: null, archetype: null, updatedAt: null },
    { key: 'observations', body: null, colors: null, archetype: null, updatedAt: null }
  ],
  personas: [{
    id: personaId,
    name: 'Dona Maria',
    description: 'Dona de casa, 58 anos.',
    pains: 'Pouco tempo para pesquisar.',
    desires: 'Reconhecimento da comunidade.',
    objections: 'Preço acima do esperado.',
    status: 'active',
    updatedAt: '2026-09-30T12:00:00.000Z'
  }]
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
    method: 'get',
    path: '/auth/session/check',
    operationId: 'getAuthSessionCheck',
    module: 'auth',
    summary: 'Confere se a sessão continua válida, sem renová-la',
    description: 'Para a aba aberta conferir a própria sessão de tempos em tempos (a pessoa removida é deslogada na hora, #411). Responde o mesmo que `GET /auth/session`, mas não conta como uso: `expiresAt` e `updatedAt` não mudam e nenhum cookie é emitido, então uma aba esquecida não mantém a sessão viva além dos 7 dias sem uso. Sessão encerrada ou revogada responde 401.',
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
    description: 'O papel vem preso ao convite; o e-mail sai pelo serviço de e-mail e o token só existe nele. Convidar com o papel `admin` exige também `colaborador.atribuir_admin`, que só o Owner tem (403). A resposta informa o convite pendente que esta criação revogou, quando havia um.',
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.convidar',
    params: AgencyPathParamsSchema,
    body: CollaboratorInvitationRequestSchema,
    requestExample: { email: 'colaborador@exemplo.test', roleId },
    responses: [{
      status: 201,
      description: 'Convite criado e enviado.',
      schema: CollaboratorInvitationCreatedResponseSchema,
      example: { invitationId, expiresAt: '2026-10-02T12:00:00.000Z', supersededInvitationId: null }
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
      { status: 409, code: 'TRY_AGAIN' },
      { status: 502, code: 'EMAIL_DELIVERY_FAILED' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/invitations',
    operationId: 'createClientInvitation',
    module: 'invitations',
    summary: 'Convida uma pessoa para o portal de um cliente',
    description: [
      'Cria o convite de portal, que é independente do vínculo de colaborador. Cliente arquivado responde',
      '409 `CLIENT_ARCHIVED`: o convite nasceria morto, porque arquivar revoga os pendentes e o aceite recusa.'
    ].join('\n'),
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
      { status: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode receber convites.' },
      { status: 409, code: 'MEMBERSHIP_EXISTS' },
      { status: 409, code: 'TRY_AGAIN' },
      { status: 502, code: 'EMAIL_DELIVERY_FAILED' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/invitations/:invitationId/resend',
    operationId: 'resendInvitation',
    module: 'invitations',
    summary: 'Reenvia um convite pendente',
    description: 'Revoga o convite atual e cria outro com token novo, para o link antigo deixar de valer. Reenviar um convite com o papel `admin` exige também `colaborador.atribuir_admin`, que só o Owner tem (403). O reenvio de convite de portal de um cliente que acabou de ser arquivado responde 409 `CLIENT_ARCHIVED` e o convite segue como estava.',
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
      { status: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode receber convites.' },
      { status: 409, code: 'TRY_AGAIN' },
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
      { status: 409, code: 'INVITATION_NOT_PENDING' },
      { status: 409, code: 'TRY_AGAIN' }
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
      { status: 409, code: 'TRY_AGAIN' },
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
      { status: 409, code: 'TRY_AGAIN' },
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
    path: '/agencies/:agencyId/clients/:clientId/contents',
    operationId: 'listContentsByPeriod',
    module: 'contents',
    summary: 'Consulta os conteúdos e os roteiros de stories de um período',
    description: [
      'A consulta por período, o formato que Tarefas e Dashboard copiam: `from` e `to` são dias',
      '`AAAA-MM-DD`, ambos incluídos, e o período tem no máximo 93 dias contando os dois extremos',
      '(93 passa, 94 não). Sem paginação: a resposta traz um vetor por tipo de item em `data`, e',
      '`meta.count` soma os dois. Acima de 500 itens a resposta é `400 CONTENT_PERIOD_TOO_LARGE`, sem',
      'truncar. Ordem: data, hora (sem hora por último) e id. O conteúdo vem sem legenda e sem mídia;',
      '`tasksTotal` e `tasksApproved` dão o percentual das subtarefas. Cancelados vêm com o estado',
      '`cancelled`. Cliente arquivado também responde: o conteúdo dele é só leitura.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.visualizar',
    params: AgencyClientPathParamsSchema,
    query: ContentPeriodQuerySchema,
    requestExample: { from: '2026-10-01', to: '2026-10-31' },
    responses: [{ status: 200, description: 'Conteúdos e roteiros do período.', schema: ContentPeriodResponseSchema, example: contentPeriodExample }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'CONTENT_PERIOD_TOO_LARGE' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents',
    operationId: 'createContent',
    module: 'contents',
    summary: 'Cria um conteúdo em produção',
    description: [
      'Exige `conteudo.operar` e também `conteudo.visualizar`. O conteúdo nasce em produção; o estado',
      'não é campo do corpo. `platform` é `instagram` e é o padrão. O responsável é quem cria, a não ser',
      'que `ownerMembershipId` nomeie o vínculo ativo de outro colaborador da agência que veja Conteúdo (`400 CONTENT_OWNER_INVALID`',
      'para vínculo removido, de outra agência, do portal ou que não existe). A resposta traz o responsável como `owner: { membershipId, name }`',
      '(`null` para quem não tem vínculo com a agência). Nenhuma rota de conteúdo devolve o id de usuário de ninguém: quem aprovou vem como',
      '`approvedBy: { name, side }` (`agency` ou `client`) e o responsável de uma subtarefa como `assignee: { membershipId, name }`.',
      'A pasta e a capa são do próprio cliente (`400 CONTENT_FOLDER_INVALID`, `400 CONTENT_MEDIA_INVALID`).',
      'Título de uma linha até 120 caracteres e legenda até 2.200 caracteres recusam caractere de',
      'controle e invisível. Cliente arquivado responde `409 CLIENT_ARCHIVED`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientPathParamsSchema,
    body: CreateContentRequestSchema,
    requestExample: { title: 'Lançamento da coleção de outono', format: 'reels', publishOn: '2026-10-20', publishAtTime: '18:30', folderId },
    responses: [{ status: 201, description: 'Conteúdo criado, em produção.', schema: ContentDetailSchema, example: contentDetailExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'CONTENT_FOLDER_INVALID' },
      { status: 400, code: 'CONTENT_MEDIA_INVALID' },
      { status: 400, code: 'CONTENT_OWNER_INVALID' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId',
    operationId: 'getContent',
    module: 'contents',
    summary: 'Lê um conteúdo com as mídias, as subtarefas e o resumo da conversa',
    description: [
      'O conteúdo inteiro, mais `media` (id e posição, em ordem), `tasks` (só leitura aqui) e',
      '`conversation` (`threadId` nulo enquanto ninguém comentou, `commentCount` e `lastCommentAt`).',
      'Um conteúdo de outro cliente, de outra agência ou que não existe responde o mesmo 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.visualizar',
    params: AgencyClientContentPathParamsSchema,
    responses: [{ status: 200, description: 'Conteúdo.', schema: ContentDetailSchema, example: contentDetailExample }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Content not found.' }
    ]
  },
  {
    method: 'patch',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId',
    operationId: 'updateContent',
    module: 'contents',
    summary: 'Edita um conteúdo; mover de data é editar `publishOn`',
    description: [
      'Qualquer subconjunto de `title`, `format`, `publishOn`, `publishAtTime` (`null` limpa),',
      '`caption`, `folderId`, `coverAssetId` e `ownerMembershipId` (o vínculo ativo do novo responsável); exige `conteudo.operar` e também',
      '`conteudo.visualizar`. Mudar a legenda, a capa ou o formato de um conteúdo aprovado o devolve',
      'a `awaiting_approval` e sobe `revision`; mudar data, hora, título ou responsável mantém a aprovação.',
      'Trocar o responsável exige `conteudo.aprovar_pela_agencia` (`403` sem ela). `mediaAssetIds` é a lista',
      'inteira e ordenada das mídias, gravada na mesma transação, depois do formato: assim um conteúdo em',
      'produção ou em ajuste troca de formato e de mídia numa só chamada. Depois do envio para aprovação, ir de',
      'carrossel para formato de uma mídia só (ou o inverso) é `409 CONTENT_MEDIA_INCOMPLETE`: cancele e',
      'reagende. Conteúdo publicado ou cancelado responde `409 CONTENT_NOT_EDITABLE`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientContentPathParamsSchema,
    body: UpdateContentRequestSchema,
    requestExample: { publishOn: '2026-10-22', caption: 'A coleção chegou. Vem ver.' },
    responses: [{ status: 200, description: 'Conteúdo atualizado.', schema: ContentDetailSchema, example: contentDetailExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'CONTENT_FOLDER_INVALID' },
      { status: 400, code: 'CONTENT_MEDIA_INVALID' },
      { status: 400, code: 'CONTENT_OWNER_INVALID' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Content not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_NOT_EDITABLE' },
      { status: 409, code: 'CONTENT_MEDIA_INCOMPLETE' },
      { status: 409, code: 'CONTENT_FOLDER_IN_USE' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/submit',
    operationId: 'submitContent',
    module: 'contents',
    summary: 'Envia o conteúdo para aprovação',
    description: [
      'Conteúdo em produção ou em ajuste passa a aguardar aprovação e entra na fila de e-mail do cliente (uma vez por pessoa',
      'ativa do portal). Repetir o envio de um conteúdo que já aguarda não muda nada e não é erro. Exige `conteudo.operar` e',
      '`conteudo.visualizar`. Recusa com `409` o conteúdo sem mídia completa para o formato (`CONTENT_MEDIA_INCOMPLETE`, também',
      'quando a capa foi removida da pasta), com mídia que ainda não terminou de subir (`CONTENT_MEDIA_NOT_CONFIRMED`) e com',
      'subtarefa que não está aprovada (`CONTENT_TASKS_NOT_APPROVED`). Cliente arquivado responde `409 CLIENT_ARCHIVED`,',
      'também quando o arquivamento termina durante a chamada.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientContentPathParamsSchema,
    responses: [{ status: 200, description: 'Conteúdo aguardando aprovação.', schema: ContentDetailSchema, example: { ...contentDetailExample, status: 'awaiting_approval' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Content not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_STATE', message: 'Só um conteúdo em produção ou em ajuste é enviado para aprovação.' },
      { status: 409, code: 'CONTENT_MEDIA_INCOMPLETE', message: 'A mídia ou a capa do conteúdo não está completa para este formato: falta mídia, ou a mídia ou a capa foi removida da pasta.' },
      { status: 409, code: 'CONTENT_MEDIA_NOT_CONFIRMED' },
      { status: 409, code: 'CONTENT_TASKS_NOT_APPROVED' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/approve-by-agency',
    operationId: 'approveContentByAgency',
    module: 'contents',
    summary: 'Registra a aprovação feita fora da plataforma',
    description: [
      'Conteúdo que aguarda aprovação passa a aprovado ("pronto para publicar"), com o motivo. Exige',
      '`conteudo.aprovar_pela_agencia` e `conteudo.visualizar`. `revision` é a revisão que a pessoa leu: se a legenda, a capa, o',
      'formato ou a mídia mudou desde então, a resposta é `409 CONTENT_REVISION_CHANGED` e nada é aprovado. O motivo é obrigatório,',
      'sem caractere de controle nem invisível (`400 VALIDATION_ERROR`), com até 5000 bytes. Quem aprovou e quando são fixados',
      'pelo banco, nunca campos do corpo. Aprovar de novo um conteúdo aprovado não muda nada e mantém quem aprovou primeiro.',
      'Conteúdo com mídia que não terminou de subir não é aprovado (`409 CONTENT_MEDIA_NOT_CONFIRMED`).'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.aprovar_pela_agencia',
    params: AgencyClientContentPathParamsSchema,
    body: ApproveContentByAgencyRequestSchema,
    requestExample: { revision: 1, reason: 'O cliente aprovou por telefone em 11/10.' },
    responses: [{
      status: 200,
      description: 'Conteúdo aprovado.',
      schema: ContentDetailSchema,
      example: {
        ...contentDetailExample,
        status: 'approved',
        approvedBy: { name: 'Ana Souza', side: 'agency' },
        approvedAt: '2026-10-11T12:30:00.000Z',
        approvedByAgencyReason: 'O cliente aprovou por telefone em 11/10.'
      }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'CONTENT_REASON_INVALID' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Content not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_STATE', message: 'Só um conteúdo aguardando aprovação é aprovado.' },
      { status: 409, code: 'CONTENT_REVISION_CHANGED' },
      { status: 409, code: 'CONTENT_MEDIA_NOT_CONFIRMED' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/publish',
    operationId: 'publishContent',
    module: 'contents',
    summary: 'Marca o conteúdo aprovado como publicado',
    description: [
      'Exige `conteudo.publicar` e `conteudo.visualizar`. `publishedOn` é o dia real da publicação; sem ele vale hoje, no dia de',
      'America/Sao_Paulo. Pode ser anterior, nunca futuro (`400 CONTENT_PUBLISHED_ON_INVALID`). O corpo pode ir vazio. Só conteúdo aprovado',
      'é publicado (`409 CONTENT_STATE`), e a mídia é conferida de novo (`409 CONTENT_MEDIA_INCOMPLETE` ou',
      '`CONTENT_MEDIA_NOT_CONFIRMED`). Marcar de novo um conteúdo publicado não muda nada. A fila de e-mail recebe o resumo do dia.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.publicar',
    params: AgencyClientContentPathParamsSchema,
    body: PublishContentRequestSchema,
    requestExample: { publishedOn: '2026-10-10' },
    responses: [{ status: 200, description: 'Conteúdo publicado.', schema: ContentDetailSchema, example: { ...contentDetailExample, status: 'published', publishedOn: '2026-10-10' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'CONTENT_PUBLISHED_ON_INVALID' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Content not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_STATE', message: 'Só um conteúdo aprovado é marcado como publicado.' },
      { status: 409, code: 'CONTENT_MEDIA_INCOMPLETE', message: 'A mídia ou a capa do conteúdo não está completa para este formato: falta mídia, ou a mídia ou a capa foi removida da pasta.' },
      { status: 409, code: 'CONTENT_MEDIA_NOT_CONFIRMED' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/unpublish',
    operationId: 'unpublishContent',
    module: 'contents',
    summary: 'Desfaz a publicação no mesmo dia',
    description: [
      'Conteúdo publicado volta a aprovado, e a data real e o instante da marcação são apagados; a aprovação continua. Vale só no',
      'dia (America/Sao_Paulo) em que a publicação foi marcada, não no dia da data real informada: em outro dia a resposta é',
      '`409 CONTENT_UNPUBLISH_EXPIRED`. Exige `conteudo.publicar` e `conteudo.visualizar`. Desfazer um conteúdo que já está aprovado',
      'não muda nada.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.publicar',
    params: AgencyClientContentPathParamsSchema,
    responses: [{ status: 200, description: 'Conteúdo aprovado de novo.', schema: ContentDetailSchema, example: { ...contentDetailExample, status: 'approved' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Content not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_STATE', message: 'Só um conteúdo publicado volta a aprovado.' },
      { status: 409, code: 'CONTENT_UNPUBLISH_EXPIRED' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/cancel',
    operationId: 'cancelContent',
    module: 'contents',
    summary: 'Cancela o conteúdo (ele fica guardado)',
    description: [
      'Qualquer estado menos publicado passa a cancelado, sem apagar nada, e a aprovação é desfeita. Exige `conteudo.cancelar` e',
      '`conteudo.visualizar`. Conteúdo publicado não se cancela (`409 CONTENT_STATE`); cancelar de novo um cancelado não muda nada.',
      'O conteúdo de cliente arquivado é só leitura: `409 CLIENT_ARCHIVED`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.cancelar',
    params: AgencyClientContentPathParamsSchema,
    responses: [{ status: 200, description: 'Conteúdo cancelado.', schema: ContentDetailSchema, example: { ...contentDetailExample, status: 'cancelled', cancelledAt: '2026-10-11T12:30:00.000Z' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Content not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_STATE', message: 'Um conteúdo publicado não é cancelado.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/reschedule',
    operationId: 'rescheduleContent',
    module: 'contents',
    summary: 'Reagenda um conteúdo cancelado',
    description: [
      'Conteúdo cancelado volta a em produção, com `publishOn` como novo dia (o dia que tinha, se o corpo vier vazio). Exige',
      '`conteudo.operar` e `conteudo.visualizar`. Só conteúdo cancelado é reagendado (`409 CONTENT_STATE`); para mover a data de',
      'outro conteúdo, edite `publishOn`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientContentPathParamsSchema,
    body: RescheduleContentRequestSchema,
    requestExample: { publishOn: '2026-11-03' },
    responses: [{ status: 200, description: 'Conteúdo em produção de novo.', schema: ContentDetailSchema, example: { ...contentDetailExample, publishOn: '2026-11-03' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Content not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_STATE', message: 'Só um conteúdo cancelado é reagendado.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/tasks',
    operationId: 'createContentTask',
    module: 'contents',
    summary: 'Cria uma subtarefa do conteúdo',
    description: [
      'A subtarefa nasce pendente. Exige `conteudo.operar` e também `conteudo.visualizar`. `assigneeMembershipId` é o vínculo ativo',
      'de um colaborador da agência que vê Conteúdo (nunca um id de usuário); qualquer outro vínculo (removido, de outra agência, do',
      'portal, inexistente ou de quem não vê Conteúdo) é `400 CONTENT_TASK_ASSIGNEE_INVALID`, sem dizer qual foi o motivo. O título',
      'segue o do conteúdo (uma linha, até 120 caracteres) e a descrição aceita quebras de linha, até 20000 bytes; texto só com',
      'caractere de controle ou invisível é `400 VALIDATION_ERROR`. Conteúdo publicado ou cancelado não recebe subtarefa',
      '(`409 CONTENT_TASK_STATE`). Um conteúdo tem até 50 subtarefas, em qualquer estado: a 51ª é `409 CONTENT_TASK_LIMIT`. O percentual do conteúdo (`tasksApproved` sobre `tasksTotal` da consulta por período) conta a nova.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientContentPathParamsSchema,
    body: CreateContentTaskRequestSchema,
    requestExample: { title: 'Gravar o vídeo', description: null, assigneeMembershipId: membershipId, dueOn: '2026-10-15' },
    responses: [{ status: 201, description: 'Subtarefa criada, pendente.', schema: ContentTaskSchema, example: contentTaskExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'CONTENT_TASK_ASSIGNEE_INVALID' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Content not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_TASK_STATE', message: 'Um conteúdo publicado ou cancelado não recebe subtarefas.' },
      { status: 409, code: 'CONTENT_TASK_LIMIT' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'patch',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/tasks/:taskId',
    operationId: 'updateContentTask',
    module: 'contents',
    summary: 'Edita uma subtarefa do conteúdo',
    description: [
      'Qualquer subconjunto de `title`, `description` (`null` limpa), `assigneeMembershipId` (o vínculo ativo do novo responsável) e',
      '`dueOn`; exige `conteudo.operar` e também `conteudo.visualizar`. O estado nunca é um campo: ele só muda por entregar, aprovar',
      'e devolver. As regras do responsável são as da criação (`400 CONTENT_TASK_ASSIGNEE_INVALID`). Uma subtarefa aprovada, ou de um',
      'conteúdo publicado ou cancelado, não se edita (`409 CONTENT_TASK_STATE`). A subtarefa precisa ser do conteúdo do caminho, senão',
      '`404`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientContentTaskPathParamsSchema,
    body: UpdateContentTaskRequestSchema,
    requestExample: { dueOn: '2026-10-16', assigneeMembershipId: membershipId },
    responses: [{ status: 200, description: 'Subtarefa atualizada.', schema: ContentTaskSchema, example: { ...contentTaskExample, dueOn: '2026-10-16' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'CONTENT_TASK_ASSIGNEE_INVALID' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Task not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_TASK_STATE', message: 'Uma subtarefa aprovada, ou de um conteúdo publicado ou cancelado, não é editada.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/tasks/:taskId/deliver',
    operationId: 'deliverContentTask',
    module: 'contents',
    summary: 'Entrega uma subtarefa',
    description: [
      'Só a pessoa responsável pela subtarefa entrega (`403` para qualquer outra, com ou sem outras permissões); a rota exige apenas',
      '`conteudo.visualizar`, porque quem entrega é um valor da linha e não uma permissão. A subtarefa pendente passa a entregue; entregar',
      'de novo uma entregue não muda nada. Uma subtarefa devolvida volta a pendente com o comentário e, ao ser entregue outra vez,',
      'o comentário some. Conteúdo publicado ou cancelado não muda (`409 CONTENT_TASK_STATE`).'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.visualizar',
    params: AgencyClientContentTaskPathParamsSchema,
    responses: [{ status: 200, description: 'Subtarefa entregue.', schema: ContentTaskSchema, example: { ...contentTaskExample, status: 'delivered' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Task not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_TASK_STATE', message: 'Só uma subtarefa pendente, de um conteúdo que não foi publicado nem cancelado, é entregue.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/tasks/:taskId/approve',
    operationId: 'approveContentTask',
    module: 'contents',
    summary: 'Aprova uma subtarefa entregue',
    description: [
      'Só a pessoa responsável pelo CONTEÚDO, ou quem tem `conteudo.aprovar_pela_agencia`, aprova (`403` para qualquer outra); a rota exige',
      'apenas `conteudo.visualizar`, porque o responsável do conteúdo é um valor da linha. A subtarefa entregue passa a aprovada, e',
      'quem aprovou e quando são fixados pelo banco; aprovar de novo uma aprovada não muda nada e mantém quem aprovou primeiro.',
      'O percentual do conteúdo passa a contar a subtarefa. Conteúdo publicado ou cancelado não muda (`409 CONTENT_TASK_STATE`).'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.visualizar',
    params: AgencyClientContentTaskPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Subtarefa aprovada.',
      schema: ContentTaskSchema,
      example: { ...contentTaskExample, status: 'approved', approvedBy: { name: 'Ana Souza', side: 'agency' }, approvedAt: '2026-10-11T12:30:00.000Z' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Task not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_TASK_STATE', message: 'Só uma subtarefa entregue, de um conteúdo que não foi publicado nem cancelado, é aprovada.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/contents/:contentId/tasks/:taskId/return',
    operationId: 'returnContentTask',
    module: 'contents',
    summary: 'Devolve uma subtarefa entregue, com comentário',
    description: [
      'Quem pode é quem aprova (a pessoa responsável pelo conteúdo ou `conteudo.aprovar_pela_agencia`; `403` para qualquer outra). A',
      'subtarefa entregue volta a pendente e o comentário fica nela (`returnComment`), até ser entregue de novo. O comentário é',
      'obrigatório, sem caractere de controle nem invisível (`400 VALIDATION_ERROR`), com até 5000 bytes. Ele não vai para a conversa',
      'do conteúdo: essa conversa é do cliente, e o portal nunca vê subtarefa.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.visualizar',
    params: AgencyClientContentTaskPathParamsSchema,
    body: ReturnContentTaskRequestSchema,
    requestExample: { comment: 'Falta a legenda em português no vídeo.' },
    responses: [{
      status: 200,
      description: 'Subtarefa pendente de novo, com o comentário.',
      schema: ContentTaskSchema,
      example: { ...contentTaskExample, returnComment: 'Falta a legenda em português no vídeo.' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'CONTENT_TASK_COMMENT_INVALID' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Task not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'CONTENT_TASK_STATE', message: 'Só uma subtarefa entregue, de um conteúdo que não foi publicado nem cancelado, é devolvida.' },
      { status: 409, code: 'TRY_AGAIN' }
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
      'cargo e status. A lista é a mesma para todos os papéis; a foto vem como URL assinada.',
      '`status=removed` mostra quem saiu do quadro e exige `colaborador.remover` ou',
      '`colaborador.alterar_papel` (o Owner passa por posse): sem elas, 403.'
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
          isSelf: false,
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
      'Um vínculo de outra agência, inexistente ou malformado devolve o mesmo 404, sem revelar',
      'existência; um vínculo removido também, exceto para quem pode ver removidos (`colaborador.remover`',
      'ou `colaborador.alterar_papel`, ou o Owner).'
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
        isSelf: false,
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
      'Aceita `jobTitle` (até 256 caracteres, com ao menos uma letra ou número e sem caracteres de controle,',
      'de formato, invisíveis nem separadores de linha, como o nome de uma pessoa; `null` ou texto em branco',
      'limpam o cargo),',
      '`roleId`, ou os dois; corpo vazio é 400. Basta uma das duas permissões para chegar à rota, mas a exigida',
      'é a de cada campo presente:',
      '`jobTitle` pede `colaborador.alterar_funcao`, `roleId` pede `colaborador.alterar_papel`, e os dois pedem',
      'as duas. Se o papel for `admin`, pede também `colaborador.atribuir_admin`, que só o Owner tem.',
      'O papel e o cargo do Owner não mudam, e ninguém altera o próprio papel nem o próprio cargo (403). Um vínculo de outra agência,',
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
        isSelf: false,
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
    method: 'post',
    path: '/agencies/:agencyId/collaborators/:membershipId/remove',
    operationId: 'removeCollaborator',
    module: 'collaborators',
    summary: 'Remove um colaborador do quadro',
    description: [
      'Coloca o vínculo em `removed`; a linha permanece e a pessoa perde o acesso à agência na',
      'requisição seguinte. Todas as sessões dela são encerradas na mesma transação, também as que ela',
      'tem em outras agências: o cookie antigo recebe 401, e quem remove não perde a própria sessão.',
      'O Owner não é removido e ninguém remove a si mesmo (403). Remover um',
      'vínculo que já está removido é 409. Um vínculo de outra agência, inexistente ou malformado',
      'devolve 404. Devolve o vínculo já em `removed`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.remover',
    params: AgencyCollaboratorPathParamsSchema,
    responses: [{
      status: 200,
      description: 'O colaborador removido.',
      schema: CollaboratorSchema,
      example: {
        membershipId,
        name: 'Camila Nogueira',
        email: 'camila@exemplo.test',
        photoUrl: null,
        jobTitle: 'Editor de Vídeo',
        role: { key: 'production', name: 'Produção' },
        isOwner: false,
        isSelf: false,
        status: 'removed',
        joinedAt: '2026-03-12T12:00:00.000Z'
      }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' },
      { status: 409, code: 'COLLABORATOR_ALREADY_REMOVED' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },

  {
    method: 'post',
    path: '/agencies/:agencyId/collaborators/:membershipId/reactivate',
    operationId: 'reactivateCollaborator',
    module: 'collaborators',
    summary: 'Reativa um colaborador removido',
    description: [
      'Volta o mesmo vínculo para `active` com o papel de `roleId`, que é obrigatório: o papel',
      'anterior nunca é reaproveitado. Se o papel for `admin`, exige também `colaborador.atribuir_admin`,',
      'que só o Owner tem (403). Reativar um vínculo que não está removido é 409, e papel que não é de',
      'sistema nem da agência é 400 `INVALID_ROLE`. Um vínculo de outra agência, inexistente ou',
      'malformado devolve 404. Devolve o vínculo já em `active`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'colaborador.alterar_papel',
    params: AgencyCollaboratorPathParamsSchema,
    body: ReactivateCollaboratorRequestSchema,
    requestExample: { roleId },
    responses: [{
      status: 200,
      description: 'O colaborador reativado.',
      schema: CollaboratorSchema,
      example: {
        membershipId,
        name: 'Camila Nogueira',
        email: 'camila@exemplo.test',
        photoUrl: null,
        jobTitle: 'Editor de Vídeo',
        role: { key: 'production', name: 'Produção' },
        isOwner: false,
        isSelf: false,
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
      { status: 404, code: 'NOT_FOUND', message: 'Agency not found.' },
      { status: 409, code: 'COLLABORATOR_NOT_REMOVED' }
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
      'thread aguardando a agência vem primeiro, depois nome ascendente, com `id` como desempate; para quem',
      'tem `conteudo.visualizar`, o cliente com conteúdo atrasado (data planejada anterior ao dia de São',
      'Paulo, sem publicado nem cancelado) vem antes de todos. `pendingInvitations` só vem para quem tem',
      '`cliente.convidar_usuario` e `contentIndicators` (`pending`, `inReview`, `overdue`, `adjusting`, `dueSoon`) só para quem',
      'tem `conteudo.visualizar`; para os demais o campo é omitido, não zerado, e a ordem não muda. As',
      'conversas de conteúdo não entram em `threadsAwaitingAgency`.'
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
          pendingInvitations: 1,
          contentIndicators: { pending: 3, inReview: 1, overdue: 2, adjusting: 1, dueSoon: 1 }
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
    method: 'put',
    path: '/agencies/:agencyId/clients/:clientId/closing',
    operationId: 'setClientClosing',
    module: 'clients',
    summary: 'Agenda o encerramento do contrato do cliente',
    description: [
      '`closingDate` é o último dia do contrato, `AAAA-MM-DD`, hoje ou depois no fuso `America/Sao_Paulo`;',
      'ontem ou uma data que não existe respondem 400 e nada muda. Até o fim da data o cliente continua',
      '`active` e o portal segue aberto; no dia seguinte o job diário arquiva. Agendar de novo troca a data.',
      'A data só muda por esta rota e por `DELETE`: o `PATCH` do cadastro não a alcança. Cliente arquivado',
      'responde 409.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.arquivar',
    params: AgencyClientPathParamsSchema,
    body: SetClientClosingRequestSchema,
    requestExample: { closingDate: '2026-12-31' },
    responses: [{
      status: 200,
      description: 'Cliente com a data de encerramento.',
      schema: ClientSchema,
      example: { ...clientExample, closingDate: '2026-12-31' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado: a única ação possível é reativar.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'delete',
    path: '/agencies/:agencyId/clients/:clientId/closing',
    operationId: 'clearClientClosing',
    module: 'clients',
    summary: 'Desmarca o encerramento agendado do cliente',
    description: [
      'Limpa a data de encerramento enquanto o cliente ainda não foi arquivado. Cliente sem encerramento',
      'agendado responde 409 e nada é gravado; cliente arquivado também responde 409.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.arquivar',
    params: AgencyClientPathParamsSchema,
    responses: [{ status: 200, description: 'Cliente sem data de encerramento.', schema: ClientSchema, example: clientExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado: a única ação possível é reativar.' },
      { status: 409, code: 'CLOSING_DATE_NOT_SET' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/archive',
    operationId: 'archiveClient',
    module: 'clients',
    summary: 'Arquiva o cliente agora',
    description: [
      'É o mesmo efeito do job diário, porque os dois chamam a mesma função: o portal responde 404 na',
      'requisição seguinte, os convites de portal pendentes são revogados, os vínculos das pessoas ficam',
      'preservados, a data de encerramento é limpa e um evento de auditoria é gravado. Não há',
      'pré-condição: arquiva-se com conversa aberta ou persona. Cliente arquivado fica somente leitura e',
      'arquivá-lo de novo responde 409. Se a requisição perder uma disputa com a mudança de um convite do',
      'mesmo cliente, responde 409 `TRY_AGAIN` e nada muda.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.arquivar',
    params: AgencyClientPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Cliente arquivado.',
      schema: ClientSchema,
      example: { ...clientExample, status: 'archived', archivedAt: '2026-10-07T12:00:00.000Z' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado: a única ação possível é reativar.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/reactivate',
    operationId: 'reactivateClient',
    module: 'clients',
    summary: 'Reativa um cliente arquivado',
    description: [
      'As pessoas que tinham vínculo voltam ao portal sem convite novo; os convites revogados no',
      'arquivamento não voltam. Se outro cliente ativo da agência já usa o nome, sem diferenciar maiúsculas,',
      'responde 409 e o cliente segue arquivado: renomeie um dos dois antes. Cliente que já está ativo',
      'responde 409.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.arquivar',
    params: AgencyClientPathParamsSchema,
    responses: [{ status: 200, description: 'Cliente ativo.', schema: ClientSchema, example: clientExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_NAME_IN_USE', message: 'Já existe um cliente ativo com este nome. Renomeie um dos dois antes de reativar.' },
      { status: 409, code: 'CLIENT_NOT_ARCHIVED' },
      { status: 409, code: 'TRY_AGAIN' }
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
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId/threads',
    operationId: 'listAgencyThreads',
    module: 'clients',
    summary: 'Lista as conversas de um assunto do cliente',
    description: [
      'O assunto é obrigatório e é exatamente um: `sectionKey` (uma das sete seções) ou `personaId`; os dois',
      'juntos, ou nenhum, são 400. `state` filtra por `open` ou `resolved`; sem ele vêm todas. Vinte por',
      'página, a de atividade mais recente primeiro. O estado é derivado: a conversa está resolvida só',
      'enquanto a resolução é posterior ao último comentário. Persona de outro cliente é 404; a conversa',
      'de persona arquivada continua legível para a agência.',
      'Com `contentId` o assunto é um conteúdo, que tem uma conversa só, e a permissão é `conteudo.visualizar`. Conteúdo de outro cliente, de outra agência ou inexistente é 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: CONVERSATION_READ_PERMISSIONS,
    params: AgencyClientPathParamsSchema,
    query: ThreadListQuerySchema,
    requestExample: { sectionKey: 'tone_of_voice', state: 'open' },
    responses: [{
      status: 200,
      description: 'Página de conversas.',
      schema: ThreadListResponseSchema,
      example: { data: [threadExample], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } }
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
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/threads',
    operationId: 'openAgencyThread',
    module: 'clients',
    summary: 'Abre uma conversa pela agência, com o primeiro comentário',
    description: [
      'Cria a conversa e o primeiro comentário na mesma transação, com o lado `agency`. O lado nunca vem',
      'do corpo: um campo `side` é 400. O comentário é aparado, não pode ficar vazio e limita a 5.000',
      'bytes. Cliente arquivado responde 409 `CLIENT_ARCHIVED`, persona arquivada 409 `PERSONA_ARCHIVED`',
      'e persona de outro cliente 404.',
      'Com `{ contentId }` a conversa é a do conteúdo, que é uma só: abrir de novo escreve nela. A agência precisa de `conteudo.operar` e `conteudo.visualizar`, e só escreve com o conteúdo em "aguardando aprovação" ou depois (senão 409 `CONTENT_NOT_OPEN`).'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: CONVERSATION_WRITE_PERMISSIONS,
    params: AgencyClientPathParamsSchema,
    body: CreateThreadRequestSchema,
    requestExample: { subject: { sectionKey: 'tone_of_voice' }, body: 'Vamos revisar o tom de voz com o time?' },
    responses: [{
      status: 201,
      description: 'Conversa aberta.',
      schema: CreateThreadResponseSchema,
      example: {
        thread: { ...threadExample, openedBy: { name: 'Dono da Agência', side: 'agency' }, lastComment: { side: 'agency', at: '2026-10-07T12:00:00.000Z', excerpt: 'Vamos revisar o tom de voz com o time?' } },
        comment: { ...commentExample, body: 'Vamos revisar o tom de voz com o time?', side: 'agency', author: { name: 'Dono da Agência', photoUrl: null } }
      }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'PERSONA_ARCHIVED' },
      { status: 409, code: 'CONTENT_NOT_OPEN' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId/threads/:threadId/comments',
    operationId: 'listAgencyThreadComments',
    module: 'clients',
    summary: 'Lista os comentários de uma conversa',
    description: [
      'Cinquenta por página, do mais antigo ao mais novo. O nome e a foto do autor vêm do vínculo do',
      'lado do comentário, e a pessoa removida mantém o nome, porque o comentário é histórico.',
      'Numa conversa de conteúdo a permissão é `conteudo.visualizar`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: CONVERSATION_READ_PERMISSIONS,
    params: AgencyClientThreadPathParamsSchema,
    query: CommentListQuerySchema,
    requestExample: { page: 1 },
    responses: [{
      status: 200,
      description: 'Página de comentários.',
      schema: CommentListResponseSchema,
      example: { data: [commentExample], meta: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 } }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Thread not found.' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/threads/:threadId/comments',
    operationId: 'addAgencyThreadComment',
    module: 'clients',
    summary: 'Comenta uma conversa pela agência',
    description: [
      'Grava o comentário com o lado `agency`; comentar numa conversa resolvida a reabre, sem escrever na',
      'conversa, porque o estado é derivado. Não existe rota de editar nem de apagar comentário.',
      'Cliente arquivado e persona arquivada respondem 409.',
      'Numa conversa de conteúdo, `conteudo.operar` e `conteudo.visualizar`; com o conteúdo em produção ou cancelado, 409 `CONTENT_NOT_OPEN`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: CONVERSATION_WRITE_PERMISSIONS,
    params: AgencyClientThreadPathParamsSchema,
    body: CreateCommentRequestSchema,
    requestExample: { body: 'Combinado, ajustamos esta semana.' },
    responses: [{ status: 201, description: 'Comentário gravado.', schema: CommentSchema, example: { ...commentExample, side: 'agency' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Thread not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'PERSONA_ARCHIVED' },
      { status: 409, code: 'CONTENT_NOT_OPEN' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/threads/:threadId/resolve',
    operationId: 'resolveThread',
    module: 'clients',
    summary: 'Resolve uma conversa',
    description: [
      'Grava `resolved_at` e `resolved_by`. Resolver uma conversa que já está resolvida não escreve nada.',
      'Não existe rota de reabrir: um comentário novo reabre. Só quem tem `cliente.operar` resolve; a',
      'pessoa do portal nunca.',
      'Na conversa de um conteúdo, `conteudo.operar` e `conteudo.visualizar`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: CONVERSATION_WRITE_PERMISSIONS,
    params: AgencyClientThreadPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Conversa resolvida.',
      schema: ThreadSchema,
      example: { ...threadExample, state: 'resolved', resolvedBy: { name: 'Dono da Agência' }, resolvedAt: '2026-10-07T13:00:00.000Z' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Thread not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'PERSONA_ARCHIVED' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId/members',
    operationId: 'listClientMembers',
    module: 'clients',
    summary: 'Lista as pessoas com acesso ao portal de um cliente',
    description: [
      'Vinte por página, por nome, sem diferenciar maiúsculas nem acento. `status` é `active` (padrão) ou',
      '`removed`. Nome e e-mail saem do vínculo da pessoa com o cliente. Cliente arquivado continua legível;',
      'cliente de outra agência, inexistente ou `:clientId` inválido devolvem o mesmo 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.convidar_usuario',
    params: AgencyClientPathParamsSchema,
    query: ClientMemberListQuerySchema,
    requestExample: { status: 'active' },
    responses: [{
      status: 200,
      description: 'Página de pessoas do portal.',
      schema: ClientMemberListResponseSchema,
      example: { data: [clientMemberExample], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } }
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
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/members/:membershipId/remove',
    operationId: 'removeClientMember',
    module: 'clients',
    summary: 'Remove uma pessoa do portal do cliente',
    description: [
      'A pessoa perde o acesso ao portal deste cliente na requisição seguinte; as demais pessoas do cliente',
      'e os vínculos dela com outros clientes não mudam. Todas as sessões dela são encerradas na mesma',
      'transação (a sessão é global): o cookie antigo recebe 401, e quem remove não perde a própria sessão.',
      'O vínculo é preservado como `removed` e pode ser reativado, o que não cria sessão.',
      'Remover quem já está removido não escreve nada, não encerra sessão e responde o vínculo como está. Cliente arquivado',
      'responde 409; vínculo de outro cliente ou id inválido, 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.remover_usuario',
    params: AgencyClientMemberPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Vínculo removido.',
      schema: ClientMemberSchema,
      example: { ...clientMemberExample, status: 'removed' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Member not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado: o acesso ao portal não pode ser alterado.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/members/:membershipId/reactivate',
    operationId: 'reactivateClientMember',
    module: 'clients',
    summary: 'Reativa uma pessoa do portal do cliente',
    description: [
      'A pessoa volta a entrar no portal na requisição seguinte, sem convite novo. Reativar quem já está',
      'ativo não escreve nada e responde o vínculo como está. Cliente arquivado responde 409; vínculo de',
      'outro cliente ou id inválido, 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.remover_usuario',
    params: AgencyClientMemberPathParamsSchema,
    responses: [{ status: 200, description: 'Vínculo reativado.', schema: ClientMemberSchema, example: clientMemberExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Member not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado: o acesso ao portal não pode ser alterado.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId/invitations',
    operationId: 'listClientInvitations',
    module: 'clients',
    summary: 'Lista os convites de portal pendentes de um cliente',
    description: [
      'Só convite de portal deste cliente que não foi aceito, nem revogado, nem expirou; o que expira primeiro',
      'vem antes, vinte por página. Convite de colaborador e convite de outro cliente nunca aparecem aqui,',
      'embora a policy de leitura deixe quem tem a permissão ver os de todos os tipos. Reenviar e cancelar',
      'são as rotas de convite que já existem.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'cliente.convidar_usuario',
    params: AgencyClientPathParamsSchema,
    query: ClientInvitationListQuerySchema,
    requestExample: { page: 1 },
    responses: [{
      status: 200,
      description: 'Página de convites pendentes.',
      schema: ClientInvitationListResponseSchema,
      example: {
        data: [{ invitationId, email: 'joao@padariacentral.exemplo.test', expiresAt: '2026-10-14T12:00:00.000Z' }],
        meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 }
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
    method: 'get',
    path: '/clients/:clientId/threads',
    operationId: 'listPortalThreads',
    module: 'clients',
    summary: 'Lista as conversas de um assunto, no portal',
    description: [
      'Mesmos parâmetros, paginação e forma da lista da agência, pelo mesmo serviço. Persona arquivada',
      'não é assunto válido no portal: responde 404 como se não existisse.',
      'Com `contentId`, só enquanto o conteúdo está aberto ao cliente; fora disso, e para conteúdo de outro cliente, 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com o cliente',
    permission: null,
    params: ClientPathParamsSchema,
    query: ThreadListQuerySchema,
    requestExample: { sectionKey: 'tone_of_voice' },
    responses: [{
      status: 200,
      description: 'Página de conversas.',
      schema: ThreadListResponseSchema,
      example: { data: [threadExample], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' }
    ]
  },
  {
    method: 'post',
    path: '/clients/:clientId/threads',
    operationId: 'openPortalThread',
    module: 'clients',
    summary: 'Abre uma conversa pelo portal, com o primeiro comentário',
    description: [
      'Grava a conversa e o primeiro comentário com o lado `client`, que a rota fixa. Seção que a agência',
      'ainda não preencheu responde 409 `SECTION_NOT_FILLED`; persona arquivada ou de outro cliente, 404.',
      'Com `{ contentId }`, só enquanto o conteúdo está em "aguardando aprovação", "em ajuste", "aprovado" ou "publicado"; fora disso, e para conteúdo de outro cliente, 404. A conversa do conteúdo é uma só: abrir de novo escreve nela.'
    ].join('\n'),
    access: 'Sessão + vínculo com o cliente',
    permission: null,
    params: ClientPathParamsSchema,
    body: CreateThreadRequestSchema,
    requestExample: { subject: { sectionKey: 'tone_of_voice' }, body: 'Podemos aproximar o tom de voz do que usamos nas redes?' },
    responses: [{
      status: 201,
      description: 'Conversa aberta.',
      schema: CreateThreadResponseSchema,
      example: { thread: threadExample, comment: commentExample }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'SECTION_NOT_FILLED' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'get',
    path: '/clients/:clientId/threads/:threadId/comments',
    operationId: 'listPortalThreadComments',
    module: 'clients',
    summary: 'Lista os comentários de uma conversa, no portal',
    description: 'Mesma paginação e forma da lista da agência. Conversa de outro cliente é 404. A conversa de um conteúdo que não está aberto ao cliente também é 404.',
    access: 'Sessão + vínculo com o cliente',
    permission: null,
    params: ClientThreadPathParamsSchema,
    query: CommentListQuerySchema,
    requestExample: { page: 1 },
    responses: [{
      status: 200,
      description: 'Página de comentários.',
      schema: CommentListResponseSchema,
      example: { data: [commentExample], meta: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 } }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Thread not found.' }
    ]
  },
  {
    method: 'post',
    path: '/clients/:clientId/threads/:threadId/comments',
    operationId: 'addPortalThreadComment',
    module: 'clients',
    summary: 'Comenta uma conversa pelo portal',
    description: [
      'Grava o comentário com o lado `client`; comentar numa conversa resolvida a reabre. Não existe',
      'rota de resolver no portal: só a agência resolve.',
      'A conversa de um conteúdo que não está aberto ao cliente é 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com o cliente',
    permission: null,
    params: ClientThreadPathParamsSchema,
    body: CreateCommentRequestSchema,
    requestExample: { body: 'Obrigada, ficou melhor assim.' },
    responses: [{ status: 201, description: 'Comentário gravado.', schema: CommentSchema, example: commentExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Thread not found.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'get',
    path: '/clients/:clientId',
    operationId: 'getPortalClient',
    module: 'clients',
    summary: 'Lê o cadastro do próprio cliente e o resumo do Início, no portal',
    description: [
      'Somente leitura. Traz o cadastro inteiro, a foto assinada, o nome da agência, `onboardingSeenAt` do',
      'vínculo de quem chama (nunca o de outra pessoa do mesmo cliente) e `home`: as conversas abertas com',
      'resposta da agência, só as que o portal enxerga, o preenchimento do estudo e `contentsAwaitingApproval`,',
      'os conteúdos do próprio cliente em "aguardando aprovação". A conversa de um conteúdo não entra em',
      '`threadsAnsweredByAgency`. Outro cliente, cliente arquivado, agência suspensa, vínculo removido e',
      'colaborador sem vínculo de cliente (Owner inclusive) devolvem o mesmo 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com o cliente',
    permission: null,
    params: ClientPathParamsSchema,
    query: PortalClientQuerySchema,
    responses: [{
      status: 200,
      description: 'Cadastro do cliente e resumo do Início.',
      schema: PortalClientResponseSchema,
      example: {
        ...clientExample,
        agencyName: 'Agência Exemplo',
        onboardingSeenAt: '2026-10-01T12:00:00.000Z',
        home: { threadsAnsweredByAgency: 2, brandStudyFilled: 3, contentsAwaitingApproval: 2 }
      }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' }
    ]
  },
  {
    method: 'get',
    path: '/clients/:clientId/brand-study',
    operationId: 'getPortalBrandStudy',
    module: 'clients',
    summary: 'Lê o estudo de marca, no portal',
    description: [
      'A mesma forma do estudo da agência, com duas diferenças: persona arquivada não vem, nem para o',
      'colaborador que também tem vínculo de cliente, e `updatedBy` não vem em seção nem em persona, porque',
      'quem editou por dentro é informação da agência. As sete seções vêm sempre; a que a agência não',
      'preencheu vem vazia.'
    ].join('\n'),
    access: 'Sessão + vínculo com o cliente',
    permission: null,
    params: ClientPathParamsSchema,
    query: PortalClientQuerySchema,
    responses: [{ status: 200, description: 'Estudo de marca.', schema: PortalBrandStudyResponseSchema, example: portalBrandStudyExample }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' }
    ]
  },

  {
    method: 'post',
    path: '/agencies/:agencyId/media/uploads',
    operationId: 'createMediaUpload',
    module: 'media',
    summary: 'Inicia um upload de mídia',
    description: [
      'Devolve a URL assinada de PUT ou o plano de multipart; o tipo real é validado no fim, pelo conteúdo.',
      'Sem `clientId` e `folderId` a mídia é da agência e exige `midia.enviar`. Com os dois, é a mídia de uma pasta do',
      'cliente e exige `conteudo.operar` **e** `conteudo.visualizar`: o servidor confere que a pasta é do cliente e o',
      'cliente é da agência (cliente de outra agência e pasta de outro cliente dão o mesmo 404), e a cota soma a agência inteira.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: MEDIA_UPLOAD_PERMISSIONS,
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
      { status: 404, code: 'NOT_FOUND', message: 'Folder not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'TRY_AGAIN' },
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
    permission: MEDIA_UPLOAD_PERMISSIONS,
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
    permission: MEDIA_UPLOAD_PERMISSIONS,
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
    description: 'Válida por poucos minutos, só GET, e apenas para um objeto confirmado e não removido da agência. A mídia sem cliente exige `midia.enviar`; a de um cliente exige `conteudo.visualizar` (a que o papel não lê é o mesmo 404). Em `variant=thumbnail`, a imagem devolve o próprio original e o vídeo devolve a miniatura quando processada, senão 409 `VARIANT_NOT_READY`. Só o pedido do original grava a auditoria `media.download_url_issued`.',
    access: 'Sessão + vínculo com a agência',
    permission: MEDIA_READ_PERMISSIONS,
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
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId/media-folders',
    operationId: 'listClientMediaFolders',
    module: 'media',
    summary: 'Lista as pastas de mídia de um cliente',
    description: [
      'As quatro pastas padrão e as da agência, as de primeiro nível antes das de trabalho; cem por página.',
      'Cliente arquivado continua legível; cliente de outra agência, inexistente ou `:clientId` inválido devolvem o mesmo 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.visualizar',
    params: AgencyClientPathParamsSchema,
    query: MediaFolderListQuerySchema,
    requestExample: { page: 1 },
    responses: [{
      status: 200,
      description: 'Página de pastas.',
      schema: MediaFolderListResponseSchema,
      example: {
        data: [{ id: folderId, parentId: null, name: 'Vídeos', isDefault: true, createdAt: '2026-10-07T12:00:00.000Z' }],
        meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
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
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/media-folders',
    operationId: 'createClientMediaFolder',
    module: 'media',
    summary: 'Cria uma pasta de mídia do cliente',
    description: [
      'No primeiro nível, ou dentro de uma pasta de primeiro nível do mesmo cliente (`parentId`): há só dois níveis.',
      'Exige `conteudo.operar` e também `conteudo.visualizar`, porque a resposta é uma leitura. O nome não aceita',
      'caracteres de controle, invisíveis nem joiners fora de uma sequência de emoji completa (família, bandeira de subdivisão, tom de pele), e tem até 80 caracteres.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientPathParamsSchema,
    body: CreateMediaFolderRequestSchema,
    requestExample: { name: 'Lançamento de outubro', parentId: folderId },
    responses: [{
      status: 201,
      description: 'Pasta criada.',
      schema: MediaFolderSchema,
      example: { id: '12121212-1212-4121-8121-121212121212', parentId: folderId, name: 'Lançamento de outubro', isDefault: false, createdAt: '2026-10-07T12:00:00.000Z' }
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
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets',
    operationId: 'listMediaFolderAssets',
    module: 'media',
    summary: 'Lista as mídias de uma pasta',
    description: [
      'Só a mídia confirmada e não removida, a mais recente primeiro; quarenta e oito por página. Nunca devolve chave de',
      'objeto. Cliente de outra agência, pasta de outro cliente e id inválido devolvem o mesmo 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.visualizar',
    params: AgencyClientMediaFolderPathParamsSchema,
    query: MediaFolderAssetListQuerySchema,
    requestExample: { page: 1 },
    responses: [{
      status: 200,
      description: 'Página de mídias.',
      schema: MediaFolderAssetListResponseSchema,
      example: {
        data: [{ id: assetId, category: 'image', contentType: 'image/png', sizeBytes: 1048576, videoProcessingStatus: 'not_applicable', createdAt: '2026-10-07T12:00:00.000Z' }],
        meta: { page: 1, pageSize: 48, totalItems: 1, totalPages: 1 }
      }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Folder not found.' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets/:assetId/remove',
    operationId: 'removeMediaFolderAsset',
    module: 'media',
    summary: 'Remove uma mídia da pasta',
    description: [
      'Remoção lógica: o arquivo sai da pasta e não pode mais ser escolhido em conteúdo, mas continua contando na cota',
      'até a retenção apagá-lo. Recusa (409 `MEDIA_IN_USE`) a mídia de um conteúdo aguardando aprovação, aprovado ou',
      'publicado, arquivo ou capa. Exige `conteudo.operar` e também `conteudo.visualizar`. Repetir a chamada não é erro.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientMediaFolderAssetPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Mídia removida da pasta.',
      schema: RemoveMediaAssetResponseSchema,
      example: { assetId, removed: true }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Media asset not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'MEDIA_IN_USE' },
      { status: 409, code: 'TRY_AGAIN' }
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
      { status: 409, code: 'TRY_AGAIN' },
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
      { status: 409, code: 'TRY_AGAIN' },
      { status: 429, code: 'RATE_LIMITED' }
    ]
  },

  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/story-scripts',
    operationId: 'createStoryScript',
    module: 'story-scripts',
    summary: 'Cria um roteiro de stories em rascunho',
    description: [
      'Um dia (`scriptOn`, `AAAA-MM-DD`) e as cenas na ordem em que foram enviadas, até 30. O roteiro nasce em',
      'rascunho e o portal não o vê. Pode haver mais de um roteiro por cliente e dia, e um roteiro sem cenas.',
      'O texto e a orientação da cena recusam caractere de controle (menos tabulação e quebra de linha) e',
      'invisível, inclusive o espaço de largura zero e os joiners fora de uma sequência de emoji completa. Precisa de `conteudo.operar` **e** de',
      '`conteudo.visualizar`: uma escrita que não lê o que escreveu é cega. Cliente arquivado dá 409, nas duas',
      'janelas da corrida com o arquivamento.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientPathParamsSchema,
    body: CreateStoryScriptRequestSchema,
    requestExample: {
      scriptOn: '2026-10-20',
      scenes: [
        { text: 'Abrir a loja e mostrar a vitrine nova.', guidance: 'Filmar na vertical, com luz natural.' },
        { text: 'Contar a promoção da semana.' }
      ]
    },
    responses: [{ status: 201, description: 'Roteiro criado, em rascunho.', schema: StoryScriptSchema, example: storyScriptExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'get',
    path: '/agencies/:agencyId/clients/:clientId/story-scripts/:scriptId',
    operationId: 'getStoryScript',
    module: 'story-scripts',
    summary: 'Lê um roteiro de stories, com as cenas',
    description: [
      'O roteiro em qualquer estado (rascunho, enviado ou gravado), com as cenas na ordem e os ids delas, que é o',
      'que o `PATCH` pede de volta. Precisa só de `conteudo.visualizar`; `conteudo.operar` sem ela dá 403. O cliente',
      'tem de ser o da agência da URL: roteiro de outro cliente, de outra agência, inexistente ou `:scriptId`',
      'inválido devolvem o mesmo 404. Cliente arquivado se lê: a agência vê, só não edita.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.visualizar',
    params: AgencyClientStoryScriptPathParamsSchema,
    responses: [{ status: 200, description: 'O roteiro, com as cenas.', schema: StoryScriptSchema, example: storyScriptExample }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Story script not found.' }
    ]
  },
  {
    method: 'patch',
    path: '/agencies/:agencyId/clients/:clientId/story-scripts/:scriptId',
    operationId: 'updateStoryScript',
    module: 'story-scripts',
    summary: 'Edita o dia e as cenas de um roteiro em rascunho',
    description: [
      'Só rascunho se edita: um roteiro enviado ou gravado dá 409 `STORY_SCRIPT_STATE`. `scenes` é o roteiro',
      'inteiro na nova ordem: cena com `id` é uma que já existe (texto, orientação e lugar mudam), cena sem',
      '`id` é nova. Cena não se remove, então a lista tem de trazer todas as que o roteiro tem; faltar uma, ou',
      'trazer o id de outro roteiro, dá 409 `STORY_SCENES_MISMATCH`. Roteiro de outro cliente, de outra agência,',
      'inexistente ou `:scriptId` inválido devolvem o mesmo 404. Precisa de `conteudo.operar` e de',
      '`conteudo.visualizar`.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientStoryScriptPathParamsSchema,
    body: UpdateStoryScriptRequestSchema,
    requestExample: {
      scriptOn: '2026-10-21',
      scenes: [
        { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', text: 'Contar a promoção da semana.' },
        { id: storySceneId, text: 'Abrir a loja e mostrar a vitrine nova.', guidance: 'Filmar na vertical.' },
        { text: 'Pedir para seguir o perfil.' }
      ]
    },
    responses: [{ status: 200, description: 'Roteiro editado.', schema: StoryScriptSchema, example: storyScriptExample }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      COMMON_ERRORS.payloadTooLarge,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Story script not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'STORY_SCRIPT_STATE' },
      { status: 409, code: 'STORY_SCENES_MISMATCH' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'post',
    path: '/agencies/:agencyId/clients/:clientId/story-scripts/:scriptId/send',
    operationId: 'sendStoryScript',
    module: 'story-scripts',
    summary: 'Envia o roteiro ao cliente',
    description: [
      'Rascunho passa a enviado e a aparecer no portal. Repetir o envio não muda nada e não é erro. Um roteiro',
      'já gravado não volta a ser enviado (409 `STORY_SCRIPT_STATE`), e cliente arquivado dá 409. Precisa de',
      '`conteudo.operar` e de `conteudo.visualizar`; quem só tem vínculo de cliente nunca envia.'
    ].join('\n'),
    access: 'Sessão + vínculo com a agência',
    permission: 'conteudo.operar',
    params: AgencyClientStoryScriptPathParamsSchema,
    responses: [{ status: 200, description: 'Roteiro enviado.', schema: StoryScriptSchema, example: { ...storyScriptExample, status: 'sent' } }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND', message: 'Story script not found.' },
      { status: 409, code: 'CLIENT_ARCHIVED' },
      { status: 409, code: 'STORY_SCRIPT_STATE' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  },
  {
    method: 'get',
    path: '/clients/:clientId/story-scripts',
    operationId: 'listPortalStoryScripts',
    module: 'story-scripts',
    summary: 'Lista os roteiros enviados de um período, no portal',
    description: [
      'Consulta por período, sem paginação: `from` e `to` inclusivos (`AAAA-MM-DD`), no máximo 93 dias (93 passa,',
      '94 dá 400) e 500 itens (acima disso, 400, sem truncar). Só roteiro enviado ou gravado, do dia mais antigo',
      'ao mais novo; rascunho nunca vem, nem para o colaborador que também tem vínculo de cliente. Um roteiro',
      'gravado mostra o nome de quem gravou, pelo vínculo com o cliente.'
    ].join('\n'),
    access: 'Sessão + vínculo com o cliente',
    permission: null,
    params: ClientPathParamsSchema,
    query: StoryScriptPeriodQuerySchema,
    requestExample: { from: '2026-10-01', to: '2026-10-31' },
    responses: [{
      status: 200,
      description: 'Roteiros do período.',
      schema: PortalStoryScriptPeriodResponseSchema,
      example: { data: [portalStoryScriptExample], meta: { from: '2026-10-01', to: '2026-10-31', count: 1 } }
    }],
    errors: [
      COMMON_ERRORS.internal,
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Client not found.' }
    ]
  },
  {
    method: 'post',
    path: '/clients/:clientId/story-scripts/:scriptId/recorded',
    operationId: 'recordPortalStoryScript',
    module: 'story-scripts',
    summary: 'Marca o roteiro como gravado, no portal',
    description: [
      'Qualquer pessoa ativa do portal deste cliente marca um roteiro enviado como gravado; quem gravou e quando',
      'são fixados pelo banco. Repetir não muda nada: a primeira pessoa continua sendo quem gravou. Rascunho,',
      'roteiro de outro cliente, de outra agência e id inexistente ou inválido devolvem o mesmo 404, também para o',
      'colaborador cujo papel lê rascunhos. Um cliente arquivado durante a chamada também é 404.'
    ].join('\n'),
    access: 'Sessão + vínculo com o cliente',
    permission: null,
    params: ClientStoryScriptPathParamsSchema,
    responses: [{
      status: 200,
      description: 'Roteiro gravado.',
      schema: PortalStoryScriptSchema,
      example: { ...portalStoryScriptExample, status: 'recorded', recordedBy: { name: 'Pessoa do Portal' }, recordedAt: '2026-10-20T15:00:00.000Z' }
    }],
    errors: [
      COMMON_ERRORS.csrf,
      COMMON_ERRORS.internal,
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 404, code: 'NOT_FOUND', message: 'Story script not found.' },
      { status: 409, code: 'TRY_AGAIN' }
    ]
  }
];
