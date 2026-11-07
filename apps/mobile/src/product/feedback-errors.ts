import { ApiError } from '../api/client';
const messages: Record<string, string> = {
  CONTENT_MEDIA_INVALID: 'Confira as mídias e a capa: use arquivos da mesma pasta do cliente, uma imagem como capa e respeite o limite do formato. Volte à etapa Conteúdo para ajustar a seleção.',
  CONTENT_MEDIA_INCOMPLETE: 'Ainda falta preparar a publicação. Confira a quantidade e o tipo das mídias exigidas pelo formato antes de enviar para aprovação.',
  CONTENT_FOLDER_INVALID: 'A pasta escolhida não está disponível para este cliente. Volte à etapa Formato e selecione uma pasta da marca.',
  CONTENT_OWNER_INVALID: 'O responsável não está mais disponível nesta agência. Escolha uma pessoa ativa da equipe.',
  CONTENT_NOT_OPEN: 'A conversa não aceita comentários enquanto o conteúdo está cancelado.',
  CONTENT_NOT_EDITABLE: 'O estado deste conteúdo mudou e não permite esta edição. Atualize o detalhe antes de tentar novamente.',
  CLIENT_ARCHIVED: 'Este cliente foi arquivado. O cadastro e o histórico estão preservados, mas novas alterações estão bloqueadas.',
};
export function describeProductError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (messages[cause.code]) return messages[cause.code];
    if (cause.status === 401) return 'Sua sessão expirou. Entre novamente para continuar.';
    if (cause.status === 403) return 'Seu acesso não permite esta ação. Confira o contexto e peça ajuda ao responsável pela agência.';
    if (cause.status === 404) return 'Este item não está mais disponível neste acesso. Atualize a lista para conferir.';
    if (cause.status === 409) return 'As informações mudaram desde que você abriu a tela. Atualize o conteúdo e confira antes de repetir a ação.';
    if (cause.status === 429) return 'Foram feitas muitas tentativas em pouco tempo. Aguarde um momento antes de tentar novamente.';
    if (cause.status >= 500) return 'O serviço não conseguiu concluir agora. Suas alterações continuam na tela; tente novamente em instantes.';
    return 'Não foi possível validar a alteração. Confira os campos indicados antes de tentar novamente.';
  }
  if (cause instanceof TypeError) return 'Não foi possível conectar. Confira sua internet; as alterações continuam na tela.';
  if (cause instanceof Error && cause.message && !cause.message.startsWith('[')) return cause.message;
  return 'Não foi possível concluir. Confira os campos indicados e tente novamente.';
}
