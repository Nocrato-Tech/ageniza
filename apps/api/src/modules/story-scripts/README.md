# Roteiros de stories (#258)

A API dos roteiros de stories de um cliente (`specs/conteudo.md` seções 3, 4 e 6), sobre a tabela, as funções e a
RLS da #248 (`20261007001100_story_scripts.mjs`). Um roteiro é o plano de um dia de stories: uma data, cenas
ordenadas (texto e orientação) e um estado, `rascunho → enviado → gravado`. A agência escreve e envia; o portal lê o
que foi enviado e marca como gravado.

## As rotas

| rota | quem | o que faz |
|---|---|---|
| `POST /agencies/:agencyId/clients/:clientId/story-scripts` | `conteudo.operar` e `conteudo.visualizar` | cria o roteiro em rascunho, com as cenas |
| `PATCH …/story-scripts/:scriptId` | as duas | muda o dia e/ou as cenas; só rascunho |
| `POST …/story-scripts/:scriptId/send` | as duas | rascunho → enviado; repetir não é erro |
| `GET /clients/:clientId/story-scripts?from=&to=` | pessoa ativa do portal | os roteiros enviados e gravados de um período |
| `POST /clients/:clientId/story-scripts/:scriptId/recorded` | pessoa ativa do portal | enviado → gravado; repetir não muda quem gravou |

A escrita da agência exige as **duas** permissões: uma escrita que não lê o que escreveu é cega, e a policy do banco
pede as duas (item 5 da decisão de 2026-10-07 do roteiro no banco). O portal é guardado só pelo vínculo ativo com o
cliente (`requireClientAccess`); o cliente é sempre o que o guarda provou.

## Onde cada regra mora

- **A direção do estado é do banco.** `status`, `recorded_by` e `recorded_at` não são gravados pela API: `send_story_script`
  e `record_story_script` (migration da #248) são o único caminho, e o gatilho `story_scripts_guard_update` só aceita
  `rascunho → enviado` e `enviado → gravado`. A rota só decide o que cada lado fica sabendo.
- **O portal nunca vê rascunho, e a regra está no SQL do lado cliente.** Um colaborador que também tem vínculo com o
  cliente lê rascunho pelo ramo da agência da policy; por isso `loadPortalScript` e `listPortalScripts` filtram
  `status in ('sent', 'recorded')` e `client_id` no próprio SQL, e a rota de gravar só chama a função para um roteiro que
  o portal pode ler. Rascunho, roteiro de outro cliente, de outra agência, id inexistente ou malformado: o mesmo 404
  `Story script not found.`, também para esse colaborador.
- **Quem gravou aparece pelo vínculo.** `recordedBy: { name }` sai de `app_private.story_script_recorder`
  (migration `20261011000500`, do PR de banco da #258), uma função `security definer` de propósito único que lê o nome pela ligação da pessoa com
  o cliente, nos dois lados, porque o portal não lê o vínculo dos outros. Vínculo removido depois continua respondendo.
- **A edição é a lista inteira.** `PATCH` recebe `scenes` na nova ordem: cena com `id` já existe (muda texto,
  orientação e lugar numa só instrução, então duas cenas trocam de lugar), cena sem `id` é nova. Como cena não se remove
  (sem `DELETE`), a lista tem de trazer todas as que o roteiro tem; faltar uma, ou trazer o id de outro roteiro, é 409
  `STORY_SCENES_MISMATCH`. A rota trava o roteiro (`for update`), que é a trava do envio: uma edição e um envio nunca se
  intercalam.

## A consulta por período

`GET /clients/:clientId/story-scripts?from=&to=` segue o formato da consulta por período decidido na #254: `from` e
`to` inclusivos (`AAAA-MM-DD`), no máximo 93 dias (93 passa, 94 dá 400), no máximo 500 itens (acima, 400, sem
truncar), sem paginação, resposta `{ data, meta: { from, to, count } }`. O helper (`storyScriptPeriodIssues` e as duas
constantes) mora em `packages/contracts/src/story-scripts.ts` e é provisório: quando o da #254 entrar, os dois se
unificam numa issue.

## Texto livre

O texto e a orientação da cena recusam caractere de controle (menos tabulação e quebra de linha), separador de linha e
de parágrafo, todo caractere de formato (`Cf`: espaço de largura zero, joiners, controles bidi, BOM, hífen suave) e todo
`Default_Ignorable_Code_Point` que não é `Cf` (seletores de variação, CGJ, preenchimentos de Hangul), mais o espaço em
branco do Braille. A única exceção é o seletor de emoji (U+FE0F) logo depois de um pictograma, que é como o celular
escreve um coração. O banco recusa só o texto em branco; o resto é do schema.

## A corrida com o arquivamento

O banco serializa com o arquivamento só o `INSERT` (gatilho `AFTER INSERT … FOR SHARE` no cliente, `A0020`), não o
`UPDATE`. Por isso:

- **criar** e **acrescentar cena** têm as duas janelas: arquivamento em curso (A0020, 409 na agência) e arquivamento
  já confirmado antes da instrução (42501 da policy, relido como arquivamento: 409);
- **editar** trava o roteiro e só então lê o cliente, e um 42501 depois da leitura é relido do mesmo jeito;
- **enviar** e **gravar** respondem pela função, que confere o cliente depois da própria trava (`A0051`, 409 na agência;
  `A0050`, 404 no portal). Um `UPDATE` que começou antes de o arquivamento confirmar fecha antes dele, sem erro.

O portal nunca aprende que um cliente está arquivado: `A0020` e `A0051` são 404 `Client not found.`.

## Fora do que a SPEC fecha

Pode haver mais de um roteiro por cliente e dia, e um roteiro sem cenas pode ser enviado: a SPEC não decide nenhum dos
dois, o banco não impõe, e a API também não. Os limites de 30 cenas, 2000 caracteres de texto e 1000 de orientação são
da API e estão na decisão de 2026-10-11 sobre este módulo, pendente de validação do dono. Não há listagem da agência:
a agência vê os roteiros do período junto dos conteúdos, na rota da #254.
