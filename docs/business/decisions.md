# Decisões de negócio

Registro cronológico, mais recente ao fim. O processo e o que entra aqui estão no [README](README.md).

---

## 2026-09-15 — Entrada de agências apenas por comando interno

**Contexto.** O produto atende a nossa agência e parceiros. Um cadastro público exigiria billing, trial e verificação de identidade, nada disso no escopo.

**Decisão.** Uma agência só nasce por comando interno da operação (`pnpm cli:agency`), que cria a agência e envia o convite de ativação. Não existe cadastro público nem cobrança dentro do sistema.

**Consequência.** Toda agência tem um responsável humano da operação. A CLI roda fora do RLS, com credencial de migração, e nunca imprime o token do convite — só o id e a expiração.

**Origem.** Issue #32.

---

## 2026-09-15 — Owner é propriedade da agência, não papel

**Contexto.** Seria natural modelar "owner" como mais um papel ao lado de Admin.

**Decisão.** Owner é uma coluna da agência (`owner_user_id`). Ele tem todas as permissões daquela agência por ser dono, e recebe também um vínculo com papel Admin.

**Consequência.** Nenhuma consulta deve procurar um papel chamado owner. Toda checagem de permissão precisa considerar o caminho do dono além do caminho do vínculo. Transferência de propriedade não existe ainda e será uma decisão à parte.

**Origem.** Issue #32, `AGENTS.md`.

---

## 2026-09-15 — Contexto de tenant explícito na rota, nunca na sessão

**Contexto.** O padrão comum é guardar a "agência ativa" na sessão depois do login.

**Decisão.** O contexto vai na rota (`/agencies/:agencyId/...`) e é revalidado a cada requisição. A sessão não guarda contexto algum. O último contexto usado é salvo como **preferência de navegação** e nunca concede acesso.

**Consequência.** Remover um vínculo, arquivar um cliente ou suspender uma agência tem efeito na requisição seguinte, sem logout. A mesma pessoa pode operar duas agências em duas abas sem interferência. Em troca, toda rota de domínio precisa passar pelas guardas de tenant.

**Origem.** Issues #32 e #33.

---

## 2026-09-15 — Agência suspensa preserva dados e nega acesso

**Contexto.** Era preciso um estado para interromper uma agência sem destruir nada.

**Decisão.** Agência tem `active` ou `suspended`. Suspensa: o acesso àquele tenant é negado, os convites dela não podem ser aceitos, e os vínculos dela não valem como contexto. Nenhum dado é alterado, e os outros contextos da mesma pessoa seguem funcionando.

**Consequência.** Reativar devolve tudo. Fica o invariante para o futuro: jobs de agência suspensa não executam ação de negócio externa, como publicar conteúdo agendado.

**Origem.** Issue #32.

---

## 2026-09-16 — Mídia vai direto do navegador para o armazenamento

**Contexto.** O produto gerencia vídeo longo e Reels em volume. Passar os arquivos pelo servidor esbarraria no limite de 100 MB da borda e encheria o disco da VPS.

**Decisão.** O upload vai direto do navegador para o R2, com URL assinada e multipart retomável. O servidor autoriza antes e, depois, confere o que de fato chegou. Arquivo fora do tipo, do tamanho ou da quota é recusado e apagado.

**Consequência.** A validação só é possível **depois** do upload, porque o protocolo não aceita política de tamanho em URL assinada. CORS e lifecycle do bucket são configuração manual no painel da Cloudflare, e é o único trecho do fluxo sem cobertura de teste automatizado.

**Origem.** Issue #21, ADR 0011.

---

## 2026-09-16 — O original nunca é convertido

**Contexto.** Seria tentador padronizar todo vídeo num formato só.

**Decisão.** O worker gera thumbnail e preview em 720p apenas para aprovação interna. O arquivo original é publicado como está.

**Consequência.** A qualidade que o cliente aprova no preview não é a que vai ao ar — o preview existe para revisão, não para representar o resultado final.

**Origem.** Issue #24.

---

## 2026-09-18 — Tipos de mídia aceitos definidos em código

**Contexto.** A issue não especificava quais formatos aceitar.

**Decisão.** Imagens `png`, `jpeg`, `webp` e `gif`; vídeos `mp4`, `quicktime` e `webm`. Qualquer outro tipo é recusado na confirmação e o objeto é removido.

**Consequência.** Ampliar a lista é mudança de código, não de configuração.

**Origem.** PR #40. **Pendente de validação.**

---

## 2026-09-18 — Mídia é escopada por agência, sem vínculo com cliente

**Contexto.** As issues de mídia não mencionam relação entre arquivo e cliente.

**Decisão.** `media_assets` pertence à agência. Não há coluna de cliente.

**Consequência.** Se o portal do cliente precisar mostrar apenas a mídia dele, isso exigirá migration e mudança de RLS.

**Origem.** PR #40. **Pendente de validação.**

---

## 2026-09-18 — Quota de armazenamento sem interface de configuração

**Contexto.** Nenhuma issue pediu administração de quota.

**Decisão.** Existe um padrão por ambiente e um override por agência em `agency_storage_quotas`. O ajuste é feito direto no banco pela operação.

**Consequência.** Mudar a quota de um cliente exige acesso ao banco. Não há registro de quem mudou nem quando.

**Origem.** PR #40. **Pendente de validação.**

---

## 2026-09-18 — O processamento de vídeo não contorna o RLS

