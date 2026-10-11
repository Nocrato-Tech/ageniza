# O "Voltar ao início" da página não encontrada leva ao início de cada lado

**Data.** 2026-10-10

**Contexto.** A página "não encontrada" aparece também para a pessoa do portal do cliente, e o link de volta apontava sempre para `/`, a página pública provisória. Quem está na agência ou no portal não tem nesse endereço o seu início, e as páginas de sistema (não encontrada, carregando, sessão ausente) estavam em inglês, contra a regra de que as mensagens ao usuário são em português.

**Decisão.**

1. **Dentro de uma área confirmada, o link leva ao início daquela área:** `/agencia/:agenciaId` na agência e `/portal/:clienteId/inicio` no portal. Vale para o endereço desconhecido e para o módulo que a pessoa não pode ver, que continua sendo o mesmo "não encontrado".
2. **Fora de uma área confirmada, o link leva a `/contextos`:** id malformado, 404, resposta de outra agência ou de outro cliente, e o "não encontrado" geral de quem tem sessão. O seletor de contexto entra sozinho quando há um só. O link nunca leva a uma área que o servidor não confirmou, e nunca cruza de um lado para o outro.
3. **Sem sessão, o link segue para `/`,** a página pública.
4. **Os textos são em português:** "Página não encontrada", "Este endereço não corresponde a uma página do Ageniza.", "Voltar ao início", "Carregando…", "Área indisponível", "Esta área exige uma sessão ativa." e o "Pular para o conteúdo" das duas camadas genéricas.

**Alternativa fechada.** Um único link para `/` em todo lado não foi mantido: deixava o cliente do portal numa página que não é a dele.

**Consequência.**

- Só texto e destino de link no web; nenhuma rota, contrato ou migration.
- A página pública `/` continua com o texto provisório em inglês, fora desta decisão.

**Origem.** Issue #402; achado Baixo da revisão da Coruja no PR #401.

**Validação.** Pendente de validação do dono.
