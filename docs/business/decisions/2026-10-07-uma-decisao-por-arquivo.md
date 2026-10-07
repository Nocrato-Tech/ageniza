# Uma decisão por arquivo

**Data.** 2026-10-07

**Contexto.** Toda entrega acrescentava uma entrada no fim de `docs/business/decisions.md`, que chegou a 1394 linhas, e em 2026-10-06 isso gerou conflito em quase todo PR a cada merge no develop; cada conflito custou uma rodada de agente com emenda manual e conferência. O PR #314 propôs `merge=union` no `.gitattributes`, e a revisão provou que o union troca o conflito visível por corrupção silenciosa: a entrada nova perde o `---` e cola na anterior, entradas com linhas iguais saem intercaladas, e duas edições da mesma linha ficam duplicadas sem aviso. O PR foi fechado sem merge.

**Decisão.** Cada decisão vive no próprio arquivo, em `docs/business/decisions/AAAA-MM-DD-<slug>.md`, e as entradas antigas foram todas migradas, uma por arquivo. **Não há índice escrito à mão nem gerado:** a listagem da pasta, ordenada pelo nome, é o registro cronológico. Índice manual voltaria a ser um arquivo único em conflito; índice gerado exigiria um commit de CI a cada decisão. `decisions.md` fica congelado, curto, só para as citações antigas.

**Consequência.** Duas entregas nunca mais tocam o mesmo arquivo, e o conflito no registro desaparece. Quem procura "por que assim?" navega pelo nome do arquivo (data + título) em vez de rolar um arquivo único. O gate de CI que exigia `decisions.md` tocado junto de uma migration estrutural passa a aceitar qualquer arquivo em `docs/business/decisions/`.

**Origem.** Issue #315, decisão do maestro com autonomia dada pelo dono do produto em 2026-10-07.

**Validação.** Pendente de validação do dono.
