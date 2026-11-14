# A Ajuda é um menu com "Rever o tour" e o status do sistema, e "Avisar o suporte" só existe com um contato configurado

**Data.** 2026-11-11

**Contexto.** O quadro do redesenho (r0) tem um ícone de Ajuda na barra superior e, no estado de falha, a ação "Avisar o suporte" com "Código 503 · 11 nov, 10h42". Hoje "Rever o tour" mora no menu de conta, e não existe central de ajuda. A decisão [`2026-10-14-navegacao-da-agencia-sem-ajustes-ate-existir-a-tela`](2026-10-14-navegacao-da-agencia-sem-ajustes-ate-existir-a-tela.md) e o design system (seção 23) proíbem controle sem destino.

**Decisão.**

1. **Ajuda é um menu pequeno.** O ícone de Ajuda abre um menu com duas ações: **Rever o tour** e **Status do sistema** (a página pública `/status`). Não há central de ajuda, artigos nem chat.
2. **"Rever o tour" sai do menu de conta** e fica só na Ajuda, na agência e no portal.
3. **"Avisar o suporte" é um e-mail.** Na falha de uma consulta, a ação abre o e-mail do suporte (`mailto:`) com o código do erro e o horário no corpo, para quem já sabe o que houve. O endereço é o contato de suporte que o servidor já devolve (`plan.supportContactEmail`). **Sem contato configurado, a ação não aparece**, e a falha mostra só "Tentar de novo": nunca um botão sem destino.
4. **O código da falha** ("Código 503 · 11 nov, 10h42") é o status HTTP e o horário de São Paulo; nada mais do erro, nenhum corpo de resposta e nenhum dado pessoal.

**Substitui.**

- O trecho de `specs/auth.md` (seção 7, "Menu de conta") que lista "Rever o tour" no menu de conta e o trecho de `specs/clientes.md` ("Portal — navegação") que diz "menu de conta: trocar de cliente, rever o tour, sair": o tour passa à Ajuda.

**Consequência.**

- Só a tela muda: nenhuma rota, tabela ou permissão. O contato de suporte já existe na configuração.
- O fluxo mobile da agência e o do portal descrevem a Ajuda.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro sobre o destino da Ajuda e de "Avisar o suporte" (risco 17 do inventário).

**Validação.** Validada pelo dono em 2026-11-12.
