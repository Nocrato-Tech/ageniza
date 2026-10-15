# O erro de um `Field` não é alerta: um resumo único e o foco no primeiro campo inválido

**Data.** 2026-10-15

**Contexto.** Os modais Novo cliente e Editar cliente, o roteiro de stories e a conversa do conteúdo mostravam o erro de campo com `FieldMessage role="alert"` montado à mão, sem o ícone que a seção 13.2 do design system pede. Migrá-los para a prop `error` do `Field` entrega o ícone, o `aria-invalid` e o `aria-describedby`, mas o parágrafo de erro do `Field` não tem `role`. A primeira proposta (PR #677) pôs `role="alert"` no erro do `Field`, para ele continuar anunciado. A revisão do PR mostrou o custo: com vários campos inválidos há um alerta por campo (login com e-mail e senha vazios, 2; roteiro, 3 só na primeira cena e 2N+1 com N cenas), os leitores de tela enfileiram ou perdem parte, o alerta não diz de que campo é, e onde o foco já vai ao campo o erro seria lido duas vezes. `aria-live="polite"` só adia o problema.

**Decisão.** O dono escolheu o padrão do resumo de erros do GOV.UK:
1. O erro de um `Field` é lido pela descrição do campo (`aria-describedby` com `aria-invalid`), que é o que o WCAG 3.3.1 pede. O parágrafo de erro do `Field` não leva `role`.
2. Quando um envio é recusado, a tela leva o foco ao primeiro campo inválido, na ordem do formulário (não na ordem em que a API listou). Vale também quando a recusa vem depois, da resposta do servidor. Digitar desarma o foco, para um campo que fica inválido sob as mãos de quem digita (a confirmação de senha, um contador acima do limite) não roubar o foco.
3. Quando mais de um campo está inválido, o formulário mostra um único resumo com `role="alert"`, acima dos campos, que diz quantos e quais: "Corrija 3 campos: Dia dos stories, Texto da cena 1, Orientação da cena 1." Com um campo só o foco basta, e não há alerta. O resumo segue o que ainda está inválido e some quando sobra um.
4. A implementação é única, em `packages/ui`: `useFormErrors` (liga o formulário, o foco e o resumo), `focusFirstInvalid`, `invalidControls` e o componente `ErrorSummary`. Um botão que valida por conta própria, sem enviar o formulário (o "Enviar ao cliente" do roteiro), chama `attempted()`.

**Consequência.** Uma recusa tem no máximo um alerta por formulário, e o campo recusado continua descrito e marcado. O padrão entra primeiro no Novo e Editar cliente, no roteiro de stories e na caixa de resposta da conversa (PR #677); as demais telas que mostram o erro pelo `Field` (login, convite, redefinição e esqueci a senha, troca de e-mail, convite e reativação de colaborador, convite ao portal, estudo de marca e os modais de persona) o adotam no PR seguinte da mesma varredura. Ficam de fora, e seguem com o `FieldMessage role="alert"` que já tinham, as telas que não passam pelo `Field` (o modal do conteúdo e a mídia dele, as pastas de mídia, o detalhe do colaborador, o encerramento do cliente, as subtarefas e o pedido de ajuste do portal): trocá-las para o `Field` é a migração própria delas, e o resumo entra junto.

**Origem.** Revisão do PR #677 (parte 2c da varredura final, #639) e decisão do dono.

**Validação.** Validada pelo dono em 2026-10-15.
