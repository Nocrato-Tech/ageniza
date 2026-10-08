# A API recusa editar o próprio cargo e o cargo do Owner

**Data.** 2026-10-08

**Contexto.** O item 7 da decisão de [2026-10-07](2026-10-07-patch-do-vinculo-o-corpo-a-ordem-das-recusas-e-o-que-o.md) deixou o `PATCH` do vínculo aceitar o próprio cargo e o cargo do Owner, porque as regras invioláveis 4 e 5 da SPEC falam só do papel, e marcou como pendente a pergunta de recusar. A tela já mostra esses dois campos só para leitura. Na validação da #359 (linha 5) o dono respondeu: a API recusa.

**Decisão.**

1. **`PATCH /agencies/:agencyId/collaborators/:membershipId` com `jobTitle` no vínculo do Owner ou no vínculo da própria pessoa é `403 FORBIDDEN`**, com mensagem própria ("O cargo do Owner da agência não pode ser alterado." e "Ninguém altera o próprio cargo."). Vale também para limpar o cargo com `null`, e para quem só tem `colaborador.alterar_funcao`.
2. **O Owner editando o próprio vínculo recebe a mensagem do Owner**: a regra usada para o papel é a mesma, o Owner é checado antes de "si mesmo". Não há exceção para o Owner: nem ele edita o cargo do próprio vínculo.
3. **Lugar na ordem das recusas.** É a última: depois do `403` do Owner e do próprio papel. Um corpo com `roleId` e `jobTitle` no próprio vínculo responde a recusa do papel. Quem não tem a permissão do campo continua recebendo o `403` por campo, antes de qualquer leitura.
4. **É condição na rota, sem migration.** O banco continua aceitando o cargo nesses vínculos (a `CHECK` só olha tamanho e forma, e o trigger do `UPDATE` só protege o papel); quem barra é a API.

**Consequência.**

- A resposta do `PATCH` nunca tem `isSelf: true`: o `PATCH` no próprio vínculo é sempre recusado. O `isSelf` verdadeiro sai do detalhe (`GET`).
- O cargo do Owner deixa de poder ser corrigido pela interface. Se o dono do produto quiser um caminho (por exemplo, o Owner editar o próprio cargo), é decisão nova.
- Esta decisão **substitui o item 7** da de 2026-10-07, que não é editada. Os demais itens dela continuam valendo.

**Origem.** Issue #410; validação da #359 (linha 5).

**Validação.** Validada pelo dono em 2026-10-08.
