# Os estados vazios são de três tipos: primeiro uso, boa notícia e falha

**Data.** 2026-11-10

**Contexto.** Hoje um estado vazio pode dizer "nada pendente" quando a consulta falhou ou quando a tela não cobre todos os estados pendentes, e isso engana a agência.

**Decisão.**

1. **Primeiro uso.** Convida à ação: a tela ainda não tem nada e mostra o que fazer primeiro.
2. **Boa notícia.** Nada está esperando: não há pendência.
3. **Falha.** A consulta não respondeu; a tela diz isso e oferece "tentar de novo".
4. **Quando se afirma que não há nada.** Uma tela só afirma que não há nada pendente quando a consulta **respondeu** e a tela **cobre todos os estados pendentes**.

**Consequência.**

- Só a tela muda: nenhuma rota, tabela ou permissão. O critério passa para o checklist de implementação e para o design system.

**Origem.** Pedido do dono do produto em 2026-11-10, depois da pesquisa da Orkestrya e do Refcat (2026-11-09).

**Validação.** Pendente de validação do dono.
