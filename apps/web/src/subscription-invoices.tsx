import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

import type { SubscriptionInvoice, SubscriptionInvoiceStatus } from '@ageniza/contracts';
import { EmptyState, LateBadge, LiveStatus, Pagination, Skeleton, StatusTag } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { useDocumentTitle } from './document-title.js';
import { useApiClient } from './http.js';
import { formatMoney, formatShortDay } from './subscription-format.js';
import { invoicesQuery } from './subscription-queries.js';
import { TestCardRow } from './subscription-test-card.js';

const LOAD_FAILED = 'Não foi possível abrir as faturas. Tente de novo.';

/** The four ways a charge shows, each by its own label and shape: "Vencida" is the one solid block, because it asks for action. */
function InvoiceStatus({ status }: { status: SubscriptionInvoiceStatus }) {
  switch (status) {
    case 'paid': return <StatusTag status="ready">Paga</StatusTag>;
    case 'open': return <StatusTag status="waiting">Aberta</StatusTag>;
    case 'declined': return <StatusTag status="adjust">Recusada</StatusTag>;
    case 'expired': return <LateBadge>Vencida</LateBadge>;
  }
}

function InvoiceRow({ invoice }: { invoice: SubscriptionInvoice }) {
  return <li className="subscription-invoices__row">
    <span className="subscription-invoices__date">{formatShortDay(invoice.date)}</span>
    <span className="subscription-invoices__what">{invoice.description}</span>
    <span className="subscription-invoices__amount">{formatMoney(invoice.amountCents)}</span>
    <span className="subscription-invoices__status"><InvoiceStatus status={invoice.status} /></span>
  </li>;
}

/**
 * `/agencia/:agenciaId/assinatura/faturas`, for the Owner: every charge of the subscription, newest first, 20 to a page. The list is only
 * read; a declined charge stays here as "Recusada" and a retry is a new charge, which shows as its own row.
 */
export function SubscriptionInvoicesPage() {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [notice, setNotice] = useState<string | undefined>();
  useDocumentTitle('Faturas — Ageniza');

  const requested = Number(searchParams.get('page'));
  const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
  const query = useQuery({ ...invoicesQuery(httpClient, agency.agencyId, page), placeholderData: keepPreviousData });
  const list = query.data;

  const body = query.isError && list === undefined
    ? <EmptyState kind="failure" title={LOAD_FAILED} description="Nada foi alterado." retrying={query.isFetching} onRetry={() => { void query.refetch(); }} />
    : list === undefined
      ? <Skeleton />
      : list.data.length === 0
        ? <EmptyState title="Nenhuma fatura ainda" description="As cobranças da assinatura aparecem aqui, uma por linha, assim que a primeira for pedida." />
        : <>
          <ul className="subscription-invoices__list" aria-label="Faturas" aria-busy={query.isPlaceholderData || undefined}>
            {list.data.map((invoice) => <InvoiceRow key={invoice.id} invoice={invoice} />)}
          </ul>
          <Pagination
            page={list.meta.page}
            totalPages={list.meta.totalPages}
            summary={`${list.data.length} de ${list.meta.totalItems} faturas`}
            onPageChange={(next) => { setSearchParams(next === 1 ? {} : { page: String(next) }, { state: location.state }); }}
          />
        </>;

  return <section aria-labelledby="subscription-invoices-title" className="subscription subscription-invoices">
    <nav className="subscription__crumbs" aria-label="Você está em">
      <Link to={`/agencia/${agency.agencyId}/assinatura`} state={location.state}>Assinatura</Link>
      <span aria-hidden="true">›</span>
      <span aria-current="page">Faturas</span>
    </nav>
    <header className="subscription__head">
      <p className="subscription__eyebrow">Assinatura</p>
      <h1 id="subscription-invoices-title">Faturas</h1>
      <p className="subscription__lead">Cada cobrança da assinatura, com o valor e a situação. Uma tentativa recusada fica registrada, e tentar de novo abre outra cobrança.</p>
    </header>
    {notice !== undefined && <LiveStatus className="subscription__notice">{notice}</LiveStatus>}
    <TestCardRow agencyId={agency.agencyId} onSaved={setNotice} />
    <section className="subscription__block" aria-labelledby="subscription-invoices-list">
      <h2 id="subscription-invoices-list">Todas as faturas</h2>
      {body}
    </section>
  </section>;
}
