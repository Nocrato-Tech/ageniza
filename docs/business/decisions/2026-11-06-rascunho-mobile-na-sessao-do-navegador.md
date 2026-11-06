# Rascunho mobile na sessão do navegador

**Validação.** Pendente de validação do dono.

## Contexto

A refatoração de UX solicitada pede continuidade da edição sem substituir a API real. Não existe contrato de autosave no servidor; salvar conteúdo continua uma ação explícita.

## Decisão

No cliente web mobile, conservar somente os campos editoriais e identificadores da seleção em sessionStorage, separados por conta, contexto e conteúdo. O rascunho expira após 24 horas, não é compartilhado entre dispositivos e é removido ao encerrar ou expirar a sessão. O limite por entrada é 48 KiB. Não armazenar credenciais, tokens, arquivos, URLs assinadas ou respostas completas da API.

Se o armazenamento estiver indisponível, conservar apenas em memória e comunicar essa limitação ao sair do editor. Antes de recuperar, verificar cliente e revisão atual; o servidor continua validando acesso e gravação. Descartar remove somente as alterações locais, nunca o conteúdo ou a mídia na API.

## Consequências

Recarregar a mesma aba pode recuperar alterações; fechar a aba ou limpar dados pode eliminá-las. Isso não é backup nem autosave remoto. O cliente nativo mantém recuperação em memória nesta entrega. Sincronização entre dispositivos exige um contrato próprio e não é introduzida silenciosamente.
