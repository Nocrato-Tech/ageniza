# Conteúdo: o texto livre da rota e os códigos de erro da agência

**Data.** 2026-10-11

**Contexto.** A decisão de `2026-10-07-conteudo-conteudo-no-banco.md` (ponto 13) deixou para o schema da rota (#254) o caractere de controle e a largura zero do título e da legenda, e os pontos 11 e 15 dela deixaram para a API traduzir os códigos `A00xx`. A SPEC dá os limites (título até 120 caracteres, legenda até 2.200) e não diz o que é texto aceito. A revisão de segurança do PR #383 e do #386 pediu que a rota traduza o `A0020` do arquivamento, e o checklist (item 23) manda recusar também o que é `Default_Ignorable_Code_Point` sem ser `Cf`.

**Decisão.**
1. **O título** é uma linha de 1 a 120 caracteres (contados como o banco conta, em caracteres e não em bytes nem unidades UTF-16: 120 emojis passam, 121 não), aparado nas pontas. A **legenda** tem até 2.200 caracteres, aceita tabulação, quebra de linha e retorno de carro, e uma legenda em branco é nenhuma (`null`).
2. **Os dois recusam**: caractere de controle (`Cc`, inclusive NUL, ESC e o NEL de U+0085; na legenda, todos menos tabulação, LF e CR), separador de linha e de parágrafo (`Zl`, `Zp`), os preenchedores Hangul (U+115F, U+1160, U+3164, U+FFA0), todo caractere de formato `Cf` (bidi, espaço de largura zero, junção de palavras, BOM, hífen suave) menos os dois joiners, e tudo que é `Default_Ignorable_Code_Point` sem ser `Cf` (o conector combinante CGJ U+034F, os seletores de variação, as vogais inerentes khmer, os caracteres de tag) mais o espaço Braille U+2800, que desenha um espaço. Os joiners ZWJ e ZWNJ só passam entre letras, marcas e pictogramas (a regra do nome de exibição). Um substituto isolado (`surrogate`) é recusado.
3. **Exceção: os seletores de emoji.** Os seletores de variação U+FE0E e U+FE0F passam **uma vez, logo depois de um pictograma** (ou da base de um keycap: dígito, `#`, `*`), porque são o que faz "❤️" e "1️⃣" serem escritos; depois de uma letra, no começo, repetidos ou em qualquer outro lugar, são recusados como os demais invisíveis. Uma legenda de Instagram sem emoji não seria a legenda que alguém escreve.
4. **Os erros da agência.** Cada recusa do banco que a rota deixa passar tem uma resposta com nome, nunca 500: `A0020` (arquivamento em curso) e `A0061` → `409 CLIENT_ARCHIVED`; `A0060` → `404 NOT_FOUND`; `A0062` → `409 CONTENT_NOT_EDITABLE`; `A0065` → `409 CONTENT_MEDIA_INCOMPLETE`; `A0069` → `400 CONTENT_MEDIA_INVALID`; `A0073` → `400 CONTENT_OWNER_INVALID`; `A0074` → `403 FORBIDDEN`; `40P01` e `40001` → `409 TRY_AGAIN`; e as chaves estrangeiras de pasta, capa e responsável pelo nome da restrição. Nenhuma resposta leva a mensagem do banco.
5. **A corrida com o arquivamento tem duas janelas, e a rota responde `409 CLIENT_ARCHIVED` nas duas, sem gravar.** (a) O arquivamento está em curso: a linha passa na policy sobre o instantâneo em que o cliente ainda está ativo e espera o gatilho de `20261007001400`, que levanta `A0020` quando o arquivamento confirma. (b) O arquivamento já confirmou entre a leitura do cliente pela rota e o `INSERT` ou `UPDATE`: a policy da tabela recusa a linha (`42501`). Como o `42501` também é a recusa de quem perdeu a permissão, a rota **lê o cliente de novo, numa transação nova, depois das travas**: arquivado é 409, ativo é 403, ausente é 404.
6. **A consulta de cliente é sempre dentro da agência do caminho.** Um cliente de outra agência, mesmo para uma pessoa que tem vínculo nas duas (a RLS mostraria a linha), responde o `404` de quem não existe; o mesmo vale para um conteúdo de outro cliente.

**Consequência.**
- Os mesmos schemas (`ContentTitleSchema`, `ContentCaptionSchema`) estão em `packages/contracts` e o navegador os importa.
- Quem abrir Tarefas, pasta ou roteiro copia a tradução de erros (`apps/api/src/modules/contents/errors.ts`) e a leitura do cliente depois do `42501`.
- Afrouxar uma recusa de texto é tirar uma linha do schema; apertar é acrescentar uma, e o conteúdo já gravado não muda.

**Origem.** Issue #254; requisitos dos PRs #383 e #386 e item 23 de `docs/implementation-checklist.md`.

**Validação.** Pendente de validação do dono.