**Contexto.** O worker precisa ler e gravar dados de uma agência sem haver requisição de usuário.

**Decisão.** O worker autentica a transação como o usuário que confirmou o upload, em vez de usar uma identidade de serviço com acesso irrestrito.

**Consequência.** Se a permissão dessa pessoa for revogada entre o upload e o processamento, o job vira no-op silencioso e **o arquivo fica sem thumbnail e sem preview indefinidamente**, sem sinal para a operação. Preserva o invariante de que a aplicação nunca contorna o RLS.

**Origem.** PR #40. **Pendente de validação.**

---

## 2026-09-18 — Falha ao enfileirar não derruba a confirmação do upload

**Contexto.** Se a fila estiver indisponível no instante da confirmação, ou o upload se perde, ou o processamento se perde.

**Decisão.** A confirmação é concluída e a falha ao enfileirar é apenas registrada.

**Consequência.** O arquivo fica `pending` sem ninguém para processá-lo, e não existe varredura que recupere esses casos.

**Origem.** PR #40. **Pendente de validação.**

---

## 2026-09-18 — Permissões de convite são reconhecidas pelo banco, não só pela API

**Contexto.** As policies do banco exigiam a permissão de *convidar* para qualquer alteração em convites, enquanto as rotas de reenviar e cancelar exigem as suas próprias. Um papel com apenas `convite.cancelar` passaria pela API e veria zero linhas.

**Decisão.** Alinhar o banco às rotas: as policies aceitam qualquer permissão que governe a operação. Nenhuma permissão nova foi criada.

**Consequência.** Como `admin` já detém as quatro, o comportamento hoje é idêntico; a mudança só importa quando existirem papéis personalizados. Reenviar cria uma linha nova, então a policy de inserção também reconhece `convite.reenviar` — e com isso o RLS deixa de garantir sozinho que apenas quem convida cria convite. A API mantém essa fronteira.

**Origem.** Issue #39, PR #41.

---

## 2026-09-23 — Desenvolvimento e validação locais até os módulos iniciais ficarem prontos

**Contexto.** A infraestrutura está escrita e com CI verde, mas nunca rodou num deploy real. A alternativa era contratar a VPS agora, ou ao menos apontar um Cloudflare Tunnel gratuito para a máquina de desenvolvimento e exercitar o R2 real antes de seguir. Nenhuma das duas era necessária para continuar construindo.

**Decisão.** Todo o desenvolvimento e toda a validação seguem locais — PostgreSQL, MinIO, Mailpit e worker em Docker — até que os módulos iniciais estejam prontos. Só então vem o deploy e a validação contra os serviços reais.

**Consequência.** Estes pontos ficam **sem validação alguma** até lá, e os ajustes que eles exigirem virão todos de uma vez:

- CORS e lifecycle do bucket R2. O MinIO não implementa a API de CORS por bucket, e sem o header `ETag` exposto o upload multipart não funciona.
- Comportamento real do R2 em multipart e URLs assinadas, onde o MinIO não é substituto fiel.
- Cloudflare Tunnel como única borda pública.
- Entrega real de e-mail: SPF, DKIM e reputação. O Mailpit não prova nada disso.
- Consumo de CPU do ffmpeg disputando a VPS com o PostgreSQL e a API, que é a premissa por trás dos limites de concorrência escolhidos.
- Backup e restore de verdade contra o R2.

Para reduzir o risco, o deploy deve ser feito **antes** de haver dependência dele: a primeira validação real vai gerar ajustes, e é melhor que aconteçam numa semana tranquila.

**Origem.** Decidido em sessão.

---

## 2026-09-23 — Escopo dos módulos iniciais é definido no repositório, não no Notion

**Contexto.** Parte do escopo dos próximos módulos — colaboradores, clientes, configurações — já havia sido rascunhada no Notion.

**Decisão.** Esse escopo será refeito aqui, fechando um módulo de cada vez, com as decisões saindo de sessões de questionamento e registradas neste arquivo antes da implementação. O Notion deixa de ser destino de decisão nova.

**Consequência.** Nenhuma implementação de módulo novo começa antes de o escopo dele estar escrito aqui e na issue correspondente. O que já existir no Notion é insumo, não fonte de verdade, e precisa ser reescrito ou descartado explicitamente — ver issue #42.

**Origem.** Decidido em sessão.

---

## 2026-09-23 — Infraestrutura cresce por necessidade, com mudança estrutural tratada à parte

**Contexto.** A base está madura e o molde de módulo novo está pronto, então antecipar infraestrutura resolveria problemas que talvez nunca apareçam. Ao mesmo tempo, aqui nem toda mudança é local: migration aplicada não se edita, RLS existe em toda tabela de negócio, e o primeiro módulo a resolver um problema vira o modelo que os próximos copiam.

**Decisão.** Infraestrutura é incrementada conforme a regra de negócio exigir. Mudança **estrutural** — que altera tabelas existentes, muda um formato que outras rotas copiam, atravessa RLS de vários módulos, muda como a autorização é avaliada, ou exigiria backfill — para antes de ser implementada e é registrada aqui primeiro.

**Consequência.** `AGENTS.md` obriga a leitura de [structural-changes.md](structural-changes.md) antes de qualquer implementação nova, e esse arquivo mantém a lista viva do que já sabemos ser estrutural. O custo é uma parada explícita quando o caso aparece; o que se evita é decidir em silêncio dentro de um PR que era sobre outra coisa.

**Origem.** Decidido em sessão.
