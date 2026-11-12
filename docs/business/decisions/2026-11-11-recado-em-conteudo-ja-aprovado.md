# Recado em conteúdo que já foi aprovado: o portal recusa e avisa que o recado não foi enviado

**Data.** 2026-11-11

**Contexto.** A decisão [`2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar`](2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md) deixa a pessoa do portal aprovar com um recado à agência. Aprovar um conteúdo que já está aprovado sempre foi um sucesso silencioso (a segunda pessoa que clica não muda nada). Com o recado, esse silêncio perde dado: duas pessoas do mesmo cliente aprovam quase ao mesmo tempo, a segunda escreve um recado, recebe "aprovado" e a agência nunca lê o que ela escreveu. A revisão de segurança da subtarefa A2 (rodada 1) apontou o caso.

**Decisão.**

1. **Aprovar com recado um conteúdo que já está aprovado é recusado.** A resposta é `409` com o código `CONTENT_ALREADY_APPROVED` e a mensagem "Este conteúdo já foi aprovado. Seu recado não foi enviado." Nada é gravado: nem o recado, nem uma conversa nova. Quem aprovou primeiro e o recado dele ficam como estavam.
2. **Sem recado, nada muda.** Aprovar um conteúdo já aprovado, sem recado, continua sendo o sucesso silencioso de antes (`200`, nenhuma escrita).
3. **Vale para qualquer aprovação anterior**, inclusive a que a agência registrou fora da plataforma.
4. **A mesma pessoa que repete a chamada com o mesmo recado também recebe o `409`.** É consequência da regra, não um caso à parte: o recado que ela mandou da primeira vez já está na conversa, e a resposta diz que este segundo não foi enviado.
5. **Vale de qualquer jeito que as duas chamadas se encontrem**, inclusive quando chegam juntas: a verificação é feita depois de travar o conteúdo, que é onde duas pessoas aprovando no mesmo instante são separadas. Uma verificação antes da trava deixaria o recado de quem perdeu a corrida ser descartado.

**Não muda.** O link de aprovação do e-mail continua sem recado. Pedir ajuste continua exigindo comentário. O limite de 500 caracteres e a recusa de recado vazio ou com caractere invisível são os de antes.

**Consequência.**

- **Migration nova** (`20261111000203_approve_content_refuses_note_on_approved.mjs`), porque a regra mora na função de aprovar, depois da trava. A migration `20261111000202` não é editada. Não há backfill nem mudança de tabela.
- **Risco: Alto**, porque mexe na função do banco que o portal usa para escrever (autorização e dado do cliente).
- A resposta nova entra no catálogo da API e em `docs/mobile/fluxos/portal.md`: o mobile mostra a mensagem e não repete a chamada.

**Origem.** Revisão de segurança da subtarefa A2 do escopo redesign-igual (rodada 1, achado 2) e decisão do maestro de recusar com `409` em vez de descartar o recado.

**Validação.** Validada pelo dono em 2026-11-12.
