import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  AuthNoContentResponseSchema,
  InvitationCreatedResponseSchema,
  PendingInvitationListResponseSchema,
  type PendingInvitation
} from '@ageniza/contracts';
import { Button, ConfirmDialog, LiveStatus, Pagination, Skeleton } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';

/** `specs/colaboradores.md` §6: 24 per page, creation date ascending (the route owns the order). */
const PAGE_SIZE = 24;
const DAY_MS = 24 * 60 * 60 * 1000;

const LIST_ERROR = 'Não foi possível carregar os convites. Tente de novo.';
const RESEND_ERROR = 'Não foi possível reenviar o convite. Tente de novo.';
const CANCEL_ERROR = 'Não foi possível cancelar o convite. Tente de novo.';
const INVITE_UNAVAILABLE = 'O convite chega na próxima entrega.';

/**
 * The relative deadline (`specs/colaboradores.md` §7): "expira em 5 dias", "expira amanhã". An
 * absolute date would force the reader to do the arithmetic. The list only returns pending
 * invitations, but a stale cache could otherwise claim an already-passed deadline expires today.
 */
export const pendingInviteExpiryLabel = (expiresAt: string, now: Date = new Date()): string => {
  const remainingMs = new Date(expiresAt).getTime() - now.getTime();
  if (remainingMs <= 0) return 'expirado';
  if (remainingMs < DAY_MS) return 'expira hoje';
  if (remainingMs < 2 * DAY_MS) return 'expira amanhã';
  return `expira em ${Math.floor(remainingMs / DAY_MS)} dias`;
};

/** A hidden resource: a 403 or 404 from the guard keeps the section out of the screen entirely. */
const isNotVisible = (error: unknown): boolean =>
  error instanceof HttpClientError && (error.status === 403 || error.status === 404);

const listPath = (agencyId: string, page: number): string =>
  `${apiPath('/agencies/:agencyId/invitations', { agencyId })}?page=${page}&pageSize=${PAGE_SIZE}`;

export interface PendingInvitationsSectionProps {
  /** 1-based page of the invitations list, owned by the URL like the team list's. */
  page: number;
  onPageChange: (page: number) => void;
}

/**
 * Pending invitations (specs/colaboradores.md §7): a separate list from the team, because its count
 * and its pages depend on `colaborador.convidar`. Without the permission the section does not exist
 * -- not empty, not disabled. Resending revokes the previous link and creates a new invitation, so
 * the list is invalidated and the deadline is renewed in place; cancelling asks for confirmation
 * first. No response field carries the invitation token, and none is rendered.
 */
