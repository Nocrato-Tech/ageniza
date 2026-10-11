# A remoção de mídia diz se foi ela que removeu, e a auditoria sai dessa resposta

**Data.** 2026-10-11

**Contexto.** A decisão de 2026-10-07 sobre a biblioteca de mídia (item 6) diz que repetir a remoção não é erro nem um segundo evento `media.removed`. A rota decidia isso lendo `removed_at` **antes** da trava que `app_private.remove_media_asset` toma na mídia (`for update`). Duas remoções no mesmo instante liam "não removida", a segunda esperava a trava, encontrava a mídia já removida, voltava sem erro e as duas gravavam o evento: um duplo clique bastava (revisão do #406, bloqueante 1).

**Decisão.**
1. `app_private.remove_media_asset` passa a devolver `boolean`: `true` quando **esta chamada** gravou `removed_at`, `false` quando a mídia já estava removida, visto depois da trava. Só a função sabe, depois da trava, qual das chamadas mudou a linha.
2. A rota grava `media.removed` só quando a resposta é `true`. Ela não lê mais `removed_at` antes da chamada.
3. A migration `20261011000200` recria a função com o mesmo corpo, o mesmo `search_path` fixo, os mesmos grants e os mesmos códigos (`A0080`, `A0081`, `A0082`); só o tipo de retorno e os dois `return` mudam. A `20261007001500` já foi aplicada e não se edita.

**Consequência.**
- Quem chamar a função e ignorar o retorno continua funcionando; quem precisar auditar usa o retorno.
- Foi descartado ler `removed_at` depois da chamada e comparar com o `now()` da transação: funciona, mas depende de um detalhe do carimbo e não diz o que a função fez.

**Origem.** Revisão da Lupa no PR #406 (issue #253).

**Validação.** Pendente de validação do dono.
