# Revisão por onda, com perfil e esforço decididos pelo maestro e pelo revisor

**Data.** 2026-11-10

**Contexto.** A decisão `2026-11-06-um-pr-por-escopo-com-revisao-por-subtarefa` previa uma revisão por subtarefa, com o tipo de revisão fixado pelo nível de risco: no Baixo, o maestro lia o diff, sem revisor separado. No escopo `telas-melhorias`, subtarefas da mesma onda chegavam à revisão em momentos diferentes, e o dono pediu para juntá-las.

**Decisão.**

1. Com mais de um implementador na onda, o maestro espera todos terminarem, junta as subtarefas numa branch da onda (`feat/<escopo>--onda<k>`) e só então a onda vai para revisão: uma revisão por onda, não por subtarefa.
2. Toda onda passa por um revisor de modelo diferente do implementador. Não há mais fluxo separado por Baixo, Médio e Alto: o "maestro lê o diff, sem revisor" do nível Baixo deixa de valer.
3. O nível de risco continua orientando o implementador (testes e mutação). O perfil da revisão (segurança ou código) e o esforço são decididos pelo maestro junto com o revisor, pelo que a onda contém. Onda que toca banco, RLS, autenticação, sessão, autorização, convite, portal, storage, dado pessoal, pagamento ou infraestrutura sensível vai à revisão de segurança.
4. Um achado volta ao implementador da subtarefa dona dele. As correções são juntadas de novo na branch da onda e o mesmo revisor confere as correções e a regressão delas, refazendo os mesmos ataques (`docs/security-review.md`, seção 6), sem revisar a onda inteira de novo, em laço até zerar os achados.

**Consequência.** Substitui em parte a decisão `2026-11-06-um-pr-por-escopo-com-revisao-por-subtarefa`: a revisão por subtarefa e o tipo de revisão fixado pelo nível (itens 3 e 5) deixam de valer. O resto dela continua: um PR por escopo, migration antes da API que a usa e teste local do dono antes do merge. A revisão de segurança exigida pelo `AGENTS.md` passa a ser a revisão das ondas que tocam essas áreas, publicada no PR único.

**Origem.** Pedido do dono em sessão, em 2026-11-10: "se tiver mais de um implementando, espera todos terminarem, juntar tudo em 1 so e ai vai para 'em revisao'; nao precisa separar em baixo, medio, alto o fluxo, quem decide o nivel da revisão é o maestro + revisor".

**Validação.** Validada pelo dono em 2026-11-10.
