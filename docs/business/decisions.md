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

---

## 2026-09-23 — A regra de mudança estrutural é um gate de CI, não uma recomendação

**Contexto.** `structural-changes.md` pedia que uma mudança estrutural fosse registrada antes de ser implementada, mas era só instrução: nada impedia agente ou pessoa de seguir adiante. Rodando a verificação contra o histórico, as PRs #40 e #41 teriam sido barradas — as duas alteraram tabelas existentes e revogaram privilégios sem registrar a decisão, e foi revisão manual que pegou.

**Decisão.** `scripts/ci/verify-structural-decisions.mjs` roda no job de migration e falha quando uma migration da mudança contém SQL que alcança algo já implantado — `alter table` sobre tabela que ela não criou, `drop policy`, `drop table`, `drop column`, `revoke` ou `drop function` — sem que `docs/business/decisions.md` tenha sido tocado na mesma mudança.

**Consequência.** Migration que apenas cria objetos novos passa sem atrito, inclusive o `alter table` que a própria migration usa para habilitar RLS na tabela que acabou de criar. Falso positivo se resolve registrando a entrada e dizendo que não era decisão: custa um parágrafo, contra um retrofit. O gate cobre o banco, que é onde mudar de ideia é mais caro; mudança estrutural só de API ainda depende da revisão.

**Origem.** Decidido em sessão.

## 2026-09-23 — Módulo só é implementado depois de fechado nas três frentes, com SPEC no repositório

**Contexto.** A decisão anterior tirou o escopo dos módulos do Notion, mas não disse como ele seria produzido aqui. O repositório mostra o resultado de não ter esse fluxo: a API tem cinco módulos implementados e `apps/web/src` não tem uma tela — backend inteiro primeiro, interface depois, com o modelo de dados nunca confrontado por uma tela. A própria leitura das páginas do Notion deixou claro que decisão de produto espalhada entre issue, comentário e conversa não sobrevive à entrada de mais gente no time.

**Decisão.** Todo módulo passa por quatro fases, descritas em [module-process.md](module-process.md): entrevista de escopo em sete blocos, consolidação numa SPEC em `specs/<modulo>.md`, recorte em issues (*history* + *tasks* por frente) e fechamento com a SPEC corrigida no mesmo PR que divergir dela. A SPEC cobre backend, frontend e UX no mesmo documento, e nenhum módulo novo começa a ser implementado sem ela — `AGENTS.md` passa a exigir isso.

Três regras sustentam o fluxo:

- **UX é o último bloco da entrevista, e é esboço.** Tela desenhada antes de estado definido inventa estado; direção de arte não entra na sessão de escopo.
- **Fechar o módulo é passar por todas as frentes, não zerar dúvidas.** Ponto em aberto é esperado — mas só é válido com **gatilho**, o evento que obriga a decisão. Sem gatilho é dívida invisível.
- **Decisão fechada é registrada na hora**, aqui, marcada como pendente de validação enquanto ninguém validou. A SPEC consolida depois; a decisão não espera.

**Consequência.** Cada módulo passa a custar uma sessão antes da primeira linha de código, e a entrada de devs novos depende de a SPEC existir e estar honesta. Em troca, a issue deixa de ser o lugar onde a regra de negócio nasce. Duas consequências imediatas: as páginas do Notion viram insumo histórico explícito — `AGENTS.md` não as trata mais como autoritativas — e **autenticação e convite ficam com débito de frontend reconhecido**, porque pelo critério deste fluxo o módulo não está fechado: login, aceite de convite, criação de conta com Termos e troca de contexto nunca foram desenhados.

**Origem.** Decidido em sessão, a partir da leitura das páginas de domínio e de permissões do Notion.

## 2026-09-24 — Permissão nomeada é híbrida: módulo para ver e operar, ação para o administrativo

**Contexto.** O catálogo de permissões já existe desde a migration `20260919000000_tenancy_and_invitations.mjs`, com `permissions`, `roles`, `role_permissions` e `app_private.has_agency_permission` resolvendo por permissão nomeada — não era decisão nova, era decisão de conteúdo. O Notion propunha uma permissão por módulo **e** uma por ação, o que chegaria a cerca de quarenta linhas quando todos os módulos existissem, a maioria sem ninguém que as diferenciasse.

**Decisão.** O catálogo é híbrido: `<modulo>.visualizar` e `<modulo>.operar` cobrem o uso normal do módulo, e permissão nomeada de ação existe **apenas** para o que é administrativo ou destrutivo. As quatro permissões já existentes — `colaborador.convidar`, `cliente.convidar_usuario`, `convite.reenviar`, `convite.cancelar` — já seguem esse formato e permanecem como estão.

