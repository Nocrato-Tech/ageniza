# A fila descarta o item que deixou de valer, em vez de segurá-lo

**Data.** 2026-10-08

**Contexto.** Entre o momento em que um item entra na fila e o momento em que o e-mail pode sair, o mundo muda: o cliente é arquivado, a agência é suspensa, a pessoa deixa o portal, o conteúdo é aprovado, cancelado ou tem a publicação desfeita. A regra 8 da SPEC diz que cliente arquivado "não dispara e-mail" e que agência suspensa também não, mas não diz o que acontece com o que já estava na fila quando isso aconteceu, nem com um item cujo conteúdo mudou de estado.

**Decisão.** A cada rodada o banco **descarta** (`discarded_at`) todo item que deixou de valer, e não o segura: cliente que não está ativo, agência que não está ativa, pessoa sem vínculo ativo com o cliente, e conteúdo que não está mais no estado do tipo ("aguardando aprovação" para "conteúdos para aprovar", "publicado" para "publicado"). Descartado não volta: reativar o cliente ou a agência não ressuscita o aviso, e o conteúdo que voltar a "aguardando aprovação" gera um item novo. Um item que um worker está enviando (reivindicado há menos de 10 minutos) não é tocado, para o e-mail que está saindo poder ser marcado como enviado.

**Consequência.**
- Nunca sai e-mail de "conteúdos para aprovar" sobre um conteúdo que o cliente já aprovou, nem de "publicado" sobre um que a agência desfez no mesmo dia.
- Uma agência suspensa e reativada depois não faz o cliente receber, semanas depois, um aviso velho. O que está esperando continua visível no portal.
- O descarte acontece quando o worker passa, não na hora da mudança; entre os dois, o item existe na tabela, e ninguém o lê além da própria função.

**Origem.** Regra 8 de `specs/conteudo.md` e issue #252; o descarte, em vez da retenção, é decisão da implementação.

**Validação.** Pendente de validação do dono.
