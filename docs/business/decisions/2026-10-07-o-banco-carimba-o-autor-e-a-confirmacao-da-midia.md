# O banco carimba o autor e a confirmação da mídia, e o vídeo só anda para a frente

**Data.** 2026-10-07

**Contexto.** A revisão do PR #369 (#295) deixou três pendências Baixas em `media_assets`, abertas como a issue #371 e adiantadas para antes da #247, que passa a ler a mídia pelo cliente e pelo conteúdo ("enviado por"). Com `midia.enviar` e SQL como `ageniza_app`: (1) `created_by_user_id` era escolhido no `INSERT`, provado com a dona da agência B como autora de uma mídia da agência A; (2) `confirmed_at` era escolhido na transição legítima (`1999-01-01`); (3) `video_processing_status` ia de `pending` direto a `ready`, e as colunas de resultado do vídeo e `multipart_upload_id` podiam ser reescritas sem mudar `status`, inclusive em upload rejeitado ou confirmado.

**Decisão.**
1. **Autor.** `created_by_user_id` sai do grant de `INSERT` e passa a ter `default app_private.current_user_id()`, o ator vinculado na transação por `bind_actor`. Pedir um autor, até o próprio, dá 42501 por privilégio; a rota de upload deixa de enviar o valor.
2. **Confirmação.** `confirmed_at` sai do grant de `UPDATE`, e o trigger de direção grava `now()` na transição `pending` → `confirmed`. A rota deixa de enviar o valor.
3. **Direção do vídeo**, no mesmo trigger (`security invoker`, só para `current_user = 'ageniza_app'`, lendo `OLD` depois do lock): `pending` ou `not_applicable` → `processing` → `ready` ou `failed`, com o retorno `processing` → `pending` do retry. Sair de `not_applicable` para `pending` só na própria confirmação do upload, e qualquer outra mudança só com o upload já `confirmed`. `ready` carrega miniatura, prévia, duração, os dois tamanhos e a hora, sem erro; `failed` carrega o motivo e a hora e não muda resultado; `pending` e `processing` não carregam resultado, erro nem hora. `ready` e `failed` são finais. Sem mudança de estado, nenhuma coluna de resultado muda.
4. **Multipart.** `multipart_upload_id` é gravado uma vez, enquanto o upload está `pending`, e nunca mais é trocado nem limpo.

**Alternativas descartadas.** Igualdade `created_by_user_id = current_user_id()` na `WITH CHECK` do `INSERT`: deixaria o chamador escolher e o banco só conferir. Trigger que sobrescreve em silêncio o valor mandado: esconde o erro do chamador. `pending` → `ready` direto, aceito pelo fluxo de teste da #295: é exatamente o ataque, e o worker sempre passa por `processing`.

**Limite.** Herda o da decisão do estado do envio de mídia (`2026-10-07-estado-do-envio-de-midia-so-anda-para-frente.md`): a API e o worker conectam como `ageniza_app` em nome da pessoa, então o banco garante a forma e a direção, não a prova de que o vídeo foi processado. Quem tem `midia.enviar` e executa SQL ainda leva um vídeo confirmado por `processing` a `ready`, com chaves que o `CHECK` de forma prende a `agency_id/id`.

**Consequência.** Testes da #295 que gravavam `confirmed_at` ou `created_by_user_id` passam a esperar `permission denied`, e o fluxo de vídeo de `media-upload-state.integration.test.ts` passa por `processing` antes de `ready` (o teste anterior usava o atalho que esta decisão fecha); o catálogo de colunas do teste ganhou `client_id` e `folder_id` (#247) e perdeu `created_by_user_id` e `confirmed_at`. Não é estrutural pelos critérios de `structural-changes.md`, e o gate de CI o trata como estrutural por conter `revoke` e `drop policy`.

**Origem.** Issue #371 e os achados do PR #369, decididos na implementação a pedido do maestro.

**Validação.** Pendente de validação do dono.
