# ZWJ e ZWNJ entre letras latinas são recusados no nome do cliente

**Data.** 2026-10-08

**Contexto.** A regra de nome de exibição (#200, `createDisplayNameSchema`) aceita U+200D (ZWJ) e U+200C (ZWNJ) entre letras, marcas combinantes e pictográficos, porque são legítimos em persa, em escritas indianas e em emoji. Entre duas letras latinas eles não mudam o desenho, e o índice de nome único de cliente não os remove: "Ca" + ZWJ + "fé" criava um homônimo visual ativo de "Café" (ressalva da revisão do #299, issue #312).

**Decisão.** O nome do cliente (`ClientNameSchema`, cadastro e edição) recusa ZWJ e ZWNJ entre duas letras latinas. Persa, escritas indianas e sequências de emoji continuam aceitos. `createDisplayNameSchema` e os nomes de pessoas, o cargo, a razão social e os contatos não mudam. O mesmo nome passa a ser gravado em NFC e com todo espaço da categoria Zs trocado por espaço comum, sem migration.

**Consequência.** O `POST` e o `PATCH` de cliente respondem `400` para esse nome. Nomes já gravados não são corrigidos (sem backfill). Nome de pessoa não tem índice único, por isso não entra.

**Origem.** Issue #312, revisão de segurança do PR #299. Decisão do dono em 2026-10-08.

**Validação.** Validada pelo dono em 2026-10-08.
