# Quem remove o próprio acesso ao portal mantém a sessão corrente

**Data.** 2026-10-08

**Contexto.** A decisão de [encerrar todas as sessões na remoção](2026-10-08-remover-colaborador-ou-acesso-ao-portal-encerra-todas-as-sessoes.md) diz que quem remove não perde a própria sessão. Para colaborador o caso não existe: a rota recusa remover a si mesmo. No portal existe: uma pessoa da agência com `cliente.remover_usuario` pode também ser pessoa do portal do mesmo cliente e remover o próprio vínculo. A resposta do dono não cobre esse caso, e a implementação precisou escolher.

**Decisão.**

1. **Quem remove o próprio vínculo de portal mantém a sessão da requisição e perde as outras.** O `DELETE` de `auth."session"` exclui `request.auth.sessionId`; as sessões do mesmo usuário em outros dispositivos terminam.
2. **A alternativa descartada** é encerrar também a sessão corrente: a pessoa seria deslogada no meio de uma ação de administração que acabou de concluir, na agência onde continua com acesso.
3. **Não vale para outra pessoa.** O filtro só tem efeito quando o alvo é quem chama; ele não protege a sessão de ninguém mais.

**Consequência.** Se o dono preferir que a remoção do próprio acesso também derrube a sessão corrente, é tirar a exclusão da sessão corrente do `DELETE` (`revokeUserSessions`) e inverter um teste (`does not end the session of whoever removes, not even when they remove their own portal link`); sem migration.

**Origem.** Issue #411; revisão de segurança do PR #417 (pergunta 6 e achado 3).

**Validação.** Pendente de validação do dono.
