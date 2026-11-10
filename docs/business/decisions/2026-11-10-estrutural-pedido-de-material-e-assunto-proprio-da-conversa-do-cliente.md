# ESTRUTURAL: o pedido de material é um assunto próprio da conversa, no nível do cliente

**Data.** 2026-11-10

**Contexto.** A agência precisa pedir material ao cliente (por exemplo, "envie 3 fotos da equipe") e acompanhar se ele respondeu. Hoje a conversa com o cliente sempre tem um assunto: seção da marca, persona ou conteúdo. A decisão [`2026-11-07-comentarios-da-agencia-durante-producao`](2026-11-07-comentarios-da-agencia-durante-producao.md) manteve o portal sem acesso à conversa de um conteúdo em produção, e um pedido de material dentro dessa conversa a quebraria.

**Decisão.**

1. **Pedido de material.** A agência pode abrir um pedido ao cliente, com **prazo opcional**.
2. **Assunto próprio.** O pedido é um assunto novo de conversa, **no nível do cliente**, e **não fica dentro da conversa de um conteúdo**. Assim a decisão de 2026-11-07 continua valendo: o portal não vê a conversa de conteúdo em produção.
3. **Quem faz o quê.** Só a agência abre o pedido. O cliente responde por comentário. A agência resolve, e o pedido sai do Início do portal.

**Consequência.**

- É estrutural porque **altera uma tabela que já existe** (a conversa por cliente ganha um assunto novo e o prazo), acrescenta o lado da agência como regra do banco e mexe na RLS da conversa, que o portal passa a ler para os pedidos abertos. Segue a decisão de que a conversa do cliente tem uma só tabela, com o assunto em colunas tipadas (ver [`structural-changes.md`](../structural-changes.md), "Conversa com o cliente").
- O Início do portal mostra os pedidos abertos.
- Pede revisão de segurança independente, por tocar o banco, a RLS, a autorização e o portal.

**Origem.** Pedido do dono do produto em 2026-11-10, depois da pesquisa da Orkestrya e do Refcat (2026-11-09).

**Validação.** Pendente de validação do dono.
