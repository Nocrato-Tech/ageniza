# O esboço da SPEC é briefing de designer, e task de interface espera a tela

**Data.** 2026-09-24

**Contexto.** O processo dizia que o bloco de UX produz esboço de baixa fidelidade, sem dizer para quem. Sem isso, "esboço" poderia ser lido como permissão para codificar a tela direto a partir dele — que é como a interface passa a ser desenhada por quem está implementando.

**Decisão.** O bloco de UX da SPEC é o **briefing do designer**. A sequência é **esboço → design → código**: o esboço descreve o que a tela precisa resolver, o designer entrega a tela, e só então ela é codificada.

As **tasks de `escopo:web` são escritas junto com as demais**, a partir do esboço e das decisões da SPEC, e recebem o rótulo `aguardando-design` até a entrega. Isso não bloqueia o resto: `escopo:api` e `escopo:db` seguem em paralelo, porque o contrato que elas implementam já está fechado na SPEC.

**Consequência.** A entrega do designer entra no caminho crítico de toda tela, e é um prazo que não depende de nós. Em troca, o trabalho de interface fica descrito e priorizado antes de existir tela — quem receber o design já encontra a issue pronta, com aceite e dependências. Ninguém codifica tela a partir do wireframe.

**Origem.** Decidido em sessão. **Substituída em 2026-09-28** quanto à ordem esboço → design → código e ao rótulo `aguardando-design`: a tela passa a ser codificada a partir do esboço e refinada depois pelo designer (ver a entrada de 2026-09-28, ao fim). O esboço em nível de wireframe, as tasks de web escritas junto com as demais e `escopo:api` e `escopo:db` em paralelo continuam valendo.

