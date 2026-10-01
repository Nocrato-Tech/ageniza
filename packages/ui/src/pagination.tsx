export interface PaginationProps {
  /** 1-based current page. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Optional count line, e.g. "24 de 61 pessoas". */
  summary?: string;
}

/**
 * The page numbers to render, in order. Up to seven pages are all shown; beyond that, the first and
 * last stay pinned and a window follows the current page, with `'gap'` marking the omitted range.
 */
export const paginationItems = (page: number, totalPages: number): Array<number | 'gap'> => {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_value, index) => index + 1);
  const items: Array<number | 'gap'> = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) items.push('gap');
  for (let current = start; current <= end; current += 1) items.push(current);
  if (end < totalPages - 1) items.push('gap');
  items.push(totalPages);
  return items;
};

/** Page-based navigation: previous, the numbered pages, next, and an optional count. */
export function Pagination({ page, totalPages, onPageChange, summary }: PaginationProps) {
  if (totalPages <= 1) {
    return summary === undefined ? null : <div className="ui-pagination"><p className="ui-pagination__summary">{summary}</p></div>;
  }
  return (
    <div className="ui-pagination">
      <nav className="ui-pagination__nav" aria-label="Paginação">
        <button type="button" className="ui-pagination__step" aria-label="Página anterior" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>‹</button>
        {paginationItems(page, totalPages).map((item, index) => item === 'gap'
          ? <span key={`gap-${index}`} className="ui-pagination__gap" aria-hidden="true">…</span>
          : <button
              key={item}
              type="button"
              className="ui-pagination__page"
              aria-label={`Página ${item}`}
              aria-current={item === page ? 'page' : undefined}
              onClick={() => onPageChange(item)}
            >{item}</button>)}
        <button type="button" className="ui-pagination__step" aria-label="Próxima página" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>›</button>
      </nav>
      {summary !== undefined && <p className="ui-pagination__summary">{summary}</p>}
    </div>
  );
}
