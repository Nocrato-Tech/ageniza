# Demonstração no aplicativo mobile

## 1. Propósito
Demonstrar o app verdadeiro, com dados de exemplo gravados pela API. Substitui a entrada independente de apresentação (#833).

## 2. Atores
Cadastro e login permanecem públicos, com confirmação de e-mail e termos. Preparação requer pessoa autenticada com `canCreateAgency`. Retomada é exclusiva do Owner na agência criada pela preparação. Cada escrita é autorizada pelo servidor.

## 3. Dados
Nova agência de demonstração, dois clientes fictícios de saúde, pastas, imagens PNG próprias, conteúdos do mês e tarefas atribuídas à pessoa que criou a agência. Sem nomes, contatos ou credenciais reais embutidos. IDs sempre devolvidos pelo servidor.

## 4. Transições
Confirmar criação → criar agência pela API → entrar nela → preparar clientes/pastas/mídias/conteúdos/tarefas → concluir. Falha mantém contexto e permite retomar por leitura dos registros já existentes. Não volta a criar agência durante retomada. Não fabrica estados de conteúdo: envio, aprovação e publicação passam pelas ações normais do app.

## 5. Invariantes
Sem sucesso local substituindo API. Sem bypass de e-mail/termos/RLS. Sem escrita na agência de origem. Sem envio automático de convites ou pagamento. Exemplos não substituem dados consultados após recarregar. Sem semente automática na entrada. Recursos de preparação e ML sintético só habilitados na exportação web dev.

## 6. Backend
Reutiliza `/agencies`, `/me/contexts`, clientes, pastas, uploads, conteúdos e tarefas existentes. Assinatura usa `quote`, `charges`, `charges/:id/simulated-payment`, `cancel` e `reactivate`. Nenhuma rota nova, mudança de schema ou migração.

## 7. UX
Seletor de contextos oferece criação identificada de agência de demonstração após autenticação. Agência criada recebe preparação com progresso, erro/retomada e opção de entrar com dados parciais. Menu Mais oferece continuação da preparação. Todas as telas oficiais permanecem acessíveis. ML aparece no detalhe do conteúdo, com origem sintética e explicação. Assinatura mostra simulação somente quando o backend informa `paymentProvider=simulado`; sempre exige revisão do valor antes da confirmação.

## 8. Infraestrutura
Mesmo app em `/app-mobile/`, exportado na imagem web dev. Produção não habilita a preparação. Vercel encaminha à origem oficial; não intermedeia credenciais. Worker de notificação tem escopo `/app-mobile/`, sem handler de fetch ou push remoto.

## 9. Impacto estrutural
Nenhum. Reutiliza autorizações e formas de resposta vigentes.

## 10. Em aberto
Confirmação manual de entrega de notificação pelo SO. Distribuição nativa iOS, ML com histórico real e gateway financeiro de produção ficam fora desta demonstração.

## 11. Verificação
Testar isolamento do alvo, bloqueio fora de dev, retomada após falha parcial sem duplicar registros, ausência de fallback, confirmação de pagamento conforme resposta do servidor, recusa sem ativação, ML reagindo aos sinais e notificações negadas/sem suporte. Tipos, lint, testes e exportações, revisão independente e verificação publicada após deploy.

## 12. Recorte
Issue #833. Corrige a interpretação do PR #832; não conclui as issues de produção #817–#820.
