# Roteiro de stories na API: limites, texto livre e edição pela lista inteira

**Data.** 2026-10-11

**Contexto.** A #258 abre as rotas dos roteiros de stories (`specs/conteudo.md` §6) sobre a tabela, as funções e a RLS da #248 ([`2026-10-07-conteudo-roteiro-de-stories-no-banco.md`](2026-10-07-conteudo-roteiro-de-stories-no-banco.md)). A SPEC dá as rotas e as permissões, e a #248 deixa para a API o que o banco não impõe (item 12 e 13 daquela decisão), mas ninguém fixou o limite de cenas, o tamanho do texto, o que o texto livre recusa, como se edita uma lista de cenas que nunca perde cena, nem o que a resposta carrega. A issue pede o limite e a recusa no schema da rota, e que a resposta mostre quem gravou.

**Decisão.**
1. **Limites da API:** até 30 cenas por roteiro, 2000 caracteres no texto de uma cena e 1000 na orientação (em unidades UTF-16, bem abaixo dos 20000 bytes do `CHECK`). Texto e orientação são aparados; orientação ausente, nula, vazia ou só de espaço é "sem orientação" e fica nula.
2. **Texto livre recusa** caractere de controle (menos tabulação, LF e CR, as quebras que uma pessoa digita), separador de linha e de parágrafo, todo caractere de formato (`Cf`, inclusive o espaço de largura zero, os dois joiners, os controles bidi, o BOM e o hífen suave), todo `Default_Ignorable_Code_Point` que não é `Cf` (seletores de variação, CGJ, preenchimentos de Hangul) e o espaço em branco do Braille. **Exceção:** o seletor de emoji U+FE0F logo depois de um pictograma, que é como o celular escreve um coração; isolado ou depois de outra coisa, é recusado. Os joiners também ficam fora das famílias de emoji: é a escolha da issue, e quem quiser emoji composto reabre o ponto.
3. **A edição é a lista inteira.** `PATCH` recebe `scriptOn` e/ou `scenes`. `scenes` é o roteiro na nova ordem: cena com `id` já existe (texto, orientação e lugar mudam), cena sem `id` é nova. Como a #248 não dá `DELETE` de cena, a lista tem de trazer todas as cenas do roteiro; faltar uma, ou trazer o id de outra, é 409 `STORY_SCENES_MISMATCH` (também a lista velha de quem não viu a cena que outro acrescentou). A mesma recusa vale para id de outro roteiro, para que a resposta não diga que ele existe.
4. **Só rascunho se edita.** Editar um roteiro enviado ou gravado é 409 `STORY_SCRIPT_STATE`, mesmo quando a edição não muda nada. Enviar um já enviado é 200 sem mudar nada (a função da #248 já é idempotente); enviar um gravado é 409.
5. **Rascunho não existe para o portal, nem para quem lê rascunho pela agência.** O colaborador que também tem vínculo com o cliente lê rascunho pelo ramo da agência da policy, mas na rota do portal um rascunho é o mesmo 404 `Story script not found.` que um id inexistente, e a listagem do portal nunca o traz. A regra está no SQL da rota, não na policy.
6. **Quem gravou:** a resposta traz `recordedBy: { name }` e `recordedAt`, e o nome é o da pessoa pelo vínculo dela com o cliente, lido por uma função `security definer` de propósito único (`app_private.story_script_recorder`, registrada em [`2026-10-11-nome-de-quem-gravou-o-roteiro-por-funcao-de-leitura.md`](2026-10-11-nome-de-quem-gravou-o-roteiro-por-funcao-de-leitura.md), no PR de banco da #258), porque o portal não lê o vínculo dos outros. O vínculo removido depois não apaga o nome. A resposta do portal não traz id de cena nem `createdAt`.
7. **O portal não sabe de arquivamento.** `A0020` e `A0051` são 404 `Client not found.` no portal e 409 `CLIENT_ARCHIVED` na agência; a rota de gravar chama a função só para um roteiro que a própria consulta do portal leu.

**Consequência.**
- Cena não se remove nem pela API: se for pedido, é migration nova com `DELETE` ou estado de cena, e decisão nova.
- Um roteiro sem cena e mais de um roteiro no mesmo dia continuam permitidos, como a #248 deixou.
- O limite de 30 e os de 2000 e 1000 caracteres são uma constante do contrato (`packages/contracts/src/story-scripts.ts`): mudar é trocar o número e os testes de borda.
- A consulta por período do portal usa o helper do contrato de roteiros enquanto o da #254 não está no `develop`; os dois se unificam depois.

**Origem.** Issue #258, decidido na implementação a pedido do maestro, dentro da decisão do dono de 2026-10-01 (SPEC de Conteúdo) e da #248.

**Validação.** Pendente de validação do dono.
