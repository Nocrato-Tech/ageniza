# Nenhum módulo abre antes de o anterior estar fechado e recortado

**Data.** 2026-09-24

**Contexto.** `module-process.md` descrevia as quatro fases sem dizer que elas são um portão. Com mais desenvolvedores entrando, "a SPEC sai depois" é exatamente como a implementação volta a preceder a decisão.

**Decisão.** A entrevista de um módulo **não abre** enquanto o anterior não estiver **fechado** — SPEC aprovada — e **recortado** — history, tasks, abertos e débitos criados, com a seção 12 da SPEC preenchida com os números das issues. A precisão que o primeiro módulo exigiu: **recortado não significa ter pelo menos uma history**. A SPEC de autorização tem zero, porque convenção não é capacidade entregável; o portão é o recorte existir.

**Consequência.** Cada módulo custa um passo a mais antes do seguinte, e o benefício é que nenhum módulo começa em cima de um anterior cujas pontas ninguém amarrou. A separação entre os três documentos permanece: **ADR** para decisão técnica de consequência longa, **SPEC** para o fechamento do módulo, **decisions.md** para o registro cronológico — um módulo pode gerar um ADR além da SPEC, nunca no lugar dela.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