**Consequência.** Um nível de módulo por si só não expressa "vê e opera cliente mas não convida usuário do cliente", e é exatamente por isso que a metade administrativa continua sendo por ação. Cada entrevista de módulo passa a produzir duas coisas no catálogo: o par de módulo e a lista de ações administrativas dele. Permissão nova é `insert` em `permissions` e `role_permissions` — migration aditiva, sem alcance estrutural.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

---

## 2026-09-24 — Preset de papel é preenchido na entrevista do módulo, não antecipadamente

**Contexto.** Existem cinco papéis de sistema, e quatro deles — `account_manager`, `production`, `sales` e `finance` — estão com **zero permissões**: hoje não podem fazer nada. Preencher todos agora exigiria decidir permissões de Pipeline e Financeiro, que o próprio material do Notion tirou do MVP.

**Decisão.** Cada entrevista de módulo fecha a linha de preset do seu módulo: os cinco papéis e o que cada um pode ali. A SPEC de um módulo **não está completa sem essa linha**, e `specs/TEMPLATE.md` cobra isso na seção 2.

**Consequência.** Nenhum papel além de Admin ganha capacidade por antecipação, e o preset deixa de ser decidido no vácuo. O risco é preset esquecido por omissão; o template é o que impede. Enquanto um módulo não for entrevistado, os papéis continuam sem permissão nele — ver a decisão sobre presets vazios.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

---

## 2026-09-24 — `archived` e `removed` coexistem, e nenhuma rota exclui entidade de negócio

**Contexto.** `clients.status` usa `active | archived` e `agency_memberships.status` usa `active | removed`. Dois vocabulários já conviviam sem regra escrita, e `structural-changes.md` registrava que definir exclusão depois de vários módulos escreverem o próprio jeito é o caminho mais caro.

**Decisão.** Os dois termos permanecem, com significados distintos: **`archived`** é a entidade de negócio guardada e recuperável; **`removed`** é o vínculo entre pessoa e tenant desfeito. Entidade usa `archived`, vínculo usa `removed`. E a regra dura: **nenhuma rota da aplicação exclui fisicamente entidade de negócio.** Purga real existe apenas no fluxo de retenção e LGPD, que é separado e não passa por rota de produto.

**Consequência.** Toda entidade de negócio nova nasce com `status` e um estado terminal reversível; quem quiser um `DELETE` de verdade precisa reabrir esta decisão. Unificar os dois termos depois seria migration em toda tabela que já os usa.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

---

## 2026-09-24 — Listagem é paginada por página, com filtro e ordenação nomeados por rota

**Contexto.** Nenhuma rota lista nada ainda, e `packages/contracts/src/pagination.ts` já contratava `{ data, meta }` com `page`, `pageSize`, `totalItems` e `totalPages` sem nunca ter sido usado. A primeira listagem define o padrão que todas as outras copiam.

**Decisão.** Paginação **por página**, com o contrato que já existe. Ordenação e filtro entram como **parâmetros nomeados por rota** — `sort=name:asc`, `status=active` —, declarados na SPEC do módulo. Não existe linguagem de consulta genérica na query string.

**Consequência.** O volume é de agência, e a contagem total é necessária para a interface; cursor fica fora até que alguma listagem prove precisar dele, e trocar depois muda o `meta` de toda rota já publicada. Parâmetro de filtro não declarado em SPEC não existe: isso é o que impede a query string virar API paralela.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

## 2026-09-24 — Teto de página é global, tamanho é por rota, e bloco de resumo não pagina

**Contexto.** A decisão de paginar por página não dizia tamanho nem ordem, e tratar isso como um número único não serve: o dashboard mostra quatro itens com um "ver mais", enquanto a listagem de clientes mostra dezenas. São dois papéis diferentes no mesmo parâmetro — um é segurança, o outro é interface.

**Decisão.** O **teto** de `pageSize` é global e vale **100** para toda rota, no contrato. O **tamanho padrão** é declarado por rota na SPEC do módulo, sem valor global. E **bloco de resumo não é listagem paginada**: usa `limit` fixo declarado na SPEC, sem `page` e sem `totalItems`, com link para a listagem completa.

**Consequência.** `pageSize=100000` deixa de ser um jeito barato de derrubar a API, e o dashboard não herda paginação que nunca vai exercitar. Rota que não declarar seu tamanho padrão na SPEC está incompleta.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

---

## 2026-09-24 — Arquivado fica fora da listagem até ser pedido

**Contexto.** Com `archived` definido como estado terminal reversível de entidade de negócio, faltava dizer se ele aparece nas listagens.

**Decisão.** Entidade arquivada **não aparece** na listagem padrão. Ela é devolvida apenas quando a requisição pedir explicitamente, pelo parâmetro nomeado de status da rota.

