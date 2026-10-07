import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearchParams, type SetURLSearchParams } from 'react-router-dom';
import { z } from 'zod';

import {
  AuthEmailSchema,
  AuthNoContentResponseSchema,
  ClientInvitationListResponseSchema,
  ClientMemberListResponseSchema,
  ClientMemberSchema,
  InvitationCreatedResponseSchema,
  type ClientMember,
  type ClientPendingInvitation,
  type ClientDetailResponse
} from '@ageniza/contracts';
import { Button, ConfirmDialog, FieldMessage, LiveStatus, Modal, Pagination, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { formatAgencyDayMonth, useClientDetail } from './client-detail.js';
import { HttpClientError, useApiClient } from './http.js';
import { inviteLinkDays } from './invite-collaborator.js';
import { pendingInviteExpiryLabel } from './pending-invitations.js';
import { NotFoundPage } from './status-pages.js';

/** `specs/clientes.md` §6: 20 per page for the portal people and the pending invitations. */
const PAGE_SIZE = 20;

const MEMBERS_FAILED = 'Não foi possível carregar as pessoas com acesso. Tente de novo.';
const INVITATIONS_FAILED = 'Não foi possível carregar os convites. Tente de novo.';
const REMOVE_FAILED = 'Não foi possível remover o acesso. Tente de novo.';
const REACTIVATE_FAILED = 'Não foi possível reativar o acesso. Tente de novo.';
const RESEND_FAILED = 'Não foi possível reenviar o convite. Tente de novo.';
const CANCEL_FAILED = 'Não foi possível cancelar o convite. Tente de novo.';
const NO_PERMISSION = 'Você não tem permissão para alterar o acesso deste cliente.';
const REMOVE_DESCRIPTION = 'A pessoa perde o acesso ao portal deste cliente. As outras pessoas não são afetadas.';
const INVITE_HINT = 'A pessoa recebe um link para criar a conta e entrar no portal deste cliente.';

const parsePage = (value: string | null): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
};

interface MemberFilters {
  readonly page: number;
  readonly status: 'active' | 'removed';
}

