# ESTRUTURAL: a persona se exclui com a conversa dela e não se arquiva

**Data.** 2026-11-12

**Contexto.** A persona do estudo de marca tinha dois estados, `active` e `archived` (`client_personas.status`). Arquivar tirava a persona do portal e deixava a conversa dela (`client_threads.persona_id`) somente leitura, mas a tela da agência não dava caminho para reler essa conversa, e o estado arquivado exigia regras em três camadas (política, gatilho, rota) sem trazer nada que o dono quisesse manter. O dono pediu o oposto: criar, editar e **excluir** a persona, sem arquivar. Isso é estrutural: muda uma tabela existente (`status` deixa de variar, com backfill das arquivadas), concede um `DELETE` que a aplicação não tinha nessa tabela e faz a exclusão da persona atravessar duas tabelas por cascata.

**Decisão.**

1. **A persona não se arquiva.** Some a ação de arquivar e a de desarquivar (rota, tela e catálogo da API), a seção de arquivadas da tela e o `status` da resposta. A coluna `status` fica, por causa das políticas que a leem, mas só aceita `active` (`CHECK`) e o `ageniza_app` não tem `UPDATE` sobre ela.
2. **As personas que estavam arquivadas voltam a ser normais** (backfill da migration): passam a `active`, com as conversas delas.
3. **A persona se exclui.** `DELETE …/personas/:personaId` exige `cliente.operar` e cliente ativo, apaga a persona **e a conversa dela** (as threads de `persona_id` e os comentários, por cascata de chave estrangeira) e grava `persona.deleted` em `audit.events`, com quem excluiu. O `ageniza_app` ganha `DELETE` **só** em `client_personas`; threads e comentários continuam sem `DELETE` concedido e somem apenas pela cascata.
4. **A exclusão não tem volta, e a tela avisa o tamanho dela.** O botão **Excluir** abre uma confirmação que diz quantas mensagens vão junto ("A conversa dela, com N mensagens, também será apagada. Não dá para desfazer."). A API devolve `messageCount` na persona para isso.
5. **Cliente arquivado não perde persona.** A exclusão trava o cliente ativo como as outras escritas nas filhas e é recusada com `A0020` (`409 CLIENT_ARCHIVED`) enquanto o cliente está arquivado.

**Substitui.**

- [`2026-10-07-conversa-persona-arquivada-recusa-abrir-thread`](2026-10-07-conversa-persona-arquivada-recusa-abrir-thread.md): não há persona arquivada, então não há recusa por persona arquivada (`PERSONA_ARCHIVED`); abrir ou comentar em persona excluída é "não encontrado".
- [`2026-10-08-conversa-de-persona-arquivada-sem-caminho-na-tela`](2026-10-08-conversa-de-persona-arquivada-sem-caminho-na-tela.md): a pergunta deixa de existir; a conversa da persona vai embora com ela.
- Na decisão [`2026-09-26-estados-de-cliente-de-acesso-ao-portal-de-thread-e-de`](2026-09-26-estados-de-cliente-de-acesso-ao-portal-de-thread-e-de.md), só o item da persona ("ativa ↔ arquivada"); os estados de cliente, acesso e thread seguem valendo.
- A linha "Exclusão reversível" de `docs/business/structural-changes.md` ("nenhuma rota exclui fisicamente entidade de negócio") não vale para a persona. O texto desse arquivo é do maestro atualizar.

**Consequência.** A exclusão é física: a persona e as mensagens dela não podem ser recuperadas, e só o registro `persona.deleted` fica. Quem quer guardar o que a persona tinha precisa copiar antes. Uma conversa que corre com a exclusão recebe "não encontrado". O portal não lê mais persona arquivada, porque ela não existe. Migration nova, sem editar nenhuma aplicada: backfill do `status`, `CHECK`, `UPDATE` revogado, chaves estrangeiras de thread e comentário com `ON DELETE CASCADE`, `DELETE` concedido com política (`cliente.operar` e cliente ativo), gatilho que trava o cliente e gatilho que audita.

**Origem.** Pedido do dono do produto em 2026-11-12 (issue #891).

**Validação.** Validada pelo dono em 2026-11-12.
