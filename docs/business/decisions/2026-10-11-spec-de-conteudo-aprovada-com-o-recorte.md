# SPEC de Conteúdo aprovada, com o recorte de implementação

**Data.** 2026-10-11

**Contexto.** A SPEC de Conteúdo (`specs/conteudo.md`) estava com Status "em revisão", mas a seção 12 (recorte de implementação) foi preenchida em 2026-10-06, no commit `4d32448`, com as histories e as issues cortadas (#238 a #272). As issues já existem no GitHub, e o índice de docs ainda dizia "ainda em revisão". Pelo `docs/business/module-process.md`, a entrevista de um módulo só abre depois do anterior estar fechado, e "fechado" é a SPEC aprovada; a implementação depende da SPEC aprovada e recortada. Não havia registro escrito da aprovação.

**Decisão.** A SPEC de Conteúdo está aprovada, com o recorte de implementação da seção 12. O Status de `specs/conteudo.md` passa a "aprovado", e o índice de docs deixa de dizer "ainda em revisão". A implementação do módulo pode começar pelas issues da seção 12, respeitando as dependências de cada uma.

**Consequência.** Mudanças de regra na SPEC depois desta data passam pelo mesmo caminho de qualquer SPEC aprovada: a SPEC é corrigida no mesmo PR que diverge dela, e a decisão que muda a regra é registrada em `docs/business/decisions/`. As decisões de 2026-10-01 e 2026-10-07 que já fecham pontos da SPEC continuam valendo.

**Origem.** Maestro (agente de coordenação), a partir do commit `4d32448` (2026-10-06, "preencher o recorte de implementação do módulo Conteúdo"). O maestro informou que o dono mandou implementar o módulo com esse recorte, o que equivale à aprovação da SPEC.

**Validação.** Pendente de validação do dono.
