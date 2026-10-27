import { useClientDetail } from './client-detail.js';
import { ContentFolders } from './content-folders.js';

/**
 * The Mídias tab of the client's detail (`specs/clientes.md` §7, `specs/conteudo.md` §7): the media library of the
 * client, in its folders, with the upload. The permission gate is in `ClientDetailPage`, like the Conteúdos tab's.
 * An archived client is read-only.
 */
export function ClientMediaTab() {
  const client = useClientDetail();
  return <ContentFolders clientId={client.id} canWrite={client.status === 'active'} />;
}
