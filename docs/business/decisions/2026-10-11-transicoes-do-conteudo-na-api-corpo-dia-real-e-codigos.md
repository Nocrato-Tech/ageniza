# As transições do conteúdo na API: o corpo de cada rota, o dia real da publicação e os códigos de recusa

**Data.** 2026-10-11

**Contexto.** A SPEC de conteúdo (`specs/conteudo.md`, seções 4 e 6) lista as seis rotas de transição da agência (`submit`, `approve-by-agency`, `publish`, `unpublish`, `cancel`, `reschedule`) e diz o que cada uma devolve, mas não o corpo de cada uma, de onde vem "a data real" de `publish` nem os códigos das recusas. O banco já decide o estado, quem aprovou e quando (`20261007001200`, `20261007001500`) e responde por códigos `A00xx`. Issue #256, com os comentários do #389, do #392, do #394 e o aceite adicional do maestro a partir da revisão do PR #542.

**Decisão.**

1. **Resposta.** Toda rota devolve `200` com o `ContentDetail` lido de volta, o mesmo do `PATCH`. Repetir uma ação num conteúdo que já está no estado de chegada é `200` sem mudança (é o que a função do banco faz); a primeira aprovação, a primeira data de publicação e o primeiro cancelamento permanecem.
2. **Corpo.** `submit`, `unpublish` e `cancel` não têm corpo. `approve-by-agency` leva `revision` (a revisão que a pessoa leu: a função recusa com `409 CONTENT_REVISION_CHANGED` se a legenda, a capa, o formato ou a mídia mudou desde então) e `reason` (obrigatório, pela regra única de texto livre: sem controle nem invisível, aparado, até 5000 bytes, que é o limite da coluna). `publish` leva `publishedOn` opcional e `reschedule` leva `publishOn` opcional; os dois aceitam corpo ausente como `{}`. Nenhum campo de estado, de quem aprovou ou de quando é aceito (`.strict()`).
3. **O dia real da publicação.** Sem `publishedOn`, vale hoje no dia de `America/Sao_Paulo`, lido de um instante que o módulo recebe (`dependencies.now`, fixado nos testes) pela única função de conversão do banco (`app_private.sao_paulo_date`). Com `publishedOn`, pode ser anterior e nunca futuro (`400 CONTENT_PUBLISHED_ON_INVALID`, do gatilho): é a leitura de `2026-10-07-conteudo-conteudo-no-banco.md`, item 8, que já diz que a data real "pode ser anterior" e que desfazer vale no dia em que a publicação foi **marcada**, não no da data informada. `reschedule` sem `publishOn` mantém o dia que o conteúdo tinha.
4. **Mídia que não terminou de subir** é recusa com código próprio: `409 CONTENT_MEDIA_NOT_CONFIRMED`, tanto ao enviar para aprovação e ao publicar (a função recusa com `A0065`, e a rota lê a mídia de novo para distinguir "pendente" de "faltando") quanto ao aprovar pela agência (a função não confere mídia, e a rota confere depois dela, na mesma transação, e desfaz tudo se houver mídia pendente). Mídia faltando, ou capa removida da pasta, continua `409 CONTENT_MEDIA_INCOMPLETE`, com uma mensagem que cita a capa. O cliente nunca recebe para aprovar um post com mídia que não terminou de subir.
5. **Os demais códigos.** `A0062` -> `409 CONTENT_STATE` (com a mensagem do que aquela ação exige), `A0063` -> `409 CONTENT_REVISION_CHANGED`, `A0064` -> `409 CONTENT_UNPUBLISH_EXPIRED`, `A0066` -> `409 CONTENT_TASKS_NOT_APPROVED`, `A0067` -> `400 CONTENT_PUBLISHED_ON_INVALID`, `A0068` -> `400 CONTENT_REASON_INVALID`, `A0061` e `A0020` -> `409 CLIENT_ARCHIVED`, `A0060` -> `404`, `A0074` -> `403`, `40P01` e `40001` -> `409 TRY_AGAIN`.
6. **A permissão.** Cada ação exige a da seção 2 da SPEC e também `conteudo.visualizar`, como as escritas já feitas (`conteudo.operar` para `submit` e `reschedule`; `conteudo.aprovar_pela_agencia` para `approve-by-agency`; `conteudo.publicar` para `publish` e `unpublish`; `conteudo.cancelar` para `cancel`). A rota confere antes de qualquer consulta; a função do banco confere de novo por dentro.

**Alternativas fechadas.** Exigir `publishedOn` no corpo da publicação: o botão "marcar como publicado" é do dia, e obrigar a tela a calcular o dia de São Paulo repete uma conversão que o banco já tem. Ler a revisão no servidor em vez de recebê-la: a aprovação anularia o que a revisão existe para proteger (aprovar o que não foi visto).

**Consequência.**

- Nenhuma migration, tabela, coluna, policy ou grant: as seis rotas chamam as funções que já existem. A fila de notificação (#407) é escrita pelo gatilho do banco; a rota não escreve nela, e o teste confere uma linha por pessoa ativa do portal, sem duplicar.
- O catálogo da API e o contrato OpenAPI ganham as seis rotas e os sete códigos novos.
- A versão do `contents` que lê o dia de hoje no relógio do servidor pode divergir do relógio do banco por segundos na virada do dia de São Paulo: o gatilho recusa uma data futura (`400`) e quem chamou repete.

**Origem.** Issue #256 e seus comentários; PR #542 (revisão de segurança da Coruja), que levou ao aceite da mídia não confirmada.

**Validação.** Pendente de validação do dono.
