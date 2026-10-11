# As seis ações do conteúdo no modal agem sobre o que está salvo, e o envio incompleto fica parado com a lista do que falta

**Data.** 2026-10-11

**Contexto.** A parte B da #264 põe no modal as seis ações da agência sobre o conteúdo (#256): enviar para aprovação, aprovar pela agência, marcar como publicado, desfazer a publicação, cancelar e reagendar. A SPEC (seções 4 e 7) diz que o botão segue o estado e a permissão, e a issue pede que o formato com mídia incompleta mostre o que falta antes de enviar; não diz o que acontece com uma edição ainda não salva quando a pessoa aperta uma ação, nem se o botão de enviar fica aberto quando a tela já sabe que o envio será recusado. Decisão tomada pela Âncora ao implementar a parte B, para a validação do dono.

**Decisão.**

1. **Cada botão existe só onde a permissão e o estado o permitem** (o par, nunca um dos dois): enviar para aprovação, em produção ou em ajuste, com `conteudo.operar`; aprovar pela agência, aguardando aprovação, com `conteudo.aprovar_pela_agencia`; marcar como publicado, pronto para publicar, e desfazer a publicação, publicado, com `conteudo.publicar`; cancelar, em qualquer estado menos publicado e cancelado, com `conteudo.cancelar`; reagendar, cancelado, com `conteudo.operar`. Cliente arquivado não mostra nenhuma. É UX: a API confere cada ação.
2. **As ações agem sobre o conteúdo como está salvo.** Com mudanças no formulário que ainda não foram salvas, os botões esperam, com o aviso "Salve as mudanças antes de usar estas ações"; assim uma ação nunca sai com uma legenda que ninguém enviou, e a aprovação "fora da plataforma" confirma a revisão que a pessoa leu (`revision`).
3. **O envio incompleto fica parado.** Em produção ou em ajuste, a tela lista o que falta (mídia completa para o formato, mídia confirmada e ainda na pasta, capa ainda na pasta, subtarefas aprovadas) e segura o botão de enviar; sem a lista da pasta (a leitura falhou) a tela só diz o que o próprio conteúdo mostra e deixa a API ter a última palavra, inclusive com `CONTENT_MEDIA_NOT_CONFIRMED`.
4. **Aprovar pela agência, marcar como publicado e reagendar pedem o dado antes:** o motivo (obrigatório; sem ele nada é enviado), o dia real da publicação (hoje em São Paulo, nunca no futuro) e o novo dia. Desfazer a publicação e cancelar saem direto. Qualquer ação que dá certo fecha o modal; qualquer recusa mantém o modal e o que foi digitado, com o texto da própria tela.

**Alternativas fechadas.** Salvar sozinho antes de agir: uma ação com efeito (e-mail ao cliente, aprovação) não pode levar junto uma edição que a pessoa não pediu para gravar. Deixar o botão de enviar aberto e mostrar só o erro da API: a lista do que falta é o que a pessoa precisa para corrigir, e o 409 só diria que algo falta.

**Consequência.**

- Nenhuma rota, tabela, migration ou permissão nova: só a tela, sobre as seis rotas da #256.
- O "Cancelar" do rodapé do modal passou a se chamar "Fechar", para não se confundir com cancelar o conteúdo.
- Desfazer a publicação aparece em todo conteúdo publicado: a regra "só no mesmo dia" é da API (`CONTENT_UNPUBLISH_EXPIRED`), porque o contrato não traz o instante em que se marcou.

**Origem.** Issue #264, parte B; SPEC `specs/conteudo.md`, seções 4 e 7, e regras 5, 7 e 11.

**Validação.** Pendente de validação do dono.
