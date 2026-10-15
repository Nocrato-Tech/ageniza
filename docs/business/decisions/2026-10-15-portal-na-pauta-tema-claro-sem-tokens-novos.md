# O portal do cliente entra na Pauta, no tema claro, celular primeiro e sem tokens novos

**Data.** 2026-10-15

**Contexto.** O épico #621 refez a área da agência na Pauta e deixou o portal de fora até o dono decidir (decisão `2026-10-14-agencia-sempre-escura-portal-e-entrada-sempre-claros`). O dono decidiu o portal em 2026-10-15, com o design system inicial já montado.

**Decisão.**
1. O portal do cliente entra na Pauta, no tema claro e celular primeiro. As regras de `docs/design-system.md` seção 25 valem nele, com o claro no lugar do escuro.
2. O redesign reaproveita `packages/ui` e os tokens de `apps/web/src/styles`: nenhum token, cor, fonte ou componente de base novo. Só as telas são refeitas.
3. O design system melhora com o produto no ar; a falta de uma peça não é motivo para criar uma agora.
4. A cópia do Início desta decisão substitui a dos itens 1 e 4 de `2026-10-11-portal-inicio-aprovacoes-e-roteiro-de-hoje`: "N posts esperando sua aprovação" com o botão "Revisar os N posts" no lugar de "N conteúdos esperando… ver", e "Já gravei" no lugar de "Marcar como gravado". O Início ganha o bloco "Nesta semana", com os conteúdos de segunda a domingo lidos das rotas que já existem. As regras daqueles itens (a ordem da próxima ação, o destino, o botão que espera a resposta) não mudam.
5. Nada de regra de negócio, rota, API ou banco muda: a tela que pede um dado que a API não entrega sai sem o bloco, e a lacuna vira issue de API.

**Consequência.** A casca, o Início, o tour e Relatórios (#686) assentam as classes comuns do portal em `globals.css`, e o post (#687), a lista (#688) e a marca (#689) as reaproveitam. As frases de `docs/design-system.md` que diziam o portal fora da Pauta mudam.

**Origem.** Épico #685, issue #686; decisão do dono de 2026-10-15.

**Validação.** Pendente de validação do dono.
