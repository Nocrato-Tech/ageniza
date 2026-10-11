# Mídia removida sai do armazenamento 30 dias depois, e a linha fica com um carimbo de purga

**Data.** 2026-10-11

**Contexto.** A SPEC de Conteúdo diz que a remoção de uma mídia é lógica (`removed_at`) e que "o arquivo sai pelo fluxo de retenção" (§3 e §8). A decisão de 2026-10-07 sobre a cota ([`2026-10-07-a-cota-soma-a-agencia-inteira-por-funcao-propria.md`](2026-10-07-a-cota-soma-a-agencia-inteira-por-funcao-propria.md), ponto 3) manteve a mídia removida na soma "até o fluxo de retenção apagar o arquivo". Esse fluxo nunca foi escrito: nenhum job, função ou rota apaga o objeto, o arquivo removido fica no bucket para sempre e a cota da agência só cresce (issue #607, achada na auditoria de fechamento do módulo). `specs/autorizacao.md` ("Retenção e LGPD") só diz que a purga física vive num fluxo separado, sem prazo.

**Decisão.**
1. **O prazo é de 30 dias depois do `removed_at`.** Passado o prazo, a mídia entra na fila de purga. Antes, não: uma mídia removida há 29 dias e 23 horas fica como está.
2. **O que sai e o que fica.** Saem do armazenamento o objeto original, a chave de envio (`staging`, se ainda existir), a miniatura e o preview de um vídeo (o quadro). A **linha de `media_assets` fica**, para a auditoria, com a chave dos arquivos como estava, e ganha um carimbo `purged_at`. Nada apaga linha.
3. **A cota.** A mídia **purgada** deixa de contar na soma (bytes e objetos), porque o arquivo saiu. A mídia **só removida** continua contando, como na decisão de 2026-10-07. Quem remove muita mídia recupera a cota quando o arquivo sai, trinta dias depois, e não antes.
4. **Nunca toca mídia em uso.** Não se purga mídia usada, como arquivo ou como capa, por conteúdo aguardando aprovação, aprovado ou publicado (regra 12 da SPEC). A remoção já recusa esses casos; a purga pergunta de novo, dentro do banco, sob a trava do conteúdo, porque o arquivo de um post que o cliente está olhando nunca é o que um relógio apaga. Mídia de conteúdo em produção, em ajuste ou cancelado não segura a purga: o conteúdo não segue com um arquivo removido.
5. **Quem faz.** Um job do worker (o PR seguinte da #607), por funções próprias do banco, `security definer` e de escopo único: uma lista o que está vencido e sem uso, com as chaves a apagar; a outra carimba `purged_at` e grava `media.purged` na auditoria. As duas só atendem o worker (recusam quem tem usuário ligado na transação, 42501), e o worker apaga os objetos **antes** de carimbar: uma queda entre os dois passos é um apagar repetido, que o armazenamento responde como feito, e nunca um arquivo que fica para sempre numa linha que diz que saiu.
6. **É estrutural**, e foi registrado antes de implementar: altera uma tabela que já existe (`media_assets` ganha `purged_at` e uma restrição que o proíbe numa mídia nunca removida) e muda o que a função da cota soma.

**Consequência.**
- Apagar o objeto não se desfaz. Não existe rota que desfaça a remoção de uma mídia, e a purga só vem trinta dias depois dela.
- A auditoria tem a linha, o `removed_at`, o `purged_at` e o evento `media.purged` (sem usuário: o relógio), mas não o arquivo.
- Mudar o prazo é uma linha em `app_private.media_retention_period()` e uma decisão nova.
- Um vídeo removido cuja miniatura ainda não foi gerada não tem chave a apagar; a lista devolve `null` e o job apaga só o que existe.

**Origem.** Issue #607, decidido pelo maestro.

**Validação.** Pendente de validação do dono.
