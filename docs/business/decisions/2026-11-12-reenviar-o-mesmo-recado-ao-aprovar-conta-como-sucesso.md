# Reenviar o mesmo recado ao aprovar conta como sucesso

**Data.** 2026-11-12

**Contexto.** A decisão [`2026-11-11-recado-em-conteudo-ja-aprovado`](2026-11-11-recado-em-conteudo-ja-aprovado.md) recusa com `409 CONTENT_ALREADY_APPROVED` todo recado em conteúdo que já está aprovado, inclusive o da própria pessoa que aprovou (item 4). Na prática isso pune o clique duplo e a nova tentativa depois de a rede cair: a primeira requisição aprovou e gravou o recado, a segunda é idêntica, e a pessoa vê um erro depois de ter aprovado.

**Decisão.**

1. **Reenviar a mesma requisição é sucesso.** Se o conteúdo já está aprovado **pela mesma pessoa** e o recado reenviado é **idêntico**, letra por letra, ao comentário que a aprovação gravou, a resposta é a da aprovação normal (`200`, o conteúdo). Nada é gravado: nem um segundo comentário, nem uma segunda notificação, nem mudança no conteúdo.
2. **Qualquer diferença continua com o erro de hoje** (`409 CONTENT_ALREADY_APPROVED`): outra pessoa, outro recado (até no espaço ao fim), outra `revision` da que o conteúdo tem agora, ou uma aprovação que não gravou recado (inclusive a da agência fora da plataforma). Um comentário igual escrito depois, pela mesma pessoa ou por outra, não conta: só vale o comentário da própria aprovação. Em outro estado (em ajuste, aguardando) a resposta é a de sempre.
3. **Vale de qualquer jeito que as chamadas se encontrem**, inclusive duas juntas: a verificação é feita depois da trava do conteúdo.

**Não muda.** Aprovar sem recado um conteúdo já aprovado segue sucesso silencioso. O link de aprovação do e-mail não leva recado e não ganha esta regra: ela vale só para o portal com login.

**Substitui.** O item 4 da decisão `2026-11-11-recado-em-conteudo-ja-aprovado` (a mesma pessoa repetindo o mesmo recado recebia `409`). Os demais itens ficam.

**Consequência.**

- A função de aprovar do banco ganha uma migration nova (`20261113000600_approve_content_resend_same_note.mjs`): só o desfecho do caso "aprovado, com recado" muda. Nenhuma coluna, policy ou grant muda; sem backfill.
- A resposta nova entra na SPEC, no catálogo da API e em `docs/mobile/fluxos/portal.md`: o mobile pode reenviar a mesma requisição sem tratar o erro.

**Origem.** Decisão do dono do produto em 2026-11-12: "um recado reenviado idêntico num conteúdo já aprovado conta como sucesso".

**Validação.** Validada pelo dono em 2026-11-12.
