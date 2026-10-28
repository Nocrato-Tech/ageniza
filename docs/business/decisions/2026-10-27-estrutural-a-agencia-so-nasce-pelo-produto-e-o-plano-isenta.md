# ESTRUTURAL: a agência só nasce pelo produto, o plano `isenta` e o aviso do somente leitura

**Data.** 2026-10-27

**Contexto.** Depois da decisão de 2026-10-26 ([a agência nasce pelo produto, em trial de 14 dias](2026-10-26-estrutural-a-agencia-nasce-pelo-produto-em-trial-de-14-dias.md)), havia dois caminhos para uma agência nascer: "Criar agência", em trial, e o comando interno `create` da operação (decisão de 2026-09-15, [entrada de agências apenas por comando interno](2026-09-15-entrada-de-agencias-apenas-por-comando-interno.md)), que a criava `ativo` e mandava o convite de ativação. O upgrade também eram dois comandos, `upgrade` e `new-trial`. Ficavam em aberto o contato do aviso de trial vencido, que ainda não tem canal, e como as ações bloqueadas aparecem na tela.

**Decisão.** O dono decidiu:

1. **A agência só nasce pelo produto**, por "Criar agência", em trial. O comando interno de criar agência deixa de existir.
2. **O plano é um atributo da agência**: `trial` é a que está no período de teste; `isenta` é a que não paga e usa tudo completo, sem limite nem somente leitura (a nossa, pelo backfill); `ativo` é a que fez upgrade. A aplicação nunca altera o plano.
3. **A única operação interna sobre o plano é trocá-lo** numa agência que já existe, para `isenta`, `ativo` ou `trial` (este com a nova data de fim), num só comando. A troca roda só com o papel dono do banco e fica auditada. Ela junta o que eram o upgrade e o trial novo. Ficam os outros comandos sobre uma agência existente (suspender, reativar, reenviar a ativação pendente e ajustar o limite diário de e-mails).
4. **O contato do aviso de trial vencido é configurável** pela variável `SUPPORT_CONTACT_EMAIL`, um e-mail público, sem segredo, que a API serve com o plano. Sem ela, o aviso não mostra contato nenhum: só diz que o trial acabou e que os dados estão guardados.
5. **No somente leitura, as ações de escrita não somem**: aparecem desabilitadas, com um aviso curto no foco e no hover, acessível por teclado, dizendo que o plano precisa ser renovado para usar a opção. No topo da agência fica um banner fixo: "O seu plano precisa ser renovado para usar as opções bloqueadas. Os seus dados estão guardados.", com o contato do item 4 quando houver. As ações que reduzem acesso (remover colaborador, remover acesso ao portal e cancelar convite) continuam habilitadas. No portal do cliente de uma agência em somente leitura, aprovar, pedir ajuste e comentar aparecem desabilitados com o mesmo motivo.

**Consequência.** Estrutural. O CLI da operação perde `create`, `upgrade` e `new-trial` e ganha `set-plan` (e `set-email-limit`, da decisão de 2026-10-27 sobre o somente leitura). A semente de demonstração e os testes criam agências direto no banco, como dono, e elas nascem `isenta`. As agências criadas antes pelo comando continuam como estão, e a ativação pendente delas ainda pode ser reenviada. Substitui a decisão de 2026-09-15 e, em parte, a de 2026-10-26 (o comando interno de upgrade do item 5 e a frase "`pnpm cli:agency` continua existindo"). Pede revisão de segurança independente.

**Origem.** Itens 1 a 4: pedido do dono do produto em sessão, 2026-10-27, trazido pelo maestro: "podemos remover essa questão de comando interno... ter um atributo em específico que faça com que a agência não precise pagar nada, e usar o completo (no caso a nossa)". O comando único de troca de plano e o contato por variável de ambiente foram propostos pelo maestro. Item 5: escolha do dono, 2026-10-27: "desabilitado, e com um aviso de que o plano precisa ser renovado para usar as opções bloqueadas, um banner no topo por exemplo".

**Validação.** Pendente de validação do dono.
