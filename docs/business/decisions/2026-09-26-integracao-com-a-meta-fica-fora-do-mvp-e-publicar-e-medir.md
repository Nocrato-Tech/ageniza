# Integração com a Meta fica fora do MVP, e publicar e medir decidem juntos

**Data.** 2026-09-26

**Contexto.** O relatório imaginado para o cliente inclui retenção por conteúdo e resultado de anúncio. Os dois vêm da API da Meta, e o sistema não tem integração com rede social alguma — nem para publicar, embora `product-overview.md` descreva a plataforma como quem publica.

**Decisão.** Métrica externa **fica fora do MVP**. O relatório do MVP é de **dado interno** — entregue, atrasado, o que foi feito no mês — e é decidido quando Conteúdo e Tarefas existirem. Gatilho da integração: **a decisão de publicar pela plataforma**, que exige a mesma conexão.

**Consequência.** Publicar e medir usam a mesma conexão com a conta do cliente — OAuth, revisão de app pela Meta, token por cliente —, e decidi-los separados faria o cliente conectar a conta duas vezes. A aba Relatórios nasce reservada.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

