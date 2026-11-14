import { SearchField } from '@ageniza/ui';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/** The title of a post, accents and case ignored, the way the board's search compares. */
export const foldTitle = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const PORTAL_SEARCH_PARAM = 'busca';

/**
 * "Buscar um post" in the portal's top bar. It asks the API nothing: the term lives in the address of Conteúdos (`?busca=`), where the
 * list the screen already loaded is filtered by title. Typing on another screen takes the person there.
 */
export function PortalSearch({ clientId }: { clientId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const contentsPath = `/portal/${clientId}/conteudos`;
  const onContents = location.pathname === contentsPath;
  const value = onContents ? searchParams.get(PORTAL_SEARCH_PARAM) ?? '' : '';

  const change = (next: string): void => {
    if (!onContents) {
      if (next !== '') void navigate(`${contentsPath}?${PORTAL_SEARCH_PARAM}=${encodeURIComponent(next)}`);
      return;
    }
    const params = new URLSearchParams(searchParams);
    if (next === '') params.delete(PORTAL_SEARCH_PARAM); else params.set(PORTAL_SEARCH_PARAM, next);
    setSearchParams(params, { replace: true });
  };

  return <SearchField className="portal-search" label="Buscar um post" placeholder="Buscar um post" value={value} maxLength={80} autoComplete="off" onChange={change} />;
}
