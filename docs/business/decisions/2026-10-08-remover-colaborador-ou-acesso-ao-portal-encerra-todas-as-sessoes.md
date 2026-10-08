# Remover colaborador ou acesso ao portal encerra todas as sessões da pessoa

**Data.** 2026-10-08

**Contexto.** A decisão 3 de [2026-10-07](2026-10-07-remover-e-reativar-quem-ve-removidos-o-estado-errado-e-409.md) deixou a sessão de quem é removido viva: a pessoa perdia a agência na requisição seguinte, com o mesmo cookie, e seguia online até a sessão expirar. Na validação da #359 (linha 8) o dono decidiu o contrário: quem é removido deve ser deslogado na hora.

**Decisão.**

1. **Todas as sessões da pessoa terminam, sempre.** A sessão é global (Better Auth) e não existe sessão por agência, então a remoção apaga todas as linhas dela em `auth."session"`, também as de outros dispositivos, e vale mesmo que ela ainda tenha outra agência: ela entra de novo e escolhe a agência. A requisição seguinte com o cookie antigo é `401 UNAUTHENTICATED`.
2. **Dois gatilhos.** `POST /agencies/:agencyId/collaborators/:membershipId/remove` e `POST /agencies/:agencyId/clients/:clientId/members/:membershipId/remove` (acesso ao portal). Nos dois, o `DELETE` roda na transação da remoção: se a remoção é recusada ou desfeita, nenhuma sessão é apagada.
3. **Só a passagem para `removed` encerra sessões.** Remover quem já está removido (`409` no colaborador; resposta sem escrita no portal) e reativar não apagam nem criam sessão. Reativar não muda nada além do que já fazia: a pessoa entra de novo, e a reativação de quem não tem outro vínculo é o que lhe devolve um contexto para entrar (a regra do login que recusa credencial sem contexto continua valendo).
4. **Quem remove não perde a sessão.** O `DELETE` só alcança as sessões da pessoa removida. Para colaborador isso basta, porque a rota recusa remover a si mesmo; o caso do vínculo de portal da própria pessoa que remove tem decisão à parte, [`2026-10-08-quem-remove-o-proprio-acesso-ao-portal-mantem-a-sessao-corrente.md`](2026-10-08-quem-remove-o-proprio-acesso-ao-portal-mantem-a-sessao-corrente.md), pendente de validação.
5. **Sem migration nem mudança de privilégio.** `ageniza_app` já tem `DELETE` em `auth."session"` (usado pelo logout), a tabela não tem RLS e o `cookieCache` do Better Auth está desligado, então o `DELETE` na transação da rota basta: a sessão é lida da linha a cada requisição. Não há função `security definer` nova. A mudança é de comportamento da API, não de banco, e por isso não é estrutural no sentido de `structural-changes.md`.
6. **O web confere a sessão sem depender de requisição.** Na área da agência e no portal, a aba pergunta `GET /auth/session` a cada 45 s (dentro dos 30 a 60 s pedidos) e quando volta ao foco; aba escondida não pergunta. Um `401` leva ao login pelo caminho que já existia (`SessionEndRedirect`, com o endereço guardado para a volta); falha de rede ou `5xx` não é prova de nada e espera a próxima conferência. Sem SSE nem WebSocket.

**Consequência.**

- A pessoa removida da única agência que tinha é deslogada e não consegue entrar até ser reativada (login sem contexto, como já era).
- A latência do deslogar numa aba parada é de até 45 s; numa aba usada, a próxima requisição.
- Uma sessão criada por um login concorrente entre o `DELETE` e o commit sobrevive, mas não alcança a agência nem o cliente removidos: o acesso continua sendo decidido a cada requisição.
- Substitui a decisão 3 de 2026-10-07, que não é editada, e a frase "Remover não encerra a sessão" de `specs/colaboradores.md`, que é reescrita.

**Origem.** Issue #411; validação da #359 (linha 8).

**Validação.** Validada pelo dono em 2026-10-08.
