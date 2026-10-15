# O erro de um `Field` é anunciado, e a recusa leva o foco ao campo

**Data.** 2026-10-15

**Contexto.** Os modais Novo cliente e Editar cliente, o roteiro de stories e a conversa do conteúdo mostravam o erro de campo com `FieldMessage role="alert"` montado à mão, sem o ícone que a seção 13.2 do design system pede. Migrá-los para a prop `error` do `Field` entrega o ícone, o `aria-invalid` e o `aria-describedby`, mas o parágrafo de erro do `Field` não tinha `role`: o erro que aparece depois de um envio não era mais anunciado, e um teste do roteiro (#635) exige o `role="alert"` no erro da cena. Um erro lido só por `aria-describedby` chega a quem navega até o campo, não a quem acabou de enviar.

**Decisão.**
1. O parágrafo de erro do `Field` leva `role="alert"`, em todas as telas que o usam.
2. Quando um envio é recusado e o campo recusado está no formulário (nome vazio ou em uso no Novo cliente; campos recusados no Editar cliente), o foco vai ao primeiro campo marcado como inválido, para o leitor de tela ler o erro pela descrição do campo mesmo que o anúncio se perca.
3. Em formulário com mais de um erro, o foco vai ao primeiro campo na ordem do formulário, não na ordem em que a API listou.

**Consequência.** Nenhuma tela perde o anúncio que tinha, e as telas que já usavam o `Field` (login, convite, redefinição, modal do conteúdo, roteiro) passam a anunciar também. A suíte do web inteira confirma que nenhum teste existente dependia de o erro do `Field` ser silencioso. Mensagem de falha do envio inteiro (500, 403, sem rede) continua `FieldMessage role="alert"` fora de qualquer campo.

**Origem.** Parte 2c da varredura final (#639), PR da Âncora.

**Validação.** Pendente de validação do dono.
