# O estado do envio de mídia só anda para frente, e as colunas que o banco fixa não são gravadas pela aplicação

**Data.** 2026-10-07

**Contexto.** `media_assets` dava a `ageniza_app` `INSERT` e `UPDATE` em todas as colunas, e as policies só pedem `midia.enviar`. Um papel personalizado com **só** essa permissão confirmava uma mídia que a validação recusou (`rejected` → `confirmed`, limpando `rejected_reason`) e trocava `confirmed_size_bytes` de uma mídia de 100 MB por 1, derrubando a cota usada da agência de 104857600 para 1. Um `INSERT` já com `status = 'confirmed'` chegava ao mesmo estado forjado (issue #295, achados da auditoria dos PRs #294 e #290).

**Decisão.** Três camadas, no desenho do convite (#290):

1. `INSERT` e `UPDATE` viram grants **por coluna**. Nenhum `UPDATE` grava `id`, `agency_id`, `category`, os valores declarados, as chaves de objeto, `created_by_user_id` e `created_at`; nenhum `INSERT` grava `status`, `confirmed_*`, `rejected_reason` nem as colunas de vídeo, então nenhuma linha nasce com estado. `ageniza_app` perde o `DELETE`: o comentário de `20260921000000` dizia que não havia, e os privilégios padrão o concediam.
2. Um trigger `BEFORE UPDATE` (`security invoker`, só para `current_user = 'ageniza_app'`, lendo `OLD` depois do lock da linha) permite só `pending` → `confirmed` e `pending` → `rejected`. A confirmação carrega tamanho, tipo e hora e nenhum motivo de rejeição; a rejeição carrega o motivo e nenhuma confirmação. O resultado (`confirmed_size_bytes`, `confirmed_content_type`, `confirmed_at`, `rejected_reason`) é escrito uma vez, junto com o estado, e nunca mais.
3. Os testes rodam como `ageniza_app` com um papel de uma permissão só, comparam o catálogo de colunas nos dois sentidos e incluem duas transações reais contra a mesma linha.

**Limite.** A API e o worker conectam como `ageniza_app` em nome da pessoa, então o banco não distingue o servidor de quem tem `midia.enviar` e executa SQL: uma pessoa assim ainda consegue levar **uma** mídia `pending` a `confirmed` com um tamanho escolhido por ela. O que o banco garante é a forma da transição, que não volta nem se reescreve; a prova de que o conteúdo foi validado continua sendo a rota `complete`. Fechar isso exige uma identidade de serviço separada ou uma função `security definer` que receba prova, e é decisão estrutural própria.

**Alternativas descartadas.** `CHECK` na tabela: altera tabela existente e valida linhas já gravadas. Função `security definer` para confirmar: o chamador continuaria escolhendo o tamanho. Exigir `confirmed_size_bytes = declared_size_bytes`: é regra de negócio nova, que a SPEC não cobre, e o objeto real pode diferir do declarado.

**Consequência.** Coluna nova em `media_assets` nasce sem permissão de escrita: a migration que a criar (Conteúdo, #247) concede explicitamente o que a aplicação precisa. As colunas de processamento de vídeo, do worker, seguem sem trava de direção, e `created_by_user_id` segue sem ser fixado ao ator no `INSERT`; nenhuma das duas estava nas issues e ficam como pendência. Pelos cinco critérios de `docs/business/structural-changes.md` não é estrutural (nenhuma tabela, coluna, policy, formato de resposta ou forma de autorização muda, e não há backfill), mas mexe em grant de tabela existente e o gate de CI o trata como estrutural.

**Origem.** Issue #295, por decisão do maestro com a autonomia dada pelo dono do produto em 2026-10-07.

**Validação.** Pendente de validação do dono.
