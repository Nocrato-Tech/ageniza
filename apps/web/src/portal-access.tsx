import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Clock, Plus } from 'lucide-react';
import { useLocation, useSearchParams, type SetURLSearchParams } from 'react-router-dom';
import { z } from 'zod';

import {
  AuthEmailSchema,
  AuthNoContentResponseSchema,
  ClientInvitationListResponseSchema,
  ClientMemberListResponseSchema,
  ClientMemberSchema,
  type ClientMember,
  type ClientPendingInvitation,
  type ClientDetailResponse
} from '@ageniza/contracts';
import { Avatar, Button, ConfirmDialog, EmptyState, Field, FieldMessage, LiveStatus, Modal, Pagination, Pill, Skeleton, TextInput, useFormErrors } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { formatAgencyDayMonth, useClientDetail } from './client-detail.js';
import { HttpClientError, useApiClient } from './http.js';
import { pendingInviteExpiryLabel } from './pending-invitations.js';
import { NotFoundPage } from './status-pages.js';

/** `specs/clientes.md` §6: 20 per page for the portal people and the pending invitations. */
const PAGE_SIZE = 20;

const MEMBERS_FAILED = 'Não foi possível carregar as pessoas com acesso. Tente de novo.';
const INVITATIONS_FAILED = 'Não foi possível carregar os convites. Tente de novo.';
const REMOVE_FAILED = 'Não foi possível remover o acesso. Tente de novo.';
const REACTIVATE_FAILED = 'Não foi possível reativar o acesso. Tente de novo.';
const CANCEL_FAILED = 'Não foi possível cancelar o convite. Tente de novo.';
const NO_PERMISSION = 'Você não tem permissão para alterar o acesso deste cliente.';
const REMOVE_DESCRIPTION = 'A pessoa perde o acesso ao portal deste cliente. As outras pessoas não são afetadas.';
const ADD_HINT = 'A pessoa passa a ter acesso ao portal deste cliente na hora e recebe um e-mail de boas-vindas.';
const NOT_ENTERED = 'ainda não entrou';
const ADD_FAILED = 'Não foi possível adicionar a pessoa. Tente de novo.';

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

/** The name of the account once the person has entered, or "ainda não entrou"; it never says whether the address has an account. */
function MemberName({ member }: { member: ClientMember }) {
  return member.name === null
    ? <span className="portal-access__name portal-access__name--pending">{NOT_ENTERED}</span>
    : <span className="portal-access__name">{member.name}</span>;
}

/** The "Adicionar pessoa" modal (`specs/clientes.md` §7): the e-mail, and nothing else. The access is valid on the spot. */
function AddPersonDialog({ client, onClose, onAdded }: { client: ClientDetailResponse; onClose: () => void; onAdded: (email: string) => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const { formRef, summary } = useFormErrors();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => { emailRef.current?.focus(); }, []);

  const add = useMutation({
    mutationFn: (target: string) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/members', { agencyId: agency.agencyId, clientId: client.id }),
      method: 'POST',
      body: { email: target },
      response: ClientMemberSchema
    }),
    onSuccess: (_member, target) => {
      onAdded(target);
      onClose();
    },
    onError: (error: unknown) => {
      if (!(error instanceof HttpClientError)) { setFormError(ADD_FAILED); return; }
      if (error.code === 'ACCESS_EXISTS') { setEmailError('Esta pessoa já tem acesso ao portal deste cliente.'); return; }
      if (error.code === 'CLIENT_ARCHIVED') { setFormError('Cliente arquivado: não é possível adicionar pessoas ao portal.'); return; }
      if (error.code === 'FORBIDDEN' || error.status === 403) { setFormError('Você não tem permissão para adicionar pessoas a este cliente.'); return; }
      if (error.status === 429 && error.code === 'DAILY_EMAIL_LIMIT') { setFormError('Limite diário de e-mails da agência atingido. Tente amanhã.'); return; }
      if (error.status === 502 && error.code === 'EMAIL_DELIVERY_FAILED') {
        setFormError('O acesso foi dado, mas o e-mail de boas-vindas não foi entregue. Para mandar de novo, remova o acesso e adicione o e-mail outra vez.');
        return;
      }
      if (error.status === 400) {
        const parsed = z.object({ issues: z.array(z.object({ path: z.string() })) }).safeParse(error.details);
        const refusedEmail = parsed.success && parsed.data.issues.some((issue) => issue.path === 'email' || issue.path.startsWith('email.'));
        if (refusedEmail) setEmailError('Informe um e-mail válido.');
        else setFormError('Revise os dados.');
        return;
      }
      setFormError(ADD_FAILED);
    },
    // A 502 leaves the access created, so the list refetches on settle to show what the server holds.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'clients'] });
    }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const target = email.trim().toLowerCase();
    if (target === '') { setEmailError('Informe o e-mail.'); return; }
    if (!AuthEmailSchema.safeParse(target).success) { setEmailError('Informe um e-mail válido.'); return; }
    add.mutate(target);
  };

  return <Modal title="Adicionar pessoa" closeLabel="Fechar adicionar pessoa" onClose={onClose}>
    <form ref={formRef} className="form-stack" onSubmit={onSubmit} noValidate>
      {summary}
      <Field label="E-mail" hint={ADD_HINT} error={emailError}>
        {(control) => <TextInput
          ref={emailRef}
          {...control}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => { setEmail(event.target.value); setEmailError(undefined); setFormError(undefined); }}
        />}
      </Field>
      {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
      <div className="form-actions">
        <Button type="submit" disabled={email.trim() === ''} loading={add.isPending}>Adicionar</Button>
      </div>
    </form>
  </Modal>;
}