export function PendingInvitationsSection({ page, onPageChange }: PendingInvitationsSectionProps) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const canInvite = useCan('colaborador.convidar');
  const canResend = useCan('convite.reenviar');
  const canCancel = useCan('convite.cancelar');
  const [confirming, setConfirming] = useState<PendingInvitation | null>(null);
  const [resentEmail, setResentEmail] = useState<string | null>(null);

  const invitations = useQuery({
    queryKey: ['agency', agency.agencyId, 'invitations', { page }],
    queryFn: ({ signal }) => httpClient.request({
      path: listPath(agency.agencyId, page),
      response: PendingInvitationListResponseSchema,
      signal
    }),
    enabled: canInvite
  });

  const invalidateList = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'invitations'] });

  const resend = useMutation({
    mutationFn: (invitation: PendingInvitation) => httpClient.request({
      path: apiPath('/agencies/:agencyId/invitations/:invitationId/resend', { agencyId: agency.agencyId, invitationId: invitation.id }),
      method: 'POST',
      response: InvitationCreatedResponseSchema
    }),
    onSuccess: (_result, invitation) => {
      setResentEmail(invitation.email);
      void invalidateList();
    }
  });

  const cancel = useMutation({
    mutationFn: (invitationId: string) => httpClient.request({
      path: apiPath('/agencies/:agencyId/invitations/:invitationId', { agencyId: agency.agencyId, invitationId }),
      method: 'DELETE',
      response: AuthNoContentResponseSchema
    }),
    onSuccess: () => {
      setConfirming(null);
      void invalidateList();
    },
    onError: () => setConfirming(null)
  });

  // A page can stop existing after a cancellation, the same way #229 handled the team list: the
  // server's totalPages is authoritative, so the URL moves back instead of showing "no invites".
  useEffect(() => {
    if (invitations.data === undefined) return;
    const lastPage = Math.max(1, invitations.data.meta.totalPages);
    if (page <= lastPage) return;
    onPageChange(lastPage);
  }, [invitations.data, page, onPageChange]);

  if (!canInvite) return null;
  if (invitations.isError && isNotVisible(invitations.error)) return null;

  const data = invitations.data;
  const outOfRange = data !== undefined && page > Math.max(1, data.meta.totalPages);

  let body: ReactNode;
  if (invitations.isPending) {
    body = <ul className="invites__list" aria-hidden="true">
      {Array.from({ length: 3 }, (_value, index) => <li key={index}><Skeleton /></li>)}
    </ul>;
  } else if (invitations.isError) {
    body = <div className="invites__error" role="alert">
      <p>{LIST_ERROR}</p>
      <Button onClick={() => { void invitations.refetch(); }}>Tentar de novo</Button>
    </div>;
  } else if (data === undefined || outOfRange) {
    body = null;
  } else if (data.data.length === 0) {
    body = <div className="invites__empty">
      <p>Nenhum convite aguardando aceite</p>
      <Button disabled title={INVITE_UNAVAILABLE}><span aria-hidden="true">+</span> Convidar</Button>
    </div>;
  } else {
    body = <>
      <ul className="invites__list">
        {data.data.map((invitation) => <li key={invitation.id} className="invites__item">
          <p className="invites__email">{invitation.email}</p>
          <p className="invites__role">{invitation.role.name}</p>
          <p className="invites__expiry">{pendingInviteExpiryLabel(invitation.expiresAt)}</p>
          <div className="invites__actions">
            {canResend && <Button
              size="sm"
              variant="secondary"
              aria-label={`Reenviar convite de ${invitation.email}`}
              loading={resend.isPending && resend.variables?.id === invitation.id}
              onClick={() => { setResentEmail(null); resend.mutate(invitation); }}
            >
              Reenviar
            </Button>}
            {canCancel && <Button
              size="sm"
              variant="ghost"
              aria-label={`Cancelar convite de ${invitation.email}`}
              onClick={() => { cancel.reset(); setConfirming(invitation); }}
            >
              Cancelar
            </Button>}
          </div>
          {resend.isError && resend.variables?.id === invitation.id && <p className="invites__row-error" role="alert">{RESEND_ERROR}</p>}
          {cancel.isError && cancel.variables === invitation.id && <p className="invites__row-error" role="alert">{CANCEL_ERROR}</p>}
        </li>)}
      </ul>
      <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={onPageChange} />
    </>;
  }

  return <section className="invites" aria-labelledby="pending-invites-title">
    <header className="invites__header">
      <h2 id="pending-invites-title">Convites aguardando aceite</h2>
      {data !== undefined && <span className="invites__count">{data.meta.totalItems}</span>}
    </header>
    {resentEmail !== null && <LiveStatus>Convite reenviado para {resentEmail}. O link anterior deixou de valer.</LiveStatus>}
    {body}
    <ConfirmDialog
      open={confirming !== null}
      title="Cancelar este convite?"
      description={confirming === null ? '' : `O link enviado para ${confirming.email} deixa de valer imediatamente. Para dar acesso de novo, será preciso convidar a pessoa outra vez.`}
      confirmLabel="Cancelar convite"
      cancelLabel="Voltar"
      busy={cancel.isPending}
      onConfirm={() => { if (confirming !== null) cancel.mutate(confirming.id); }}
      onCancel={() => { if (!cancel.isPending) setConfirming(null); }}
    />
  </section>;
}
