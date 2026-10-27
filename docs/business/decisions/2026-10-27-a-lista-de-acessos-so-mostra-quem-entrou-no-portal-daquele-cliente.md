# A lista de Acessos só mostra "entrou" e o nome de quem abriu o portal daquele cliente

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 (item 4) pede que a lista de Acessos mostre "ainda não entrou" até a pessoa entrar no portal pela primeira vez e que nunca diga se o e-mail tem conta. A implementação inicial tirava o "entrou" e o nome do vínculo (`user_id`), que acontece em qualquer carga de `/me/contexts`, inclusive de quem só usa outra agência. A revisão do PR #728 mostrou o resultado: uma agência adiciona o e-mail de um usuário de outra agência e, na carga seguinte do app dele, vê o nome da conta, sem que ele abra o portal. A segunda rodada achou o mesmo vazamento por dois canais que não mostram o nome: a ordenação da lista (pelo nome da conta) e a contagem do resumo (que contava o membership que o vínculo cria).

**Decisão.**

1. O acesso ganha `first_entered_at`, gravado **uma vez**, quando a conta **entra no portal daquele cliente**: abre o portal do cliente (`GET /clients/:clientId`), seleciona o contexto dele (`PUT /me/last-context`) ou o `resolve` decide entrar nele (um contexto só, ou o último usado). Carregar a lista de contextos não entra em nenhum portal.
2. A lista mostra `entered` e o nome da conta **só depois disso**. Antes, `entered` é falso, o nome é nulo e a linha traz o e-mail como foi gravado. A **ordem** da lista usa a mesma expressão do nome mostrado (o nome da conta só depois da entrada, o e-mail antes), e a contagem "pessoas com acesso" do resumo do cliente conta os **acessos ativos**, não os membership. O vínculo pode seguir na carga de contextos, porque nada visível à agência depende dele: nem a lista, nem a ordem, nem a contagem.
3. Quem já está no portal hoje (backfill), quem aceita um convite antigo e quem um escritor legado põe no portal contam como "entrou". O endereço que passa a outra conta (Adicionar pessoa de novo, aceite do convite) apaga a entrada da anterior; o vínculo novo nasce sem entrada.
4. Agência em somente leitura não grava a entrada (o acesso fica "ainda não entrou" até a agência renovar), e o portal segue funcionando.

**Consequência.** Nova coluna `client_portal_accesses.first_entered_at`, função `app_private.mark_client_portal_entered` e backfill. O contrato da lista não muda (`entered`, `name`). O custo é uma escrita única por pessoa e cliente.

**Origem.** Revisão de segurança do PR #728 (achado 2, Média, e achado da 2ª rodada, Média), sobre a decisão de 2026-10-26, item 4.

**Validação.** Pendente de validação do dono.