const membersPath = (agencyId: string, clientId: string, filters: MemberFilters): string => {
  const params: Array<[string, string]> = [['page', String(filters.page)], ['pageSize', String(PAGE_SIZE)]];
  if (filters.status === 'removed') params.push(['status', 'removed']);
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${apiPath('/agencies/:agencyId/clients/:clientId/members', { agencyId, clientId })}?${query}`;
};

const invitationsPath = (agencyId: string, clientId: string, page: number): string =>
  `${apiPath('/agencies/:agencyId/clients/:clientId/invitations', { agencyId, clientId })}?page=${page}&pageSize=${PAGE_SIZE}`;

const pageValue = (nextPage: number): string | null => (nextPage <= 1 ? null : String(nextPage));

/**
 * Moves one of the tab's page parameters, preserving the navigation state: the roster address the
 * card carried (issue #379) must survive paginating Pessoas, Removidas or Convites (review of #388).
 */
const replacePage = (setSearchParams: SetURLSearchParams, state: unknown, key: string, nextPage: number): void => {
  setSearchParams((previous) => {
    const next = new URLSearchParams(previous);
    const value = pageValue(nextPage);
    if (value === null) next.delete(key); else next.set(key, value);
    return next;
  }, { replace: true, state });
};

/** The last valid page for a loaded listing, or null when the URL page is still valid. */
const clampedPage = (page: number, data: { meta: { totalPages: number } } | undefined): number | null => {
  if (data === undefined) return null;
  const lastPage = Math.max(1, data.meta.totalPages);
  return page > lastPage ? lastPage : null;
};

interface PendingAction {
  readonly kind: 'remove' | 'reactivate' | 'cancel';
  readonly name: string;
  readonly id: string;
  readonly email?: string;
}

/** The invite modal (`specs/clientes.md` §7): the e-mail, and nothing else — the invite carries only it. */
function InviteClientDialog({ client, onClose }: { client: ClientDetailResponse; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const emailId = useId();
  const emailErrorId = useId();
  const hintId = useId();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [sent, setSent] = useState<{ email: string; days: number } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (sent === null) emailRef.current?.focus();
    else closeRef.current?.focus();
  }, [sent]);

  const invite = useMutation({
    mutationFn: (target: string) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/invitations', { agencyId: agency.agencyId, clientId: client.id }),
      method: 'POST',
      body: { email: target },
      response: InvitationCreatedResponseSchema
    }),
    onSuccess: (created, target) => {
      setSent({ email: target, days: inviteLinkDays(created.expiresAt) });
    },
    onError: (error: unknown) => {
      if (!(error instanceof HttpClientError)) { setFormError('Não foi possível enviar o convite. Tente de novo.'); return; }
      if (error.code === 'MEMBERSHIP_EXISTS') { setEmailError('Esta pessoa já tem acesso ao portal deste cliente.'); return; }
      if (error.code === 'CLIENT_ARCHIVED') { setFormError('Cliente arquivado: não é possível convidar para o portal.'); return; }
      if (error.code === 'FORBIDDEN' || error.status === 403) { setFormError('Você não tem permissão para convidar para este cliente.'); return; }
      if (error.status === 400) {
        const parsed = z.object({ issues: z.array(z.object({ path: z.string() })) }).safeParse(error.details);
        const refusedEmail = parsed.success && parsed.data.issues.some((issue) => issue.path === 'email' || issue.path.startsWith('email.'));
        if (refusedEmail) setEmailError('Informe um e-mail válido.');
        else setFormError('Revise os dados do convite.');
        return;
      }
      setFormError('Não foi possível enviar o convite. Tente de novo.');
    },
    // The API commits the invitation before it sends the e-mail: a 502 leaves a real invitation
    // behind, so the list refetches on settle to show what the server actually holds.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'clients'] });
    }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const target = email.trim().toLowerCase();
    if (target === '') { setEmailError('Informe o e-mail.'); return; }
    if (!AuthEmailSchema.safeParse(target).success) { setEmailError('Informe um e-mail válido.'); return; }
    invite.mutate(target);
  };

  if (sent !== null) {
    return <Modal title="Convidar para o portal" closeLabel="Fechar convite para o portal" onClose={onClose}>
      <div className="form-stack">
        <LiveStatus>Convite enviado para {sent.email}. O link vale por {sent.days} dias.</LiveStatus>
        <div className="form-actions">
          <Button ref={closeRef} onClick={onClose}>Fechar</Button>
        </div>
      </div>
    </Modal>;
  }

  return <Modal title="Convidar para o portal" closeLabel="Fechar convite para o portal" onClose={onClose}>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <div className="form-field">
        <label htmlFor={emailId}>E-mail</label>
        <TextInput
          ref={emailRef}
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => { setEmail(event.target.value); setEmailError(undefined); setFormError(undefined); }}
          aria-invalid={emailError !== undefined}
          aria-describedby={emailError === undefined ? hintId : `${hintId} ${emailErrorId}`}
        />
        <p id={hintId} className="form-hint">{INVITE_HINT}</p>
        {emailError !== undefined && <FieldMessage id={emailErrorId} role="alert">{emailError}</FieldMessage>}
      </div>
      {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
      <div className="form-actions">
        <Button type="submit" disabled={email.trim() === ''} loading={invite.isPending}>Enviar convite</Button>
      </div>
    </form>
  </Modal>;
}

/**
 * The portal-access tab (`specs/clientes.md` §7, issue #140): the people who enter the client's
 * portal, the removed ones and the pending invitations, with the same shape as the collaborators'
 * invitation section. Reading is `cliente.convidar_usuario` (the tab gate); removing and
 * reactivating need `cliente.remover_usuario`, resending and cancelling need their own permissions;
 * without them the action is simply absent. Every write invalidates the clients prefix, which
 * carries the roster badge, the detail summary and this tab's lists (SPEC §6 invalidation table).
 */
export function ClientAccessTab() {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const client = useClientDetail();
  const canRemove = useCan('cliente.remover_usuario');
  const canResend = useCan('convite.reenviar');
  const canCancel = useCan('convite.cancelar');
  const activeClient = client.status === 'active';
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [removedOpen, setRemovedOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | undefined>();
  const [resentEmail, setResentEmail] = useState<string | null>(null);

  const membersPage = parsePage(searchParams.get('membros'));
  const removedPage = parsePage(searchParams.get('removidas'));
  const invitationsPage = parsePage(searchParams.get('convites'));

  const members = useQuery({
    queryKey: ['agency', agency.agencyId, 'clients', client.id, 'members', { page: membersPage, status: 'active' }],
    queryFn: ({ signal }) => httpClient.request({
      path: membersPath(agency.agencyId, client.id, { page: membersPage, status: 'active' }),
      response: ClientMemberListResponseSchema,
      signal
    })
  });

  const removed = useQuery({
    queryKey: ['agency', agency.agencyId, 'clients', client.id, 'members', { page: removedPage, status: 'removed' }],
    queryFn: ({ signal }) => httpClient.request({
      path: membersPath(agency.agencyId, client.id, { page: removedPage, status: 'removed' }),
      response: ClientMemberListResponseSchema,
      signal
    })
  });

  const invitations = useQuery({
    queryKey: ['agency', agency.agencyId, 'clients', client.id, 'invitations', { page: invitationsPage }],
    queryFn: ({ signal }) => httpClient.request({
      path: invitationsPath(agency.agencyId, client.id, invitationsPage),
      response: ClientInvitationListResponseSchema,
      signal
    })
  });

  const invalidateAccess = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'clients'] });

  // A write can shrink a list while the URL points past its last page; the server's totalPages is
  // authoritative, so the address moves back instead of showing "none" (the #229 lesson).
  useEffect(() => {
    const target = clampedPage(membersPage, members.data);
    if (target !== null) replacePage(setSearchParams, location.state, 'membros', target);
  }, [members.data, membersPage, setSearchParams, location.state]);

  useEffect(() => {
    const target = clampedPage(invitationsPage, invitations.data);
    if (target !== null) replacePage(setSearchParams, location.state, 'convites', target);
  }, [invitations.data, invitationsPage, setSearchParams, location.state]);

  useEffect(() => {
    const target = clampedPage(removedPage, removed.data);
    if (target !== null) replacePage(setSearchParams, location.state, 'removidas', target);
  }, [removed.data, removedPage, setSearchParams, location.state]);

  const changeMemberStatus = useMutation({
    mutationFn: (action: PendingAction) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/members/:membershipId/:action', {
        agencyId: agency.agencyId,
        clientId: client.id,
        membershipId: action.id,
        action: action.kind
      }),
      method: 'POST',
      response: ClientMemberSchema
    }),
    onSuccess: () => {
      setPending(null);
      setActionError(undefined);
      void invalidateAccess();
    },
    onError: (error: unknown, action: PendingAction) => {
      setPending(null);
      setActionError(error instanceof HttpClientError && (error.code === 'FORBIDDEN' || error.status === 403)
        ? NO_PERMISSION
        : action.kind === 'remove' ? REMOVE_FAILED : REACTIVATE_FAILED);
      void invalidateAccess();
    }
  });

  const resend = useMutation({
    mutationFn: (invitation: ClientPendingInvitation) => httpClient.request({
      path: apiPath('/agencies/:agencyId/invitations/:invitationId/resend', { agencyId: agency.agencyId, invitationId: invitation.invitationId }),
      method: 'POST',
      response: InvitationCreatedResponseSchema
    }),
    onSuccess: (_result, invitation) => setResentEmail(invitation.email),
    onSettled: () => { void invalidateAccess(); }
  });

  const cancel = useMutation({
    mutationFn: (invitationId: string) => httpClient.request({
      path: apiPath('/agencies/:agencyId/invitations/:invitationId', { agencyId: agency.agencyId, invitationId }),
      method: 'DELETE',
      response: AuthNoContentResponseSchema
    }),
    onSuccess: () => { setPending(null); setActionError(undefined); },
    onError: () => { setPending(null); setActionError(CANCEL_FAILED); },
    onSettled: () => { void invalidateAccess(); }
  });

  // A hidden resource is not a screen: a 403 or 404 from the guard is the ordinary not-found,
  // never a blank panel (SPEC §7, review of #388).
  if (members.isError && members.error instanceof HttpClientError && [403, 404].includes(members.error.status ?? 0)) {
    return <NotFoundPage as="section" />;
  }

  const memberRows = members.data?.data ?? [];
  const invitationRows = invitations.data?.data ?? [];
  const removedRows = removed.data?.data ?? [];
  const removedTotal = removed.data?.meta.totalItems ?? 0;
  const hasRemoved = removed.data !== undefined && removedTotal > 0;

  return <section className="portal-access" aria-labelledby="portal-access-title">
    <header className="portal-access__header">
      <h2 id="portal-access-title">Pessoas com acesso ao portal</h2>
      {activeClient && <Button onClick={() => setInviteOpen(true)}><span aria-hidden="true">+</span> Convidar</Button>}
    </header>

    {actionError !== undefined && <FieldMessage role="alert">{actionError}</FieldMessage>}
    {resentEmail !== null && <LiveStatus>Convite reenviado para {resentEmail}. O link anterior deixou de valer.</LiveStatus>}
    {resend.isError && <p className="portal-access__error-line" role="alert">{RESEND_FAILED}</p>}

    {members.isPending ? (
      <ul className="portal-access__list" aria-hidden="true">
        {Array.from({ length: 3 }, (_value, index) => <li key={index}><Skeleton /></li>)}
      </ul>
    ) : members.isError ? (
      <div className="portal-access__error" role="alert">
        <p>{MEMBERS_FAILED}</p>
        <Button onClick={() => { void members.refetch(); }}>Tentar de novo</Button>
      </div>
    ) : memberRows.length === 0 ? (
      <div className="portal-access__empty">
        <p>Ninguém deste cliente acessa o portal ainda</p>
        {activeClient && <Button onClick={() => setInviteOpen(true)}>Convidar</Button>}
      </div>
    ) : <>
      <ul className="portal-access__list">
        {memberRows.map((member: ClientMember) => <li key={member.membershipId} className="portal-access__row">
          <span className="portal-access__name">{member.name}</span>
          <span className="portal-access__email">{member.email}</span>
          <span className="portal-access__since">desde {formatAgencyDayMonth(member.since)}</span>
          {activeClient && canRemove && <Button
            size="sm"
            variant="secondary"
            aria-label={`Remover o acesso de ${member.name}`}
            onClick={() => { setActionError(undefined); setPending({ kind: 'remove', id: member.membershipId, name: member.name }); }}
          >Remover</Button>}
        </li>)}
      </ul>
      <Pagination page={members.data?.meta.page ?? 1} totalPages={members.data?.meta.totalPages ?? 1} onPageChange={(page) => { replacePage(setSearchParams, location.state, 'membros', page); }} />
    </>}

    {hasRemoved && (removedOpen
      ? <section className="portal-access__removed" aria-label="Pessoas removidas">
        <header className="portal-access__removed-header">
          <h3>{`Removidas (${removedTotal})`}</h3>
          <Button size="sm" variant="ghost" aria-expanded={removedOpen} onClick={() => setRemovedOpen(false)}>Ocultar</Button>
        </header>
        {removed.isPending ? (
          <ul className="portal-access__list" aria-hidden="true">
            {Array.from({ length: 2 }, (_value, index) => <li key={index}><Skeleton /></li>)}
          </ul>
        ) : removed.isError ? (
          <div className="portal-access__error" role="alert">
            <p>{MEMBERS_FAILED}</p>
            <Button onClick={() => { void removed.refetch(); }}>Tentar de novo</Button>
          </div>
        ) : <>
          <ul className="portal-access__list">
            {removedRows.map((member: ClientMember) => <li key={member.membershipId} className="portal-access__row">
              <span className="portal-access__name">{member.name}</span>
              <span className="portal-access__email">{member.email}</span>
              <span className="portal-access__since">removido</span>
              {activeClient && canRemove && <Button
                size="sm"
                variant="secondary"
                aria-label={`Reativar o acesso de ${member.name}`}
                loading={changeMemberStatus.isPending && changeMemberStatus.variables?.id === member.membershipId}
                onClick={() => { setActionError(undefined); changeMemberStatus.mutate({ kind: 'reactivate', id: member.membershipId, name: member.name }); }}
              >Reativar</Button>}
            </li>)}
          </ul>
          <Pagination page={removed.data?.meta.page ?? 1} totalPages={removed.data?.meta.totalPages ?? 1} onPageChange={(page) => { replacePage(setSearchParams, location.state, 'removidas', page); }} />
        </>}
      </section>
      : <Button variant="ghost" aria-expanded={removedOpen} onClick={() => setRemovedOpen(true)}>{`Removidas (${removedTotal})`} <span aria-hidden="true">▾</span></Button>)}

    {invitations.isPending ? (
      <section className="portal-access__invites" aria-labelledby="portal-invites-title">
        <h3 id="portal-invites-title">Convites aguardando aceite</h3>
        <ul className="portal-access__list" aria-hidden="true"><li><Skeleton /></li></ul>
      </section>
    ) : invitations.isError && invitations.error instanceof HttpClientError && [403, 404].includes(invitations.error.status ?? 0) ? null : invitations.isError ? (
      <section className="portal-access__invites" aria-labelledby="portal-invites-title">
        <h3 id="portal-invites-title">Convites aguardando aceite</h3>
        <div className="portal-access__error" role="alert">
          <p>{INVITATIONS_FAILED}</p>
          <Button onClick={() => { void invitations.refetch(); }}>Tentar de novo</Button>
        </div>
      </section>
    ) : invitationRows.length > 0 ? (
      <section className="portal-access__invites" aria-labelledby="portal-invites-title">
        <h3 id="portal-invites-title">Convites aguardando aceite</h3>
        <ul className="portal-access__list">
          {invitationRows.map((invitation: ClientPendingInvitation) => <li key={invitation.invitationId} className="portal-access__row">
            <span className="portal-access__email">{invitation.email}</span>
            <span className="portal-access__since">{pendingInviteExpiryLabel(invitation.expiresAt)}</span>
            <span className="portal-access__actions">
              {activeClient && canResend && <Button
                size="sm"
                variant="secondary"
                aria-label={`Reenviar convite de ${invitation.email}`}
                loading={resend.isPending && resend.variables?.invitationId === invitation.invitationId}
                onClick={() => { setResentEmail(null); resend.mutate(invitation); }}
              >Reenviar</Button>}
              {activeClient && canCancel && <Button
                size="sm"
                variant="ghost"
                aria-label={`Cancelar convite de ${invitation.email}`}
                onClick={() => { setActionError(undefined); setPending({ kind: 'cancel', id: invitation.invitationId, name: invitation.email, email: invitation.email }); }}
              >Cancelar</Button>}
            </span>
          </li>)}
        </ul>
        <Pagination page={invitations.data?.meta.page ?? 1} totalPages={invitations.data?.meta.totalPages ?? 1} onPageChange={(page) => { replacePage(setSearchParams, location.state, 'convites', page); }} />
      </section>
    ) : null}

    <ConfirmDialog
      open={pending?.kind === 'remove'}
      title={pending?.kind === 'remove' ? `Remover o acesso de ${pending.name}?` : ''}
      description={REMOVE_DESCRIPTION}
      confirmLabel="Remover acesso"
      cancelLabel="Cancelar"
      busy={changeMemberStatus.isPending}
      onConfirm={() => { if (pending !== null) changeMemberStatus.mutate(pending); }}
      onCancel={() => { if (!changeMemberStatus.isPending) setPending(null); }}
    />
    <ConfirmDialog
      open={pending?.kind === 'cancel'}
      title="Cancelar este convite?"
      description={pending?.email === undefined ? '' : `O link enviado para ${pending.email} deixa de valer imediatamente. Para dar acesso de novo, será preciso convidar a pessoa outra vez.`}
      confirmLabel="Cancelar convite"
      cancelLabel="Voltar"
      busy={cancel.isPending}
      onConfirm={() => { if (pending !== null) cancel.mutate(pending.id); }}
      onCancel={() => { if (!cancel.isPending) setPending(null); }}
    />
    {inviteOpen && <InviteClientDialog client={client} onClose={() => setInviteOpen(false)} />}
  </section>;
}
