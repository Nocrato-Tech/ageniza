# Link com `?status=removed` sem permissão cai nos ativos, com aviso
**Data.** 2026-10-07

**Contexto.** A decisão de 2026-10-07 sobre remover e reativar fixou o `403` da API para `?status=removed` sem `colaborador.remover`, `colaborador.alterar_papel` ou posse, mas a SPEC §7 dizia que "sem ele, só `active` é devolvido" — o `403` explícito nunca chegou à SPEC, que foi corrigida neste mesmo PR. Na web, esse `403` caía no mesmo "não encontrado" de um recurso inexistente e derrubava a página inteira: quem recebia um link compartilhado com o filtro não via nem a lista de ativos, que lhe é permitida.

**Decisão.** A tela nunca pede `status=removed` a quem não pode vê-lo: o parâmetro é ignorado nesse caso, a listagem cai no filtro de ativos (o padrão da API) e um aviso diz "Você não tem permissão para ver colaboradores removidos. Mostrando os ativos." O `403` da API continua sendo a barreira; a tela apenas não o provoca, em vez de transformá-lo em "não encontrado" para a página toda.

**Consequência.** Nenhuma rota, tabela, formato de resposta, permissão ou policy muda. O aviso não revela a existência de vínculo removido nenhum — só que o filtro pedido não se aplica —, então a decisão de 2026-09-24 ("sem permissão" não é uma tela) continua valendo: a tela não nega a lista, que é permitida, nem confirma o recurso escondido. A alternativa descartada é o "não encontrado" da página inteira, que reaparece se alguém fizer a tela voltar a pedir o filtro proibido.

**Origem.** Issue #322 (ressalva da revisão do PR #327), decidida pelo maestro. **Pendente de validação** pelo dono do produto.

