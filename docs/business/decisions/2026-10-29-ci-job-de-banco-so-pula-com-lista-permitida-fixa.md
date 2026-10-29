# CI: o job de banco só pula quando todo arquivo do PR está numa lista permitida fixa

**Data.** 2026-10-29

**Contexto.** O job `PostgreSQL local database` leva cerca de 14 minutos e rodava mesmo quando o PR só mexia em `apps/web` ou em documentação. O dono decidiu, em 2026-10-29 (issue #789), acelerar o PR pequeno, com o desenho obrigatório de uma lista permitida fixa do que pode pular, nunca uma lista do que exige o job (lição do #511). A issue não dizia o que fazer com um diff vazio, com Markdown fora da raiz nem com `specs/`; cada ponto foi lido pelo caminho que roda o job.

**Decisão.**

1. O job só é pulado quando TODO arquivo do PR casa com `apps/web/**`, `docs/**` ou `*.md` na raiz do repositório. Qualquer outro caminho, inclusive um arquivo novo num lugar inesperado, roda o job inteiro.
2. Markdown dentro de pasta de código (`packages/**`, `apps/api/**`, `specs/**`) NÃO está na lista: roda o job.
3. Diff vazio, diff que não pôde ser calculado e qualquer evento que não seja `pull_request` (push em `develop` ou `main`) rodam o job.
4. O renomear conta os dois caminhos (apagado e criado): mover de `apps/web` para `packages` roda o job.
5. O job continua incondicional e termina como concluído; só os passos pesados são pulados, e um passo diz o porquê. O portão é `!= 'false'`: uma decisão sem resultado roda o job.

**Consequência.** PR só de tela ou de documentação deixa de esperar o job de banco. Acrescentar um caminho à lista pede conferir que nada que o job roda o lê, e um caso novo no teste do script. O script e o workflow vêm do próprio PR, então a revisão de `scripts/**` e `.github/**` (que sempre rodam o job) é o que protege a lista.

**Origem.** Issue #789, decisão do dono de 2026-10-29. Os itens 2 a 4 são leituras do implementador onde a issue não dizia.

**Validação.** Pendente de validação do dono.
