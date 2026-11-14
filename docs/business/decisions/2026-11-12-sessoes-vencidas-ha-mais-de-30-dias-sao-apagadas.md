# Sessão vencida há mais de 30 dias é apagada, com o IP, o agente do navegador e a cidade

**Data.** 2026-11-12

**Contexto.** A sessão guarda o IP, o agente do navegador e, desde a lista de sessões ativas (#893), a cidade de quem entrou. A sessão encerrada de propósito (sair, sair de todas, "sair das outras", redefinição de senha, remoção de acesso) já some do banco na hora. Mas a que só **venceu** fica: o Better Auth a apaga quando alguém usa aquele cookie de novo, e quem abandonou o aparelho nunca volta. O mesmo vale para a sessão que a troca da credencial da conta (redefinição, entrada com o Google) deixou para trás sem apagar. Sem limpeza, esses dados pessoais ficam no banco para sempre, de uma sessão que já não abre nada.

**Decisão.**

1. **O que é "vencida".** A sessão que já não vale: a que passou do `expiresAt` (7 dias sem uso, ou o teto de 30 dias desde a criação), ou a feita antes da última troca da credencial da conta. A sessão **ativa** nunca entra, nem a que vence dentro dos 30 dias.
2. **De quando contam os 30 dias.** Do momento em que a sessão deixou de valer: o `expiresAt`, ou a troca da credencial, o que vier primeiro. Passados **mais de 30 dias** disso (30 dias e 1 segundo), a sessão sai; com exatamente 30 dias, ainda não.
3. **O que acontece.** **A linha inteira é apagada**, com o IP, o agente do navegador e a cidade. Não se limpam só esses campos: uma sessão vencida não serve para mais nada (não é mostrada, não autentica, a lista só lê as ativas), então não há por que guardar a linha, e apagar é mais simples do que manter uma linha vazia.
4. **Quando roda.** Uma vez por dia, de madrugada, e uma vez a cada início do worker, em lotes, sem travar a tabela nem as sessões em uso.
5. **A auditoria.** Não muda: `audit.events` nunca guardou IP, agente do navegador nem cidade (só identificadores), e a limpeza não grava evento nenhum, porque nada de negócio aconteceu.

**Consequência.**

- Nenhuma sessão morta guarda dado pessoal por mais de 30 dias. Quem perde a conta de uma sessão antiga não perde nada que a tela mostrasse (a lista já só mostra as ativas).
- **Não é estrutural:** não altera tabela, nem resposta, nem RLS, nem a avaliação de autorização; é uma função nova do banco que só o worker chama e um job agendado.
- **Risco: Alto** (sessão e dado pessoal): revisão de segurança independente. A limpeza nunca toca uma sessão ativa, e uma sessão renovada durante a limpeza não é apagada.
- Substitui o silêncio da SPEC sobre o que acontece com a sessão que vence (`specs/auth.md`, seções 4 e 14).

**Origem.** Resposta do dono do produto em 2026-11-12: "Limpeza das sessões vencidas há mais de 30 dias (IP, UA e cidade)".

**Validação.** Validada pelo dono em 2026-11-12.
