# O cargo segue a regra de caracteres do nome exibido

**Data.** 2026-10-07

**Contexto.** A revisão de segurança do PR #320 (issue #324, severidade baixa) achou que `job_title` só recusava C0 e DEL: a API gravava um cargo com RLO (o texto "Analista", o caractere U+202E e "nimda" aparece na tela como "Analista admin"), LRI, espaço de largura zero, cargo só de espaço de largura zero (invisível, e não vira `null`), BOM, NEL e CSI (C1), U+2028 e o preenchimento Hangul. Cargo é texto mostrado sobre uma pessoa, como o nome (#200).

**Decisão.**

1. O cargo usa a mesma regra do nome exibido (`createDisplayNameSchema`, #200) com o teto de 256 unidades UTF-16: recusa caracteres de controle, de formato (exceto os dois joiners entre letras, marcas ou pictogramas), invisíveis, separadores de linha e de parágrafo e os preenchimentos Hangul, e exige ao menos uma letra ou número. **Consequência visível:** um cargo só de emoji ou só de pontuação deixa de ser aceito, como já vale para o nome.
2. `null` e texto em branco limpam o cargo. "Branco" é o que o `trim` do JavaScript remove (espaço, tabulação, NBSP, BOM nas bordas), o mesmo conjunto que o banco normaliza; vira `null` como a razão social do cliente (2026-10-06). Isto muda o `PATCH` da #97, em que um cargo em branco era `400`. **Um valor só de invisíveis** (espaço de largura zero, preenchimento Hangul) **não é branco**, não é espaço para o `trim`, e é recusado com `400`: assim não dá para gravar nem para apagar o cargo com algo invisível. A issue diz as duas coisas ("só-invisível vira `null`" e "400 e nada gravado"); esta é a leitura que cumpre as duas.
3. **Sem migration.** O banco continua com a `CHECK` de forma e tamanho (#225) e não recusa esses caracteres: uma `CHECK` mais estrita exigiria backfill de cargos legados que tenham algum deles, para não quebrar qualquer `UPDATE` de vínculo (remover, reativar, trocar papel) de quem o tem, e a regra é de exibição, não de integridade. O contrato de **resposta** continua aceitando qualquer cargo não vazio de até 256 unidades, para um legado nunca derrubar a leitura da agência com 500. O filtro `jobTitle` da listagem segue só com C0 e DEL: aceita um superconjunto do que a escrita aceita, e um teste pina que todo cargo gravado é filtrável.

**Consequência.** Todo texto exibido de pessoa (nome, cargo, contato) segue a mesma regra de caracteres do #200; o filtro só de C0 da busca não basta para dado exibido. Cargos legados com esses caracteres continuam existindo e sendo lidos; são corrigidos pelo `PATCH`, que agora recusa o novo valor se tiver algum deles.

**Origem.** Issue #324, ressalva da revisão de segurança do #320. **Pendente de validação** pelo dono do produto: o item 2 (branco limpa em vez de 400) e o item 3 (sem migration nem backfill).

