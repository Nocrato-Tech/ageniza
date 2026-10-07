# Biblioteca de mídia do cliente: o que a API decide onde a SPEC não fecha

**Data.** 2026-10-07

**Contexto.** A #253 abre as rotas de pasta e de mídia do cliente (`specs/conteudo.md` §6) sobre as funções da migration `20261007001500` ([`2026-10-07-remover-midia-e-por-funcao-e-se-recusa-em-conteudo-ja-enviado.md`](2026-10-07-remover-midia-e-por-funcao-e-se-recusa-em-conteudo-ja-enviado.md), [`2026-10-07-a-cota-soma-a-agencia-inteira-por-funcao-propria.md`](2026-10-07-a-cota-soma-a-agencia-inteira-por-funcao-propria.md), [`2026-10-07-a-pasta-pai-se-trava-por-funcao-propria.md`](2026-10-07-a-pasta-pai-se-trava-por-funcao-propria.md)). A SPEC dá as rotas e as permissões, mas não fecha o formato do nome, quem completa um envio, nem o que a resposta de cada rota carrega.

**Decisão.**
1. **As escritas exigem `conteudo.operar` e `conteudo.visualizar`**: criar pasta, remover mídia e enviar mídia de cliente. A SPEC pede só `operar`, mas um papel com `operar` sozinho escreveria o que não consegue ler (a pasta criada, a mídia inserida que não enxerga, não trava nem conclui, e cujo envio pendente reserva cota). Papel de uma permissão só recebe 403.
2. **O envio de mídia aceita `conteudo.operar` além de `midia.enviar`**: sem `clientId` e `folderId` continua `midia.enviar`; com os dois, as duas permissões de Conteúdo. `parts` e `complete` aceitam as duas famílias e a RLS decide o que cada papel enxerga, porque Produção tem `conteudo.*` e não tem `midia.enviar`, e sem isso não concluiria o envio que começou. Cliente e pasta chegam juntos ou nenhum; o servidor confere que o cliente é da agência e que a pasta é do cliente (outro cliente, outra agência, pasta inexistente: o mesmo 404), e cliente arquivado dá 409 `CLIENT_ARCHIVED`.
3. **Nome de pasta:** até 80 caracteres e 256 bytes (o `CHECK` do banco mede bytes), sem caractere de controle, invisível nem os dois joiners (U+200C e U+200D), com ao menos uma letra ou número. **Nome repetido é aceito**: a SPEC não o proíbe e o banco só impede repetição entre pastas padrão.
4. **Pasta dentro de pasta:** `parentId` precisa ser pasta de primeiro nível do mesmo cliente; de outro cliente ou inexistente é 404, e pasta de trabalho como pai é 400.
5. **Listagens no contrato paginado:** pastas, cem por página (o teto, porque a tela precisa da árvore inteira); mídias, quarenta e oito por página, a mais recente primeiro, só a confirmada e não removida, sem chave de objeto.
6. **Remover devolve 200 com `{ assetId, removed: true }`** e repetir a chamada não é erro nem um segundo evento de auditoria (`media.removed`). A mídia em uso responde 409 `MEDIA_IN_USE`.

**Consequência.**
- Não está nesta entrega a URL de leitura (`download-url`) para quem só tem `conteudo.visualizar`: ela segue `midia.enviar`. A tela da biblioteca (#267) precisa dela para mostrar miniaturas e é o próximo ajuste da API.
- Mudar o item 1 para só `operar` é trocar a guarda e a função de remoção; o item 3 é um schema.

**Origem.** Issue #253, decidido na implementação.

**Validação.** Pendente de validação do dono.