**Consequência.** Arquivar passa a significar algo na tela, e não apenas um rótulo. Toda listagem de entidade que tenha `archived` precisa declarar na SPEC o parâmetro que revela o arquivado.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

---

## 2026-09-24 — `<modulo>.visualizar` existe mesmo onde hoje todos veem tudo

**Contexto.** A regra do v1 é que todo colaborador enxerga Dashboard, Clientes, Colaboradores e Tarefas. Com essa regra, conceder `visualizar` aos cinco presets em todo módulo do MVP produz linhas que hoje não diferenciam ninguém — e a alternativa era tornar a visibilidade implícita para quem é membro, criando permissão nomeada só nos módulos restritos.

**Decisão.** `<modulo>.visualizar` existe em todo módulo, mesmo quando todos os presets a recebem.

**Consequência.** Evita duas formas concorrentes de decidir visibilidade — implícita para uns, nomeada para outros —, sendo que a primeira escrita viraria a copiada. É `visualizar` que permite, depois, um colaborador ver certas coisas e não outras, e restringir Vendas e Financeiro sem mudar como a autorização é avaliada. O custo é `insert` em migration aditiva.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

---

## 2026-09-24 — Papéis personalizados ficam fora do MVP, e a única capacidade não delegável hoje é a posse

**Contexto.** O schema já suporta papel por agência — `roles.agency_id` com `is_system`, aceito tanto pela RLS quanto pelo guard da API. O que falta é tela de criar, duplicar e atribuir, e a regra do que nunca pode entrar num papel personalizado. Mas o catálogo tem quatro permissões: não há combinação a montar.

**Decisão.** Papéis personalizados ficam **fora do MVP**. O gatilho que reabre o assunto é **uma agência precisar de uma combinação que os cinco presets não expressam** — não uma data. Quando existirem, a capacidade **não delegável** é a **transferência de posse**.

**Consequência.** Adiar custa quase nada porque o modelo já está pronto; o que se evita é construir tela para combinar quatro permissões. Assinatura e faturamento **não** entram na lista de não delegáveis por enquanto porque ainda não existem no produto — quando existirem, entram por definição, junto com a decisão que os criar.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

## 2026-09-24 — Cobrança existe no plano do produto, não no sistema, e tem gatilho

**Contexto.** `product-overview.md` afirmava que não existe cobrança dentro do sistema. A afirmação está errada quanto à intenção do produto: há a intenção de um modelo de trial e de cobrança por volume — clientes, colaboradores, armazenamento, tarefas, dias, o que se mostrar melhor. Como `AGENTS.md` trata `docs/business/` como autoritativo, um agente lendo aquela frase projetaria ativamente contra cobrança.

**Decisão.** O documento passa a dizer o que é verdade: **cobrança não existe hoje e está prevista**, sem nada desenhado. A **nossa própria agência é isenta**, e a isenção é modelada como estado explícito da agência quando o assunto for desenhado — nunca como ausência de plano, que é o mesmo estado de uma agência inadimplente.

O **gatilho** que obriga a decisão: **a primeira vez que um limite — de clientes, colaboradores ou armazenamento — precisar ser imposto por plano, e não por configuração da operação.** É o único gatilho observável dentro do sistema, e é também o momento mais barato para desenhar, porque `media_assets` já tem quota por agência e o gancho existe.

**Consequência.** Enquanto o gatilho não acontecer, nenhum módulo assume plano, limite comercial ou estado de pagamento. Quando acontecer, assinatura e faturamento entram por definição na lista de capacidades não delegáveis a papel personalizado.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

---

## 2026-09-24 — "Sem permissão" não é uma tela: a interface espelha o 404 do backend

**Contexto.** `apps/api/src/modules/tenancy/guards.ts` devolve **404** indistintamente para agência inexistente, suspensa e inacessível — de propósito, para nunca revelar existência. Faltava dizer o que a interface faz com isso, antes que a primeira tela decidisse sozinha.

**Decisão.** Três convenções que toda tela herda:

- **Sem permissão não é uma tela.** O item não aparece no menu, e a URL digitada na mão cai no mesmo "não encontrado" de um recurso inexistente. Nunca um "você não tem acesso a isto", que confirmaria a existência do recurso.
- **Vazio** é declarado na SPEC de cada listagem: o texto e a **ação primária de saída** — o que a pessoa faz quando não há nada.
- **Erro** sempre oferece repetir a ação; nunca apenas informa.

**Consequência.** A interface não pode inventar uma tela de acesso negado sem reabrir esta decisão, porque isso transformaria o 404 deliberado do backend num oráculo de existência. Listagem sem texto de vazio e ação de saída declarados está incompleta na SPEC.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).
