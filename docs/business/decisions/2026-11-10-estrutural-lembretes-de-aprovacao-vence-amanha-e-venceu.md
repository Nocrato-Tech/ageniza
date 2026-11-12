# ESTRUTURAL: dois lembretes de aprovação, "vence amanhã" e "venceu", uma vez por rodada

**Data.** 2026-11-10

**Contexto.** Com o prazo da rodada de aprovação (decisão [`2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado`](2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado.md)), o cliente que não responde precisa ser lembrado sem que a agência tenha de cobrar à mão.

**Decisão.**

1. **Dois e-mails novos.** "Vence amanhã", enviado na véspera do prazo, e "venceu", enviado no dia seguinte ao prazo.
2. **Uma vez por rodada.** Cada um sai no máximo uma vez por rodada.
3. **Para quem.** Só para as pessoas ativas do portal daquele cliente, e só para o conteúdo que **ainda aguarda decisão**.
4. **Quando não sai.** Não sai nada para cliente arquivado, agência suspensa ou agência em somente leitura. Não sai "vence amanhã" se o envio foi feito na própria véspera do prazo.
5. **Quando roda.** Uma vez por dia, de manhã, no horário de São Paulo.

**Consequência.**

- É estrutural porque acrescenta dois tipos à fila de e-mail e um trabalho agendado sem requisição, que segue a forma já decidida para esse caso: o worker não contorna a RLS e o efeito que não pode deixar de acontecer passa por uma função de escopo único, auditada (ver [`structural-changes.md`](../structural-changes.md), "Trabalho agendado sem requisição").
- O e-mail de lembrete mostra o prazo e o recado da rodada, assinados pela agência.
- Pede revisão de segurança independente, por tocar o banco, o envio de e-mail e dado pessoal.

**Origem.** Pedido do dono do produto em 2026-11-10, depois da pesquisa da Orkestrya e do Refcat (2026-11-09).

**Validação.** Validada pelo dono em 2026-11-12.
