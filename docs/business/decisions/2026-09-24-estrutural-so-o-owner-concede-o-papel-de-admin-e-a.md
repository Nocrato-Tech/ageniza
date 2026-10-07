# ESTRUTURAL: só o Owner concede o papel de Admin, e a autorização passa a depender do valor
**Data.** 2026-09-24

**Esta é uma mudança estrutural**, por dois dos cinco critérios de [structural-changes.md](structural-changes.md): mexe em policies de RLS de **mais de um módulo**, e muda **como a autorização é avaliada**. Registrada antes de qualquer implementação.

**Contexto.** Até aqui toda autorização do sistema responde uma pergunta só: *tem a chave?*. `app_private.has_agency_permission(agency_id, permission)` recebe uma permissão e devolve sim ou não. A regra "quem pode atribuir outros Admins é o Owner" pergunta outra coisa: *tem a chave **e** qual valor está sendo concedido?*. E ela tem um segundo ponto de fuga: se só o Owner promove a Admin mas o Admin pode **convidar** alguém já como Admin, a regra não existe.

**Decisão.** A regra é expressa por **duas permissões**, não por uma condição escondida na rota:

- `colaborador.alterar_papel` — o Admin recebe, e vale para papéis **não administrativos**.
- `colaborador.atribuir_admin` — **nenhum preset recebe**. Só o Owner passa, porque ele faz curto-circuito na verificação por posse.

A mesma dupla vale nos dois pontos onde um papel é concedido: **a troca de papel** de um vínculo e **a criação de um convite** de colaborador. Uma regra que vale em um lugar e não no outro não é regra.

**Consequência.** Duas policies são tocadas, em módulos diferentes:

- `agency_memberships` ganha policy de `UPDATE`, que **não existe hoje** — a tabela só tem `SELECT`, e é por isso que trocar papel e remover colaborador não funcionam em nenhuma das duas camadas.
- `invitations` tem sua policy de `INSERT` **substituída** para reconhecer a nova condição. `drop policy` dispara o gate de CI, e é por isso que esta entrada existe antes do código.

Ganha-se uma propriedade que vale registrar: `colaborador.atribuir_admin` é uma permissão que **existe e não é concedida a ninguém**, porque a posse é a única forma de tê-la. Quando papéis personalizados existirem (#52), ela já está na lista de não delegáveis por construção.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

**Nota de implementação (2026-09-28, issue [#94](https://github.com/Nocrato-Tech/ageniza/issues/94)).** A migration `20260928000000_collaborator_permissions_and_admin_grant.mjs` cria `agency_memberships_update` — a policy de `UPDATE` que faltava — e substitui `invitations_insert`. A checagem do papel `admin` ficou numa função nova, `app_private.is_admin_role`, reaproveitada nos dois pontos onde um papel é concedido, como a decisão pedia.

**Correção pós-revisão (2026-09-29, PR [#159](https://github.com/Nocrato-Tech/ageniza/pull/159)).** A revisão de segurança do PR achou dois defeitos na primeira versão, ambos na mesma migration (ainda não mergeada):

1. O grant de `UPDATE` continuava de tabela inteira, então `agency_id`/`user_id`/`id` seguiam graváveis; qualquer ator com uma permissão do módulo movia um vínculo entre agências ou usuários sem tocar `role_id`/`job_title`/`status`, contornando o gate por completo. Corrigido com `revoke update` + `grant update (role_id, job_title, status, updated_at)`, no mesmo padrão já usado por `client_memberships` (2026-09-20) e `invitations` (2026-09-25).
2. A comparação valor-antigo/valor-novo, feita por sub-select sem `FOR UPDATE` na `WITH CHECK`, lia o snapshot do início do statement — correto contra um único escritor, mas sob `READ COMMITTED` com duas transações concorrentes o `UPDATE` reaplica via EvalPlanQual sobre a versão mais nova, e o sub-select continua lendo a antiga. Um Admin sem `colaborador.atribuir_admin` conseguia reconceder `admin` logo depois que o Owner rebaixava o mesmo vínculo. Corrigido movendo a comparação para um trigger `BEFORE UPDATE` (`app_private.check_agency_membership_update`), cujo `OLD` é a linha realmente travada para a escrita, não uma leitura independente.

A `WITH CHECK` ficou só com a filtragem de linha (mesma condição da `USING`); toda a lógica que depende do valor novo — inclusive o escopo de `role_id` por agência (também endereçado aqui, e replicado em `invitations_insert`) — está no trigger. Uma consequência visível nos testes: o trigger lança uma exceção com `errcode 42501` e mensagem própria em vez do texto "row-level security" do Postgres, então `tenancy.integration.test.ts` passou a casar contra essas mensagens onde antes usava `/row-level security/`.

**Segunda correção pós-revisão (2026-09-29, mesma PR).** A re-revisão achou que o trigger, sendo `security definer` e decidindo o bypass administrativo pela ausência de `app.user_id`, tinha dois defeitos:

1. **[ALTO] Regressão no aceite de convite.** `app_private.accept_invitation` também é `security definer` e reativa um vínculo `removed` (ou grava o vínculo do novo Owner) via `INSERT ... ON CONFLICT DO UPDATE` — o que dispara o trigger com `app.user_id` igual ao **convidado**, não a um ator com `colaborador.alterar_papel`. Aceitar um reconvite como colaborador removido, ou uma ativação de agência quando o convidado já tinha uma linha na agência, passou a devolver erro em vez de reativar o vínculo.
2. **[MÉDIO] O bypass dependia do GUC, não do papel.** `set_config` é `PUBLIC`, então `ageniza_app` podia limpar `app.user_id` **no meio da própria instrução** (dentro do subselect da cláusula `SET`, que o Postgres avalia depois da `USING` e antes do trigger). Hoje isso não é explorável porque a `WITH CHECK`, reavaliada depois com o GUC já vazio, ainda barra — mas a segurança do trigger passava a depender desse detalhe de ordem de avaliação, não de uma verificação própria.

**Correção.** O trigger deixou de ser `security definer` (roda como quem chama, `security invoker`, o padrão) e o critério do early return trocou de "há `app.user_id`?" para "`current_user = 'ageniza_app'`?". `current_user` é o papel da própria conexão — imutável no meio de uma instrução, ao contrário do GUC — e diferencia exatamente o que importa: o dono do schema (migrations, fixtures de teste, e qualquer função `security definer` de sua propriedade, `accept_invitation` incluída) sempre contorna este trigger, como já contorna a RLS da tabela; só uma instrução executada como `ageniza_app` é sempre checada, e nenhum SQL que `ageniza_app` possa emitir muda o papel da própria conexão. As funções chamadas de dentro do trigger (`has_agency_permission`, `is_agency_owner`, `is_admin_role`) continuam `security definer` com `execute` para `ageniza_app`, então a superfície de autorização não muda.

**Fica para a API (issues [#97](https://github.com/Nocrato-Tech/ageniza/issues/97)/[#98](https://github.com/Nocrato-Tech/ageniza/issues/98)):** mapear os erros de RLS/trigger (42501) para 403 em vez de 500, inclusive no reenvio de convite de admin por quem não tem `colaborador.atribuir_admin`; e as regras "ninguém altera o próprio papel", "ninguém remove a si mesmo" e "reativar exige `role_id` novo no corpo", que a #94 nunca cobriu no banco.

