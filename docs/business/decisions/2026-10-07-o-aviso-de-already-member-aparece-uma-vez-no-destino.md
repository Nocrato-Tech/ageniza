# O aviso de `already_member` aparece uma vez no destino

**Data.** 2026-10-07

**Contexto.** `specs/auth.md` §7 dizia que `already_member` "não é erro" e levava ao contexto, mas não dizia onde nem como a pessoa sabia que o acesso já existia — e a descrição do PR #178 dizia o contrário. A re-revisão de #177/#178 (#184) deixou o ponto esperando decisão de produto.

**Decisão.** O aceite de um convite por quem já tem o vínculo segue normalmente até o destino do próprio convite (a agência ou o portal). No topo de onde a pessoa cai, um aviso discreto diz: "Você já fazia parte de `<Agência>`. Nada mudou no seu acesso." O aviso aparece **uma vez**: some ao ser fechado ou quando a pessoa navega, e não volta por histórico nem por recarregar — ele viaja no `state` da navegação e é consumido na primeira renderização, nunca na URL, no `localStorage` ou no `sessionStorage`. O convite **não** é consumido no `already_member`: `used_at` continua nulo, como fixa o teste de integração do PR #187 (correção do maestro na #184, 2026-10-07).

**Consequência.** Nenhuma rota, tabela ou formato de resposta muda: o aviso usa o `status: 'already_member'` que `POST /invitations/:token/accept` já devolve e o nome da agência que o preview já carrega. Consumir o convite nesse caso não teria ganho real — o link só serviria a quem já é membro, e mudá-lo exigiria migration sobre `app_private.accept_invitation`.

**Origem.** Issue #184, decidida pelo maestro com autonomia dada pelo dono em 2026-10-07. **Pendente de validação** pelo dono do produto.