/**
 * The portal-access tab (`specs/clientes.md` §7, issues #140 and #716): the people who have access to
 * the client's portal, the removed ones and the old invitations still pending. Reading and adding
 * need `cliente.convidar_usuario` (the tab gate); removing and reactivating need
 * `cliente.remover_usuario`, cancelling an old invitation needs `convite.cancelar`; without them the
 * action is simply absent. A pending portal invitation is never resent (decision 2026-10-27). Every write invalidates the clients prefix, which
 * carries the roster badge, the detail summary and this tab's lists (SPEC §6 invalidation table).
 */
export function ClientAccessTab() {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const client = useClientDetail();
  const canRemove = useCan('cliente.remover_usuario');
  const canCancel = useCan('convite.cancelar');
  const activeClient = client.status === 'active';
  // Removing and cancelling reduce access and stay enabled in a read-only agency; adding and reactivating
  // stay on screen, disabled, with the reason.
  const blocked = useWriteBlocked();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [removedOpen, setRemovedOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | undefined>();
  const [addedEmail, setAddedEmail] = useState<string | null>(null);

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
      path: apiPath('/agencies/:agencyId/clients/:clientId/members/:accessId/:action', {
        agencyId: agency.agencyId,
        clientId: client.id,
        accessId: action.id,
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
  // With nobody listed the empty state carries the one primary action, so the header's drops to secondary.
  const emptyList = members.data !== undefined && memberRows.length === 0;

  return <section className="portal-access" aria-labelledby="portal-access-title">
    <header className="portal-access__header">
      <h2 id="portal-access-title">Pessoas com acesso ao portal</h2>
      {activeClient && <Button variant={emptyList ? 'secondary' : 'primary'} leadingIcon={<Plus />} blockedReason={blocked} onClick={() => { setAddedEmail(null); setAddOpen(true); }}>Adicionar pessoa</Button>}
    </header>

    {actionError !== undefined && <FieldMessage role="alert">{actionError}</FieldMessage>}
    {addedEmail !== null && <LiveStatus>{addedEmail} agora tem acesso ao portal deste cliente.</LiveStatus>}

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
      <EmptyState
        className="portal-access__empty"
        mascot={activeClient}
        headingLevel={3}
        title="Ninguém deste cliente acessa o portal ainda"
        description={activeClient ? ADD_HINT : undefined}
        action={activeClient ? <Button leadingIcon={<Plus />} blockedReason={blocked} onClick={() => { setAddedEmail(null); setAddOpen(true); }}>Adicionar pessoa</Button> : undefined}
      />
    ) : <>
      <ul className="portal-access__list">
        {memberRows.map((member: ClientMember) => <li key={member.accessId} className="portal-access__row">
          <Avatar name={member.name ?? member.email} size="md" />
          <span className="portal-access__who">
            <MemberName member={member} />
            <span className="portal-access__email">{member.email}</span>
          </span>
          <span className="portal-access__since">desde {formatAgencyDayMonth(member.since)}</span>
          {activeClient && canRemove && <Button
            size="sm"
            variant="secondary"
            aria-label={`Remover o acesso de ${member.name ?? member.email}`}
            onClick={() => { setActionError(undefined); setPending({ kind: 'remove', id: member.accessId, name: member.name ?? member.email }); }}
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
            {removedRows.map((member: ClientMember) => <li key={member.accessId} className="portal-access__row">
              <Avatar name={member.name ?? member.email} size="md" />
              <span className="portal-access__who">
                <MemberName member={member} />
                <span className="portal-access__email">{member.email}</span>
              </span>
              <span className="portal-access__since">removido</span>
              {activeClient && canRemove && <Button
                size="sm"
                variant="secondary"
                aria-label={`Reativar o acesso de ${member.name ?? member.email}`}
                blockedReason={blocked}
                loading={changeMemberStatus.isPending && changeMemberStatus.variables?.id === member.accessId}
                onClick={() => { setActionError(undefined); changeMemberStatus.mutate({ kind: 'reactivate', id: member.accessId, name: member.name ?? member.email }); }}
              >Reativar</Button>}
            </li>)}
          </ul>
          <Pagination page={removed.data?.meta.page ?? 1} totalPages={removed.data?.meta.totalPages ?? 1} onPageChange={(page) => { replacePage(setSearchParams, location.state, 'removidas', page); }} />
        </>}
      </section>
      : <Button variant="ghost" aria-expanded={removedOpen} trailingIcon={<ChevronDown />} onClick={() => setRemovedOpen(true)}>{`Removidas (${removedTotal})`}</Button>)}

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
            <span className="portal-access__who"><span className="portal-access__email">{invitation.email}</span></span>
            <Pill icon={<Clock />}>{pendingInviteExpiryLabel(invitation.expiresAt)}</Pill>
            <span className="portal-access__actions">
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
      description={pending?.email === undefined ? '' : `O link enviado para ${pending.email} deixa de valer imediatamente. Para dar acesso de novo, use Adicionar pessoa.`}
      confirmLabel="Cancelar convite"
      cancelLabel="Voltar"
      busy={cancel.isPending}
      onConfirm={() => { if (pending !== null) cancel.mutate(pending.id); }}
      onCancel={() => { if (!cancel.isPending) setPending(null); }}
    />
    {addOpen && <AddPersonDialog client={client} onClose={() => setAddOpen(false)} onAdded={setAddedEmail} />}
  </section>;
}
