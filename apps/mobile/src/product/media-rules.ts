import type { ContentFormat } from '@ageniza/contracts';
import type { Asset, PostInput } from './types';

export const coverFileTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const publicationFileTypes = [...coverFileTypes, 'video/mp4', 'video/quicktime', 'video/webm'];
export const coverFileHint = 'JPEG, PNG, WebP ou GIF. A imagem deve estar na mesma pasta da publicação.';

export function coverIssue(asset: Asset | undefined, input: Pick<PostInput, 'clientId' | 'folderId'>): string | undefined {
  if (!asset) return 'A capa não está mais disponível. Escolha uma imagem da pasta atual ou use a capa automática.';
  if (asset.clientId !== input.clientId || asset.folderId !== input.folderId) return 'Esta capa pertence a outra pasta ou cliente. Escolha uma imagem da pasta atual.';
  if (asset.kind !== 'image') return 'Um vídeo não pode ser a capa personalizada. Escolha uma imagem ou use o quadro automático do vídeo.';
  return undefined;
}

export function formatMediaHint(format: ContentFormat): string {
  if (format === 'carousel') return 'Carrossel: de 2 a 20 imagens ou vídeos, na ordem abaixo, para enviar à aprovação.';
  if (format === 'image') return 'Post com imagem: 1 imagem para enviar à aprovação.';
  return 'Vídeo: 1 arquivo de vídeo para enviar à aprovação. Escolha a imagem de capa na seção Capa.';
}

export function mediaFitsFormat(asset: Asset, format: ContentFormat): boolean {
  return format === 'carousel' || asset.kind === (format === 'image' ? 'image' : 'video');
}
