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

## 2026-09-24 — Carregamento tem três tratamentos, e escrita nunca deixa dado velho na tela

**Contexto.** `apps/web/src/query.ts` usa `staleTime` de 30s, sem refazer busca ao focar a janela ou reconectar. Isso significa que voltar a uma tela em menos de meio minuto serve o cache: navegação não é o que atualiza a tela depois de uma escrita, ao contrário do que a intuição sugere. Sem uma convenção escrita, a primeira tela decidiria isso sozinha.

**Decisão.** Carregamento tem três situações e tratamentos distintos: **primeira carga** usa skeleton com a forma do conteúdo, que reserva o layout; **revalidação com dado em tela** não muda a tela; **ação pontual** mantém o estado no próprio controle, com confirmação ao terminar e sem travar o fluxo. **Não existe spinner de tela cheia depois da primeira carga.**

E a regra que governa atualização: **toda mutação invalida as queries que afeta**, declaradas na SPEC do módulo. Salvar e continuar exibindo o dado anterior é defeito, não latência. Sem tempo real e sem polling.

**Consequência.** `staleTime` deixa de governar a atualização e vira apenas economia de requisição. Toda SPEC de módulo passa a declarar, por rota de escrita, quais listagens ela invalida — sem isso a regra não é verificável.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

---

## 2026-09-24 — Nenhum módulo abre antes de o anterior estar fechado e recortado

**Contexto.** `module-process.md` descrevia as quatro fases sem dizer que elas são um portão. Com mais desenvolvedores entrando, "a SPEC sai depois" é exatamente como a implementação volta a preceder a decisão.

**Decisão.** A entrevista de um módulo **não abre** enquanto o anterior não estiver **fechado** — SPEC aprovada — e **recortado** — history, tasks, abertos e débitos criados, com a seção 12 da SPEC preenchida com os números das issues. A precisão que o primeiro módulo exigiu: **recortado não significa ter pelo menos uma history**. A SPEC de autorização tem zero, porque convenção não é capacidade entregável; o portão é o recorte existir.

**Consequência.** Cada módulo custa um passo a mais antes do seguinte, e o benefício é que nenhum módulo começa em cima de um anterior cujas pontas ninguém amarrou. A separação entre os três documentos permanece: **ADR** para decisão técnica de consequência longa, **SPEC** para o fechamento do módulo, **decisions.md** para o registro cronológico — um módulo pode gerar um ADR além da SPEC, nunca no lugar dela.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

## 2026-09-24 — O esboço da SPEC é briefing de designer, e task de interface espera a tela

**Contexto.** O processo dizia que o bloco de UX produz esboço de baixa fidelidade, sem dizer para quem. Sem isso, "esboço" poderia ser lido como permissão para codificar a tela direto a partir dele — que é como a interface passa a ser desenhada por quem está implementando.

**Decisão.** O bloco de UX da SPEC é o **briefing do designer**. A sequência é **esboço → design → código**: o esboço descreve o que a tela precisa resolver, o designer entrega a tela, e só então ela é codificada.

As **tasks de `escopo:web` são escritas junto com as demais**, a partir do esboço e das decisões da SPEC, e recebem o rótulo `aguardando-design` até a entrega. Isso não bloqueia o resto: `escopo:api` e `escopo:db` seguem em paralelo, porque o contrato que elas implementam já está fechado na SPEC.

**Consequência.** A entrega do designer entra no caminho crítico de toda tela, e é um prazo que não depende de nós. Em troca, o trabalho de interface fica descrito e priorizado antes de existir tela — quem receber o design já encontra a issue pronta, com aceite e dependências. Ninguém codifica tela a partir do wireframe.

**Origem.** Decidido em sessão. **Substituída em 2026-09-28** quanto à ordem esboço → design → código e ao rótulo `aguardando-design`: a tela passa a ser codificada a partir do esboço e refinada depois pelo designer (ver a entrada de 2026-09-28, ao fim). O esboço em nível de wireframe, as tasks de web escritas junto com as demais e `escopo:api` e `escopo:db` em paralelo continuam valendo.

## 2026-09-24 — Escopo do módulo de autenticação: o que entra, e por que verificação de e-mail já está resolvida

**Contexto.** O backend de autenticação, convites e contextos está implementado desde as issues #31, #32 e #33, sem nunca ter passado por uma SPEC. Ao fechar o escopo, três capacidades foram levantadas como faltantes: verificação de e-mail, alteração de senha por quem está logado, e troca de e-mail.

**Decisão.** O módulo cobre **login, recuperação de senha, aceite de convite com conta existente, criação de conta no aceite com Termos, resolução e seleção de contexto, troca de contexto, logout e logout de todas as sessões**.

Sobre as três levantadas:

- **Verificação de e-mail já está satisfeita, e não por omissão.** `apps/api/src/modules/invitations/routes.ts` cria a conta com `emailVerified = true` porque o convite chegou naquele endereço e o token só existe lá. Um passo de verificação depois pediria à pessoa que provasse de novo o que o link já provou.
- **Alteração de senha por quem está logado fica fora do MVP.** A recuperação por link, que já existe, atende o caso real de quem perdeu o acesso.
- **Troca de e-mail fica fora do MVP**, com gatilho: o primeiro colaborador ou cliente real pedir. Até lá é operação, pelo mesmo caminho por onde a agência nasce.

**Consequência.** Nenhuma das três exige backend novo agora. Se a troca de e-mail entrar, ela traz rota, token, e-mail transacional e **aviso ao endereço antigo** — sem esse aviso, quem rouba uma sessão troca o e-mail e a pessoa perde a conta em silêncio.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

---

## 2026-09-24 — A mesma pessoa com dois e-mails são duas contas, e identidades não se vinculam

**Contexto.** `auth."user".email` é único e o `User` é a identidade global. Perguntou-se o que acontece quando alguém é owner de uma agência com um endereço e colaborador de outra com endereço diferente.

**Decisão.** São **duas contas**, independentes, e isso é aceito. Vincular identidades — um login enxergando os contextos de todos os e-mails de uma pessoa — está **fora**: mudaria o que `User` significa, de identidade para agregado de identidades, atravessando RLS, `current_user_id()` e toda tabela que referencia usuário.

Com isso a regra de e-mail fecha por conta, não por papel: **se a conta é owner de alguma agência, o e-mail dela não é autosserviço**, porque amarra a assinatura que ainda não existe.

**Consequência.** "A mesma pessoa em vários lugares", como o `product-overview.md` descreve, vale apenas para contextos atrelados **ao mesmo e-mail** — convite é endereçado a um endereço, e o endereço define a conta. Quem tem duas contas precisa sair e entrar de novo para alternar: o seletor de contexto mostra somente os contextos daquela conta.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

---

## 2026-09-24 — Credencial correta sem nenhum contexto não cria sessão

**Contexto.** Hoje `POST /auth/login` cria sessão para qualquer credencial válida, e `GET /me/contexts/resolve` responde `none` quando a pessoa não tem agência nem cliente — o que acontece com quem foi removido de todas as agências. O resultado é alguém autenticado dentro de uma aplicação sem nada.

**Decisão.** Autenticar primeiro, negar depois. Senha errada continua devolvendo o genérico de credencial inválida; senha **correta com zero contextos** devolve mensagem própria — acesso encerrado, procure quem administra a agência — e **nenhuma sessão é criada**. Isso não revela quais e-mails têm conta: quem chegou a esse ponto já provou que sabe a senha.

A regra é cobrada **no login e na resolução de contexto**, não no guard de sessão. Cobrar em toda requisição custaria uma consulta a mais para sempre, e é desnecessário: `requireAgencyAccess` e `requireClientAccess` já devolvem 404 para tudo que a pessoa não alcança, então uma sessão sem contexto já é inofensiva. O que faltava não era barrar acesso, era não deixar a pessoa presa.

**Consequência.** É **mudança de contrato numa rota implantada**: o comportamento de `POST /auth/login` muda e seus testes de integração mudam junto. A conta continua existindo, então um convite novo para o mesmo e-mail volta a funcionar pelo fluxo de conta existente — não é exclusão, é acesso sem vínculo.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

---

## 2026-09-24 — Sete telas de autenticação, com o convite em uma rota e dois estados

**Contexto.** O módulo não tem nenhuma tela, e o backend já decide mais do que a interface costuma assumir: `GET /me/contexts/resolve` devolve `none`, `enter` ou `select`, e `GET /invitations/:token` devolve `accountExists`.

**Decisão.** Sete telas: **Entrar**, **Esqueci a senha**, **Redefinir senha**, **Convite**, **Escolher contexto**, **Acesso encerrado**, e as páginas de **Termos** e **Privacidade**. "Link inválido" é **estado** das telas de convite e reset, não tela própria.

- **O convite é uma rota com dois estados.** A URL é a mesma que chegou no e-mail; `accountExists` escolhe entre confirmar e preencher nome, senha e Termos. Os dois estados mostram para qual agência, qual cliente quando houver, e para qual e-mail o convite foi endereçado.
- **O reset continua o convite automaticamente.** A API já carrega o `inviteToken` pelo fluxo de recuperação e autentica no fim; mandar a pessoa buscar o e-mail de convite de novo seria pedir que ela reconstruísse à mão um estado que o servidor já tem.
- **Seletor de contexto: tela própria depois do login, menu durante o uso.** No login a escolha é bloqueante e não há contexto ativo; durante o trabalho, trocar é ação secundária. `PUT /me/last-context` é gravado nos dois casos, e é isso que faz o segundo login não repetir a pergunta.
- **Menu de conta no cabeçalho** em toda tela autenticada, com o contexto ativo, sair e sair de todas as sessões — sem ele, `POST /auth/logout-all` existe na API e é inalcançável na interface.
- **As rotas do navegador são em português**: `/entrar`, `/convite/:token`, `/senha/esquecida`, `/senha/redefinir`, `/contextos`, `/termos`, `/privacidade`. As rotas da API continuam em inglês; só uma das duas camadas é lida por gente, e o link de convite vai por e-mail.

**Consequência.** A interface obedece o `resolve` em vez de recalcular a decisão, o que mantém uma única fonte para "onde esta pessoa entra". Qualquer tela nova de autenticação herda as convenções da seção 7 de `specs/autorizacao.md`.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

---

## 2026-09-24 — Termos e Privacidade são conteúdo estático versionado, com aceite único

**Contexto.** O banco registra as versões de Termos e de Privacidade separadamente, o contrato de aceite pede um único `acceptTerms: true`, e nenhuma rota entrega os documentos ao navegador.

**Decisão.** O conteúdo dos dois documentos vive **estático e versionado no repositório**, servido pelas páginas `/termos` e `/privacidade` — sem rota de API. O aceite é **um checkbox**, com os links dos dois documentos dentro do próprio texto, e grava as duas versões.

**Reaceite quando uma versão muda fica em aberto**, com gatilho: a primeira alteração de um dos documentos depois de existir gente com conta. Hoje ninguém tem conta.

**Consequência.** Redigir os dois textos é **trabalho da implementação**, não decisão pendente: entra como task do épico. Os textos precisam de revisão jurídica antes de valerem como documento — o que sai daqui é minuta, não parecer.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

## 2026-09-24 — A entrevista abre por uma pergunta de fluxo, antes de qualquer rodada

**Contexto.** O roteiro põe UX no sétimo lugar, de propósito: tela desenhada antes de estado definido inventa estado. Mas a entrevista de autenticação mostrou o efeito colateral. As capacidades que o backend não tinha — troca de senha por quem está logado, troca de e-mail — só apareceram quando a conversa chegou perto das telas, depois de a sessão já ter decidido escopo em cima do que existia. Quem conduz gastou a sessão inteira raciocinando sobre o implementado, e o que faltava chegou atrasado.

**Decisão.** A entrevista abre com uma **pergunta aberta sobre o fluxo**: como o módulo deve funcionar na prática, e quais telas quem usa imagina. Uma pergunta, ampla, sem opções numeradas — conversa, não rodada. O que ela colhe é **intenção e inventário de telas**, nunca layout e nunca decisão fechada; os sete blocos seguintes refinam aquilo contra os contratos e as regras que já existem.

Quando a resposta revelar algo que a API não faz, quem conduz diz isso na hora e trata como **capacidade nova** — escopo a decidir, não detalhe de tela.

**Consequência.** UX continua sendo o sétimo bloco, e continua fechando o esboço: o bloco 0 levanta as telas, o bloco 6 as desenha. O risco que isso cria é a abertura virar desenho antecipado, e é por isso que ela é explicitamente sem layout. O que se ganha é a chance de acrescentar algo que o backend não tem enquanto ainda é barato decidir.

**Origem.** Decidido em sessão, a partir da entrevista do módulo de autenticação.

## 2026-09-24 — Idioma: código em inglês, documentação de negócio em português

**Contexto.** O repositório já misturava os dois sem regra escrita: código, identificadores e comentários em inglês; `docs/business/` e as SPECs em português; mensagens ao usuário em português. Os commits eram em inglês com escopo (`feat(api):`) até 23/09 e passaram a português sem escopo a partir da sessão seguinte — mudança feita sem registro, e percebida só na auditoria de documentação.

**Decisão.** **Código em inglês**: identificadores, comentários, nomes de arquivo, schemas e mensagens de log. **Documentação de negócio em português**: `docs/business/`, `specs/`, `README` de módulo, issues. **Mensagem ao usuário em português**, inclusive as da API, que já respondem assim.

O **commit segue o idioma do que ele muda**. Um commit que mistura código e documentação de negócio é sinal de que deveriam ser dois commits.

Junto com isso, o `AGENTS.md` já exigia comentário mínimo, e a regra continua valendo com ênfase: comentário existe para o que o código não consegue dizer — uma restrição não óbvia, a razão de uma decisão surpreendente. Nunca para repetir o que a próxima linha faz.

**Consequência.** O histórico de commits fica bilíngue, e converter o passado não vale o esforço: a regra passa a valer daqui em diante. Quem escreve código lê e escreve inglês de qualquer forma, porque é o idioma das bibliotecas; quem decide produto lê português, e é para essa pessoa que `docs/business/` existe.

**Origem.** Decidido em sessão, durante a auditoria de documentação para entrada de novos desenvolvedores.

---

## 2026-09-24 — A documentação de entrada passa a ter dono explícito

**Contexto.** Antes de abrir o projeto para mais desenvolvedores, a documentação foi auditada contra a pergunta "o que falta para alguém começar sozinho?". Faltavam seis coisas, e a mais grave era estrutural: `pnpm cli:agency` é o **único** jeito de criar uma agência — logo, o único jeito de obter um ambiente utilizável — e estava mencionado uma única vez, dentro de uma entrada antiga de decisão. Um clone novo levava a um banco vazio sem caminho para frente.

**Decisão.** A documentação de entrada passa a ser composta por quatro peças, cada uma com um papel que as outras não têm:

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — branch, commit, PR, revisão, o que fazer quando o CI reprova.
- [`docs/local-environment.md`](local-environment.md) — do clone até um ambiente em que dá para entrar no produto, incluindo criar agência e ler o convite no Mailpit.
- [`docs/module-anatomy.md`](module-anatomy.md) — o molde que todo módulo da API segue, que o `AGENTS.md` afirmava existir sem descrever.
- [`docs/onboarding.md`](onboarding.md) — o roteiro de leitura, o processo de trabalho e as regras de sessão com agente.

Mais um template de pull request que cobra verificação real e a checagem estrutural.

**Consequência.** O roteiro de ambiente local foi **executado do início ao fim** antes de ser escrito, e isso revelou uma divergência que nenhuma leitura teria pego: o e-mail de convite aponta para `/invite/<token>` e o de recuperação para `/reset-password`, enquanto `specs/auth.md` decidiu rotas em português. Documentação de ambiente que não foi executada descreve o que deveria funcionar, não o que funciona.

**Origem.** Decidido em sessão.

## 2026-09-24 — Escopo do módulo de colaboradores

**Contexto.** Primeira entrevista conduzida pelo bloco 0, a pergunta aberta de fluxo. Ela levantou cinco capacidades que o backend não tem — foto de perfil, remuneração, estatísticas do colaborador, edição do próprio nome e solicitação de troca de e-mail — e três delas mudavam o tamanho do módulo.

**Decisão.** O módulo cobre: **listar a equipe** em grade de crachás com busca e filtros, **ver o detalhe** de uma pessoa num modal com abas, **convidar** colaborador, **reenviar e cancelar** convite, **remover** do quadro e **reativar**, **trocar o papel** de alguém, **editar o cargo** de alguém, e **editar o próprio nome e a própria foto**.

Fica fora, com razão declarada:

- **Remuneração** — vai para o módulo Financeiro; ver a decisão seguinte.
- **Estatísticas do colaborador** (entregas, pendências) — não há o que contar antes de Tarefas existir. O modal nasce com a estrutura de abas e a área reservada. Gatilho: a primeira entrevista que criar tarefa atribuível a colaborador.
- **Pré-cadastro no convite** — o convite leva e-mail e `role_id`, e nada mais. Guardar cargo ou remuneração de um convite pendente exigiria alterar `invitations`, cuja policy de `UPDATE` é deliberadamente restrita a `revoked_at` (issue #39); dado editável de RH ali obrigaria a afrouxar aquela trava.
- **Solicitação de troca de e-mail** — a tela informa que a troca é feita pela operação, e a conversa acontece fora do produto. Criar uma fila de solicitações, com estado e notificação, para um evento raro cujo desfecho é alguém rodando um comando não se paga. Volta à mesa quando a troca de e-mail for destravada.
- **Telefone e qualquer campo além dos definidos** — o vínculo carrega nome, foto, e-mail, cargo, papel e data de entrada. Nada mais no MVP.

**Consequência.** Nenhuma tabela nova e nenhuma coluna nova: `job_title` já existe em `agency_memberships`, e `image` já existe em `auth."user"`. O que falta é policy, rota e tela.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

---

## 2026-09-24 — Remuneração pertence ao Financeiro, que entra no MVP depois de Tarefas

**Contexto.** A descrição inicial do módulo colocava o salário no crachá, visível para Owner e Financeiro e **não** para o Admin. Isso abria três problemas: RLS no PostgreSQL é por linha e não por coluna, então proteger um campo dentro de `agency_memberships` é frágil; quem convida é o Admin, que não poderia ler o dado que definiria; e a própria descrição vinculava remuneração à "saúde financeira da agência", que é outro módulo.

**Decisão.** A remuneração **nasce no módulo Financeiro**, não em Colaboradores. O crachá do MVP **não mostra salário para ninguém**, inclusive para o Owner, e o espaço é reincluído quando o Financeiro estiver estruturado. Gatilho: **a entrevista do módulo Financeiro**.

O **Financeiro deixa de ser pós-MVP** — o material do Notion o excluía. Ele entra em versão básica, com o que o dono de uma agência precisa para ver saúde do negócio, e sua posição na ordem é **depois de Tarefas, antes do Dashboard**: depende de Clientes para falar de cobrança, e adiantá-lo na frente de Conteúdo inverteria a prioridade do produto.

Três regras já ficam **pré-decididas** para não serem redecididas do zero lá:

- **Quem lê**: o Owner lê todas; quem tem `remuneracao.visualizar` (preset Financeiro) lê todas; **qualquer pessoa lê a própria**, independentemente do papel. O colaborador vê o próprio número — esconder dele removeria a segurança que o dado existe para dar.
- **Onde vive**: tabela própria, nunca coluna em `agency_memberships`. Um `select *` descuidado, uma view ou um `RETURNING` expõem coluna; a RLS decide linha.
- **Histórico**: cada alteração é uma linha com vigência, e o valor atual é a mais recente. Reajuste, promoção e correção são o uso normal; trocar para histórico depois exigiria backfill, que é critério de mudança estrutural.

**Consequência.** O Admin passará a ver a própria remuneração e não a dos outros — a primeira vez que um preset Admin ficará sem uma permissão do catálogo. A ordem de módulos passa a ser: Colaboradores, Clientes, Conteúdo, Tarefas, Financeiro básico, Dashboard.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

---

## 2026-09-24 — Foto de perfil vive em armazenamento de identidade, separado do módulo de mídia

**Contexto.** `auth."user".image` já existe, mas não há fluxo de upload. E há um conflito de escopo: o **usuário é global** e a **mídia é por agência, com quota**. A foto de quem trabalha em duas agências não pertence a nenhuma delas.

**Decisão.** Existe um **armazenamento de identidade**, separado do módulo de mídia e **sem consumir quota de agência**. Ele serve a foto de usuário hoje e a identidade visual de portal depois, quando a personalização por agência existir.

**Consequência.** É infraestrutura nova neste módulo — a primeira desde a mídia. O que se evita é um defeito verificável: com a foto dentro da mídia da agência, a pessoa sai daquela agência ou a agência é suspensa, e o avatar dela desaparece nas outras, porque o arquivo pertencia ao tenant e não a ela. A quota de vídeo de cliente também deixa de disputar espaço com avatar, que é uso decorativo.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

---

## 2026-09-24 — Permissões de colaboradores: o Gestor edita cargo, nunca papel

**Contexto.** Faltava definir o que separa o Admin do Gestor de conta. O modelo não tem hierarquia entre colaboradores — `ClientAssignment` liga colaborador a cliente, nunca colaborador a colaborador —, então qualquer poder administrativo do Gestor é poder sobre **todos**, inclusive sobre Admins.

**Decisão.** O catálogo do módulo:

| capacidade | permissão | quem recebe no preset |
|---|---|---|
| Ver a equipe | `colaborador.visualizar` | todos os cinco papéis |
| Convidar | `colaborador.convidar` *(já existe)* | Admin |
| Reenviar e cancelar convite | `convite.reenviar` · `convite.cancelar` *(já existem)* | Admin |
| Remover do quadro | `colaborador.remover` | Admin |
| Trocar o papel de outro | `colaborador.alterar_papel` | Admin |
| Editar o cargo de outro | `colaborador.alterar_funcao` | Admin e **Gestor de conta** |

**Não existe `colaborador.operar`.** A decisão da sessão 0 obriga `visualizar` em todo módulo, mas não obriga `operar`, e aqui não há uso entre olhar a equipe e administrar alguém. Editar o próprio perfil não é permissão: é sobre si, e se resolve por identidade.

A distinção que sustenta o Gestor: **cargo é dado profissional e não concede autorização; papel concede.** Ele organiza a equipe sem poder aumentar o acesso de ninguém. E ele **não convida**, porque convidar obriga a escolher o papel, e os cinco presets **não têm ordem entre si** — sem hierarquia de papéis, nada impediria um Gestor de convidar alguém como Admin e pedir para ser promovido de volta.

**Consequência.** "Gestor de operação", "gestor financeiro" e "gestor de vendas" são **cargos**, não papéis: o papel `account_manager` é um só, e o que diferencia um do outro é o `job_title` mais as permissões que os outros módulos derem a ele. Ninguém deve criar três papéis onde um basta.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

---

## 2026-09-24 — ESTRUTURAL: só o Owner concede o papel de Admin, e a autorização passa a depender do valor

**Esta é uma mudança estrutural**, por dois dos cinco critérios de [structural-changes.md](structural-changes.md): mexe em policies de RLS de **mais de um módulo**, e muda **como a autorização é avaliada**. Registrada antes de qualquer implementação.

**Contexto.** Até aqui toda autorização do sistema responde uma pergunta só: *tem a chave?*. `app_private.has_agency_permission(agency_id, permission)` recebe uma permissão e devolve sim ou não. A regra "quem pode atribuir outros Admins é o Owner" pergunta outra coisa: *tem a chave **e** qual valor está sendo concedido?*. E ela tem um segundo ponto de fuga: se só o Owner promove a Admin mas o Admin pode **convidar** alguém já como Admin, a regra não existe.

**Decisão.** A regra é expressa por **duas permissões**, não por uma condição escondida na rota:

- `colaborador.alterar_papel` — o Admin recebe, e vale para papéis **não administrativos**.
- `colaborador.atribuir_admin` — **nenhum preset recebe**. Só o Owner passa, porque ele faz curto-circuito na verificação por posse.

A mesma dupla vale nos dois pontos onde um papel é concedido: **a troca de papel** de um vínculo e **a criação de um convite** de colaborador. Uma regra que vale em um lugar e não no outro não é regra.

**Consequência.** Duas policies são tocadas, em módulos diferentes:

- `agency_memberships` ganha policy de `UPDATE`, que **não existe hoje** — a tabela só tem `SELECT`, e é por isso que trocar papel e remover colaborador não funcionam em nenhuma das duas camadas.
- `invitations` tem sua policy de `INSERT` **substituída** para reconhecer a nova condição. `drop policy` dispara o gate de CI, e é por isso que esta entrada existe antes do código.

Ganha-se uma propriedade que vale registrar: `colaborador.atribuir_admin` é uma permissão que **existe e não é concedida a ninguém**, porque a posse é a única forma de tê-la. Quando papéis personalizados existirem (#52), ela já está na lista de não delegáveis por construção.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

**Nota de implementação (2026-09-28, issue [#94](https://github.com/Nocrato-Tech/ageniza/issues/94)).** A migration `20260928000000_collaborator_permissions_and_admin_grant.mjs` cria `agency_memberships_update` — a policy de `UPDATE` que faltava — e substitui `invitations_insert`. A checagem do papel `admin` ficou numa função nova, `app_private.is_admin_role`, reaproveitada nos dois pontos onde um papel é concedido, como a decisão pedia.

**Correção pós-revisão (2026-09-29, PR [#159](https://github.com/Nocrato-Tech/ageniza/pull/159)).** A revisão de segurança do PR achou dois defeitos na primeira versão, ambos na mesma migration (ainda não mergeada):

1. O grant de `UPDATE` continuava de tabela inteira, então `agency_id`/`user_id`/`id` seguiam graváveis; qualquer ator com uma permissão do módulo movia um vínculo entre agências ou usuários sem tocar `role_id`/`job_title`/`status`, contornando o gate por completo. Corrigido com `revoke update` + `grant update (role_id, job_title, status, updated_at)`, no mesmo padrão já usado por `client_memberships` (2026-09-20) e `invitations` (2026-09-25).
2. A comparação valor-antigo/valor-novo, feita por sub-select sem `FOR UPDATE` na `WITH CHECK`, lia o snapshot do início do statement — correto contra um único escritor, mas sob `READ COMMITTED` com duas transações concorrentes o `UPDATE` reaplica via EvalPlanQual sobre a versão mais nova, e o sub-select continua lendo a antiga. Um Admin sem `colaborador.atribuir_admin` conseguia reconceder `admin` logo depois que o Owner rebaixava o mesmo vínculo. Corrigido movendo a comparação para um trigger `BEFORE UPDATE` (`app_private.check_agency_membership_update`), cujo `OLD` é a linha realmente travada para a escrita, não uma leitura independente.

A `WITH CHECK` ficou só com a filtragem de linha (mesma condição da `USING`); toda a lógica que depende do valor novo — inclusive o escopo de `role_id` por agência (também endereçado aqui, e replicado em `invitations_insert`) — está no trigger. Uma consequência visível nos testes: o trigger lança uma exceção com `errcode 42501` e mensagem própria em vez do texto "row-level security" do Postgres, então `tenancy.integration.test.ts` passou a casar contra essas mensagens onde antes usava `/row-level security/`.

**Segunda correção pós-revisão (2026-09-29, mesma PR).** A re-revisão achou que o trigger, sendo `security definer` e decidindo o bypass administrativo pela ausência de `app.user_id`, tinha dois defeitos:

1. **[ALTO] Regressão no aceite de convite.** `app_private.accept_invitation` também é `security definer` e reativa um vínculo `removed` (ou grava o vínculo do novo Owner) via `INSERT ... ON CONFLICT DO UPDATE` — o que dispara o trigger com `app.user_id` igual ao **convidado**, não a um ator com `colaborador.alterar_papel`. Aceitar um reconvite como colaborador removido, ou uma ativação de agência quando o convidado já tinha uma linha na agência, passou a devolver erro em vez de reativar o vínculo.
2. **[MÉDIO] O bypass dependia do GUC, não do papel.** `set_config` é `PUBLIC`, então `ageniza_app` podia limpar `app.user_id` **no meio da própria instrução** (dentro do subselect da cláusula `SET`, que o Postgres avalia depois da `USING` e antes do trigger). Hoje isso não é explorável porque a `WITH CHECK`, reavaliada depois com o GUC já vazio, ainda barra — mas a segurança do trigger passava a depender desse detalhe de ordem de avaliação, não de uma verificação própria.

**Correção.** O trigger deixou de ser `security definer` (roda como quem chama, `security invoker`, o padrão) e o critério do early return trocou de "há `app.user_id`?" para "`current_user = 'ageniza_app'`?". `current_user` é o papel da própria conexão — imutável no meio de uma instrução, ao contrário do GUC — e diferencia exatamente o que importa: o dono do schema (migrations, fixtures de teste, e qualquer função `security definer` de sua propriedade, `accept_invitation` incluída) sempre contorna este trigger, como já contorna a RLS da tabela; só uma instrução executada como `ageniza_app` é sempre checada, e nenhum SQL que `ageniza_app` possa emitir muda o papel da própria conexão. As funções chamadas de dentro do trigger (`has_agency_permission`, `is_agency_owner`, `is_admin_role`) continuam `security definer` com `execute` para `ageniza_app`, então a superfície de autorização não muda.

**Fica para a API (issues [#97](https://github.com/Nocrato-Tech/ageniza/issues/97)/[#98](https://github.com/Nocrato-Tech/ageniza/issues/98)):** mapear os erros de RLS/trigger (42501) para 403 em vez de 500, inclusive no reenvio de convite de admin por quem não tem `colaborador.atribuir_admin`; e as regras "ninguém altera o próprio papel", "ninguém remove a si mesmo" e "reativar exige `role_id` novo no corpo", que a #94 nunca cobriu no banco.

---

## 2026-09-24 — Proteções de integridade do quadro, e a que não deve existir

**Contexto.** O material do Notion listava quatro proteções para a tela de colaboradores. Uma delas custa caro e protege algo que já está garantido.

**Decisão.** Três valem:

1. **O Owner não é removido nem tem o papel alterado por esta tela.** Transferência de posse é fluxo próprio, e não existe hoje.
2. **Ninguém altera o próprio papel**, nem o Admin.
3. **Ninguém remove a si mesmo.**

E a quarta é **descartada**: "a agência nunca fica sem administração válida". O Owner tem acesso total por posse, não por papel, e não pode ser removido por esta tela — então a agência nunca fica sem administração, aconteça o que acontecer com os Admins. Implementar "não pode remover o último Admin" custaria uma contagem sob concorrência para proteger algo que a posse já garante, e contagem sob concorrência é exatamente a classe de defeito da #59.

**Consequência.** Quem remover o último Admin deixa a agência administrável apenas pelo Owner, o que é um estado legítimo e não um defeito.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

---

## 2026-09-24 — A listagem de colaboradores estreia o contrato de listagem

**Contexto.** Nenhuma rota do produto lista nada. Esta é a primeira, e a sessão 0 fixou teto global de 100 com tamanho padrão declarado por rota.

**Decisão.** **24 por página, ordenado por nome ascendente.** Vinte e quatro é múltiplo de 3 e de 4, então a grade de crachás fecha em qualquer largura sem deixar linha quebrada. Ordem alfabética, não data de entrada: numa tela onde se procura uma pessoa específica, é a única ordem em que quem procura sabe onde olhar.

Busca por **nome e e-mail**; filtros por **papel** e **cargo**; todos como parâmetros nomeados.

**Convites pendentes ficam em seção separada**, não misturados à equipe. O banco já exige isso de fato: `invitations_select` pede `colaborador.convidar`, enquanto **todos** veem a equipe — na mesma lista, a mesma tela mostraria quantidades diferentes para pessoas diferentes, e "página 2" passaria a depender de quem olha.

**Quem foi removido fica fora da listagem por padrão**, visível por filtro explícito de status e **apenas para Admin e Owner**. Quem saiu não é informação de equipe, é informação administrativa — e é preciso encontrar a pessoa para reativá-la.

**Consequência.** Toda listagem seguinte copia esta rota como referência. A lista da equipe **nunca tem estado vazio**: quem olha está nela, e uma agência recém-ativada tem o Owner. Busca sem resultado é estado distinto de vazio, e precisa manter visível o termo buscado.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

## 2026-09-25 — O andamento vive num quadro; a issue continua sendo a fonte

**Contexto.** Com quarenta e seis issues abertas em três módulos, a lista deixou de responder as duas perguntas que importam para um time de quatro pessoas: **o que dá para fazer em paralelo agora** e **o que está esperando o quê**. Label não expressa dependência, e menção no texto não expressa parentesco.

**Decisão.** Existe um quadro, [Ageniza — MVP](https://github.com/orgs/Nocrato-Tech/projects/1), vinculado ao repositório. Ele é **visão**, nunca fonte: aceite, dependências e esboço de tela continuam na issue.

- **Parentesco é nativo.** Épico, history e task estão ligados por **sub-issue** do GitHub, não por convenção de texto — a issue mostra a árvore com progresso, e o quadro mostra pai e progresso em campo próprio.
- **O campo `Onda`** é a camada de dependência: onda 1 começa hoje, onda 2 depende da 1 ter entrado. É ele que responde onde quatro pessoas trabalham sem fila.
- **`Bloqueio`** distingue esperar **dependência** de esperar **decisão** do dono do produto. Esperar **design** virou coluna, porque fila de designer precisa ser vista de longe, não filtrada.
- **Nove colunas**, terminando em duas que espelham o modelo de branch: *Pronto para subir* é mergeado em `develop`, *Em produção* é promovido para `main`.

O Projects novo só existe em nível de organização — projeto dono por repositório era o Projects clássico, descontinuado. O nosso está vinculado ao repositório, o que o faz aparecer na aba dele.

**Consequência.** O quadro só diz a verdade se quem pega uma task se atribuir a ela, e se quem descobre uma dependência nova atualizar a onda. Isso é disciplina, não automação. Em troca, "o que posso pegar agora" deixa de ser uma pergunta feita a outra pessoa.

**Origem.** Decidido em sessão. **Substituída em parte em 2026-09-28**, quanto ao que a coluna *Design* significa: ela deixa de ser a fila de telas esperando o designer e passa a receber telas já mergeadas para refino (ver a entrada de 2026-09-28, ao fim). Deixa de valer também a frase do bullet de `Bloqueio` sobre esperar design ("Esperar **design** virou coluna"): a tela não espera mais o designer, então esperar design não existe como bloqueio. As nove colunas e a distinção de `Bloqueio` entre dependência e decisão continuam valendo.

---

## 2026-09-25 — Issue fecha no merge em `develop`, e isso significa "feito", não "no ar"

**Contexto.** O GitHub fecha uma issue referenciada apenas quando o pull request entra na **branch padrão**, que aqui é `main`. Todo pull request de trabalho vai para `develop`, então `Closes #123` **nunca disparou** neste repositório — a #85 foi implementada, mergeada, e continuou aberta sem ninguém notar. Com dezenas de tasks, o quadro mostraria como pendente um monte de trabalho pronto, e deixaria de ser confiável.

**Decisão.** O workflow `Close referenced issues` fecha as issues referenciadas no corpo do pull request quando ele é mergeado em `develop`. Aceita as duas línguas — `Closes`, `Fixes`, `Resolves`, `Fecha`, `Encerra` —, ignora menção solta e ignora referência dentro de bloco de código, porque exemplo em documentação não é intenção. A lógica fica em `scripts/ci/closing-references.mjs`, com teste.

**Issue fechada significa "feito e revisado", não "em produção".** O card permanece em *Pronto para subir* até a promoção para `main` movê-lo para *Em produção*: quem quer saber o que está no ar olha a coluna, não o estado da issue.

**Consequência.** A alternativa — fechar só na promoção para produção — exigiria um **token pessoal guardado como secret**, porque o `GITHUB_TOKEN` padrão não escreve em projeto de organização. Uma credencial a mais para rotacionar, por uma diferença de poucos dias, num sinal que a coluna já dá. O movimento `develop → Pronto para subir` sai de graça pela automação nativa do Projects.

**Origem.** Decidido em sessão.

---

## 2026-09-26 — Escopo do módulo de clientes: o cliente e a casca, nas duas frentes

**Contexto.** O bloco 0 da entrevista levantou, para a área da agência, uma listagem em cards e um detalhe com abas — Geral, Conteúdos, Tarefas, Estudo de marca e Relatórios —, e para o portal um cliente dono do negócio que entra para acompanhar o calendário, aprovar, comentar, ver relatório e o estudo da própria marca. A maior parte disso depende de entidades que não existem: não há conteúdo, tarefa, atribuição nem comentário no banco, e `ClientAssignment`, citado em decisões anteriores, também não existe em nenhuma migration. Ao mesmo tempo, `clients` só tem policy de `SELECT`: hoje não há como criar um cliente pelo produto, embora a rota de convidar usuário de cliente já exista.

**Decisão.** Clientes entrega **o cliente e a casca**: cadastro, foto, arquivar e reativar, listagem em cards com busca, página de detalhe com as abas, estudo de marca, e as pessoas do portal — convidar, reenviar, cancelar, remover. As abas **Conteúdos**, **Tarefas** e **Relatórios** e os indicadores do card — pendentes, em revisão, atrasados — nascem com **área reservada**, preenchida pelas entrevistas de Conteúdo, Tarefas e Financeiro/Dashboard.

O **portal do cliente nasce neste módulo** como casca: entrada, onboarding de boas-vindas, navegação e estudo de marca. Calendário, aprovação e comentário de conteúdo chegam com Conteúdo.

**Consequência.** O que o bloco 0 levantou e não pertence a Clientes é o **bloco 0 já colhido da entrevista de Conteúdo**, e não deve ser perguntado do zero lá: calendário editorial com arrastar para outra data e criar numa data; card com miniatura e hover detalhado; modal de conteúdo com abas Descrição e Atribuição; tipos reels, vídeo longo, VSL e carrossel; alerta de prazo a dois dias e de atraso; capa de vídeo; prévia ao vivo do post e simulador de feed do Instagram com grade de nove e navegação entre períodos; conteúdo sempre ligado a uma pasta de mídia; tarefas por conteúdo com responsável, prazo e percentual de conclusão.

Fica em aberto, com gatilho: **o portal não é liberado a cliente real antes de Conteúdo entregar a aprovação** — um portal cujo único conteúdo é o estudo de marca não entrega o valor pelo qual o cliente entra.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — O portal nunca mostra o trabalho interno, e quem garante é a RLS

**Contexto.** O cliente entra no portal para ver o que agrega valor a ele — calendário, aprovação, relatório, marca —, não o andamento bruto da equipe.

**Decisão.** Regra **pré-decidida para o módulo de Tarefas**: tarefa, responsável interno e prazo interno **nunca são dados do portal**. A garantia é da RLS, não da tela — nenhuma tabela de trabalho interno tem policy que um vínculo de cliente satisfaça.

**Consequência.** Esconder só na interface deixaria o dado alcançável pela API, e o vazamento só apareceria nas ferramentas do navegador de alguém. Quando o portal precisar de um sinal derivado do trabalho interno — "em produção", "atrasado" —, ele é exposto pelo objeto que o cliente enxerga, o conteúdo, nunca pela tarefa.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — Integração com a Meta fica fora do MVP, e publicar e medir decidem juntos

**Contexto.** O relatório imaginado para o cliente inclui retenção por conteúdo e resultado de anúncio. Os dois vêm da API da Meta, e o sistema não tem integração com rede social alguma — nem para publicar, embora `product-overview.md` descreva a plataforma como quem publica.

**Decisão.** Métrica externa **fica fora do MVP**. O relatório do MVP é de **dado interno** — entregue, atrasado, o que foi feito no mês — e é decidido quando Conteúdo e Tarefas existirem. Gatilho da integração: **a decisão de publicar pela plataforma**, que exige a mesma conexão.

**Consequência.** Publicar e medir usam a mesma conexão com a conta do cliente — OAuth, revisão de app pela Meta, token por cliente —, e decidi-los separados faria o cliente conectar a conta duas vezes. A aba Relatórios nasce reservada.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — O cliente sugere sobre a marca por conversa em thread, e esse é o modelo de conversa do produto

**Contexto.** O cliente precisa sugerir alterações no estudo da própria marca já no MVP. Conteúdo vai precisar da mesma capacidade para o cliente conversar com a equipe sobre um post, e o primeiro módulo a resolver isso define o formato que o segundo copia.

**Decisão.** Cada seção do estudo de marca tem uma **thread de comentários**. O cliente escreve, a agência responde, edita o estudo se concordar e marca a thread como resolvida. **O cliente nunca edita o estudo** — ele conversa sobre ele.

Foram descartadas: a **proposta de alteração**, em que o cliente edita e a agência aceita ou recusa, por exigir estado de revisão, diff e conflito para servir a um único lugar; e o **campo livre de sugestões**, que não tem resposta nem fechamento.

**Consequência.** Clientes cria o primeiro mecanismo de conversa entre cliente e equipe, e **Conteúdo reaproveita o mesmo formato** para os comentários de post — não inventa um segundo. A forma de armazenar e de autorizar essa conversa passa a ser decisão com peso de modelo, e é tratada nos blocos 3 e 7 desta entrevista.

**Origem.** Decidido em sessão (entrevista do módulo de clientes). **Pendente de validação** — aceita para ser validada na prática.

---

## 2026-09-26 — Contato do cliente é cadastro; acesso ao portal é vínculo, e pode haver vários

**Contexto.** Na conversa, "o cliente" significava ao mesmo tempo a empresa, o contato do dono e a conta que entra no portal. O sistema já trata o acesso como vínculo por pessoa — `client_memberships` com `unique (client_id, user_id)` —, e nada limitava a um.

**Decisão.** São duas coisas independentes:

- **Dados do cliente** — empresa e contato do dono — são **cadastro**, preenchido pela agência. Existem antes de qualquer convite e continuam existindo se ninguém nunca aceitar.
- **Acesso ao portal** é convite para um e-mail, que vira vínculo quando aceito. O e-mail do convite pode ou não ser o do contato.

Um cliente pode ter **várias pessoas no portal, todas com o mesmo acesso**. Papel dentro do portal fica fora do MVP.

**Consequência.** Nenhuma regra nova de banco para limitar o vínculo. O dado de contato nunca é derivado da conta global de quem aceitou — se fosse, a pessoa o editaria no próprio perfil e a agência perderia o controle do cadastro. Quando o dono quiser passar a aprovação a outra pessoa, a resposta é convidá-la.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — Permissões de clientes: todos veem todos, e cadastrar é administrativo

**Contexto.** O v1 diz que todo colaborador enxerga Clientes. A alternativa era restringir cada colaborador aos clientes atribuídos a ele — mas a tabela de atribuição não existe, e `clients_select` libera leitura a qualquer membro da agência.

**Decisão.** Todo colaborador vê **todos** os clientes da agência. O catálogo do módulo:

| capacidade | permissão |
|---|---|
| Ver listagem, detalhe e estudo de marca | `cliente.visualizar` |
| Editar cadastro e estudo de marca, responder e resolver thread | `cliente.operar` |
| Cadastrar cliente novo | `cliente.cadastrar` |
| Arquivar e reativar | `cliente.arquivar` |
| Convidar pessoa para o portal | `cliente.convidar_usuario` *(já existe)* |
| Reenviar e cancelar convite de portal | `convite.reenviar` · `convite.cancelar` *(já existem)* |
| Remover pessoa do portal e reativá-la | `cliente.remover_usuario` |

**Cadastrar é administrativo**, separado de `operar`: cliente novo é compromisso comercial, e a cobrança prevista é por número de clientes.

No portal, a pessoa do cliente abre e responde thread, mas **só a agência resolve** — resolvida significa "a agência tratou", e o cliente fechando a própria sugestão apagaria esse sinal.

**Consequência.** Restringir visibilidade por atribuição fica em aberto, com gatilho: **a primeira agência precisar esconder um cliente de parte da equipe**. Atribuir responsável nasce em Conteúdo e Tarefas; usar a atribuição para restringir leitura é decisão à parte, local à RLS de `clients`.

`convite.reenviar` e `convite.cancelar` valem para os dois tipos de convite, e `invitations_select` não separa por tipo: quem recebe `cliente.convidar_usuario` enxerga também os convites pendentes de colaborador. Enquanto só o Admin detiver as duas famílias, isso é invisível.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — Preset de clientes: o Gestor opera e cadastra, só o Admin arquiva e gerencia o portal

**Contexto.** A linha de preset do módulo é obrigatória na SPEC. O ponto sensível era o acesso ao portal: dar ao Gestor de conta as permissões de convite de cliente daria a ele, pelas policies atuais, leitura e cancelamento de convites de colaborador.

**Decisão.**

| permissão | Admin | Gestor de conta | Produção | Vendas | Financeiro |
|---|---|---|---|---|---|
| `cliente.visualizar` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cliente.operar` | ✅ | ✅ | — | — | — |
| `cliente.cadastrar` | ✅ | ✅ | — | — | — |
| `cliente.arquivar` | ✅ | — | — | — | — |
| `cliente.convidar_usuario` | ✅ | — | — | — | — |
| `cliente.remover_usuario` | ✅ | — | — | — | — |

Produção lê o estudo de marca para trabalhar, mas não o edita nem responde o cliente. Vendas não cadastra: quem cadastra é quem vai atender. Arquivar corta o portal na requisição seguinte — é fim de contrato, e fica com o Admin.

**Consequência.** As permissões de convite continuam compartilhadas entre os dois tipos, e nada estrutural acontece agora. Separá-las por tipo reescreve as policies de `insert`, `update` e `select` de `invitations` — **estrutural**, por atravessar RLS de outro módulo. Gatilho: **o primeiro Gestor precisar convidar pessoa de cliente sem o Admin**. Vendas volta à mesa quando Pipeline entrar.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — Campos do cliente e forma do estudo de marca

**Contexto.** `clients` tem apenas `name` e `status`. O bloco 0 pediu dados da empresa, contato do dono, foto e um estudo de marca "quanto mais detalhado, melhor", com personas múltiplas e sugestão do cliente por thread.

**Decisão.**

- **Cadastro**: nome de exibição, foto; razão social, CNPJ **ou** CPF, segmento, site, @ do Instagram; nome, telefone/WhatsApp e e-mail do contato do dono. **Só o nome é obrigatório** — o cadastro começa numa ligação e se completa depois. Valor de contrato, início e forma de pagamento ficam no Financeiro.
- **Nome único entre os clientes ativos da agência**, sem diferenciar maiúsculas. Arquivado não bloqueia o nome. **CNPJ não é único**: a mesma empresa pode ser atendida como duas marcas.
- **Estudo de marca em seções fixas do produto**: Branding, Tom de voz, Cores, Posicionamento, Arquétipo, Personas e Observações. Texto livre, exceto **Cores** — lista de nome e código — e **Arquétipo** — um dos doze clássicos. Seções configuráveis por agência e documento único foram descartados: o primeiro é um construtor de formulário, o segundo tira a âncora da conversa e impede medir preenchimento.
- **Personas**: várias por cliente, com nome, descrição, dores, desejos e objeções. Persona retirada é **arquivada**, porque pode ter conversa pendurada.
- **Conversa**: várias threads por seção e por persona. Comentário **não se edita nem se apaga**, nem pelo autor. A thread guarda quem resolveu e quando, e **comentário novo em thread resolvida a reabre**.
- **Histórico do estudo**: só quem alterou por último e quando, por seção. Versões ficam fora; a thread já registra o porquê.

**Consequência.** O @ do Instagram mora no cliente, e o simulador de feed de Conteúdo o lê daqui. A seção fixa é o que torna possível o "quanto do estudo está preenchido" na aba Geral. Onde esses campos vivem — colunas novas em `clients`, que é `alter table` em tabela implantada, ou tabelas próprias — é decidido no bloco de impacto estrutural desta entrevista.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — Estados de cliente, de acesso ao portal, de thread e de persona

**Contexto.** O banco já corta o portal de cliente arquivado — `requireClientAccess` devolve 404 — e já recusa o aceite de convite de cliente arquivado. Não mexe nos vínculos ao arquivar, e um convite aceito por alguém removido reativa o vínculo antigo.

**Decisão.**

- **Arquivar o cliente** corta o portal na requisição seguinte, **revoga os convites pendentes** no ato e **preserva os vínculos**, de modo que reativar devolve o acesso a quem já tinha. Não há pré-condição: arquiva-se com thread aberta, persona ou o que houver. Revogar evita que um link antigo volte a valer sozinho na reativação.
- **Cliente arquivado é somente leitura** na área da agência: aparece pelo filtro de status e mostra tudo, mas não se edita, não se comenta e não se convida. A única ação é **reativar**.
- **Pessoa do portal**: `active → removed` tira o acesso dela na requisição seguinte, sem afetar as demais. Volta por **reativação direta** pelo Admin, como em Colaboradores; o caminho por convite novo continua existindo.
- **Thread**: aberta ↔ resolvida. Só a agência resolve; **comentário novo reabre**, de qualquer lado. Não existe ação separada de reabrir — o único jeito é dizer por quê.
- **Persona**: ativa ↔ arquivada. Arquivada some do estudo que o cliente vê, suas threads ficam somente leitura, e quem tem `cliente.operar` a desarquiva.

**Consequência.** Arquivar cliente com conteúdo agendado é pergunta que só existe quando Conteúdo existir, e é tratada entre as regras invioláveis desta entrevista.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — Regras invioláveis de clientes, garantidas pelo banco

**Contexto.** O módulo abre a primeira superfície em que uma pessoa de fora da agência — o cliente — lê e escreve. Regra que vive só na rota é furada pela primeira rota nova que a esquecer, e Conteúdo vai criar várias.

**Decisão.** Garantidas pela RLS, por *grant* ou por índice, não apenas pela API:

1. Pessoa do portal **nunca lê nada de outro cliente**, nem da mesma agência — cadastro, estudo, personas e threads.
2. Colaborador **sem vínculo de cliente não entra no portal**, nem Admin nem Owner.
3. Pessoa do portal **nunca escreve no estudo de marca nem nas personas**; só comenta, e só nas threads do próprio cliente.
4. **Comentário não tem `UPDATE` nem `DELETE`** para o papel da aplicação.
5. **Cliente arquivado não aceita escrita** — cadastro, estudo, personas, threads e convites. A policy confere o status.
6. **Nome único entre os ativos da agência**, por índice único parcial sem diferenciar maiúsculas; nunca por consulta prévia, que perde para a concorrência.
7. **Só a agência resolve thread**: a policy exige `cliente.operar`, que vínculo de cliente nunca satisfaz.
8. **Não existe thread interna.** Toda thread do estudo é conversa com o cliente. Uma marca de "interna" numa tabela que o portal lê é o vazamento mais provável do módulo; discussão interna acontece fora, ou em Tarefas quando existir.

E duas regras de comportamento:

- **Reativar um cliente cujo nome já está em uso entre os ativos é recusado**, com mensagem clara; alguém renomeia um dos dois antes. Renomear sozinho mudaria um dado que o cliente vê no portal sem a agência perceber.
- **O portal lê o próprio cadastro**, somente leitura — `clients_select` já entrega a linha inteira ao vínculo de cliente.

**Consequência.** Pela última regra, **nenhum campo interno da agência sobre o cliente** — nota, avaliação, risco de churn — pode morar em `clients`. Se existir um dia, nasce em tabela própria que o portal não alcança. Cada item numerado vira teste de integração contra o banco.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — Contrato de cliente termina com aviso prévio, e o conteúdo além da data é cancelado

**Contexto.** Ao pré-decidir o que acontece com conteúdo agendado de cliente arquivado, a regra dada foi "só publica até o começo da desativação; o que vier depois se cancela". Isso pressupõe uma desativação com data futura, que a decisão de estados não previa — ali, arquivar era sempre imediato.

**Decisão.** O cliente pode ter uma **data de encerramento**, registrada por quem tem `cliente.arquivar`. Até ela tudo funciona normalmente — **inclusive o portal**, porque o cliente ainda está no período contratado —, com aviso visível na área da agência. Na data, um **job arquiva o cliente**, com os mesmos efeitos do arquivamento manual. O encerramento pode ser **desmarcado** até a data. Arquivar na hora continua existindo, e equivale ao encerramento com a data de hoje.

Regra **pré-decidida para Conteúdo**: conteúdo com publicação **até** a data de encerramento publica normalmente; o que estiver **depois** é **cancelado** quando o cliente é arquivado. Sai do agendamento e **não volta sozinho** na reativação — a agência reagenda o que quiser. Cancelado não é excluído: o conteúdo continua guardado, com esse status. Cliente arquivado não executa nenhuma ação externa em nome dele, como já vale para agência suspensa.

Foram descartados o arquivamento sempre imediato, que obrigaria alguém a lembrar do dia certo, e o conteúdo suspenso que volta sozinho, porque um post reaparecendo meses depois com data vencida é pior que reagendar.

**Consequência.** É o **primeiro job agendado de negócio** do sistema, e ele esbarra na decisão de que o worker não contorna a RLS: precisa agir como alguém. Com que identidade ele arquiva é tratado no bloco de impacto estrutural desta entrevista.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — A área de clientes é um painel de triagem, e o detalhe nasce com todas as abas

**Contexto.** Quem abre Clientes na agência é, tipicamente, o Gestor de conta com oito a vinte clientes, várias vezes por dia, perguntando "qual cliente precisa de mim agora?". No MVP, porém, os sinais que responderiam isso — pendente, em revisão, atrasado — só existem depois de Conteúdo e Tarefas.

**Decisão.**

- **Intenção da área da agência**: o verbo é **triar**. A tela funciona como painel de plantão — o cliente com problema salta aos olhos, o cliente em dia fica quieto.
- **Intenção do portal**: o dono do negócio, sem familiaridade com ferramenta de agência, entrando pelo celular poucas vezes por semana para **conferir e aprovar**. Vitrine do trabalho, sem termo técnico, sempre com uma próxima ação óbvia. **O portal é pensado primeiro para celular**; a área da agência, para desktop.
- **Listagem `/clientes`**: 20 por página; ordem padrão **clientes com thread aberta pelo cliente primeiro, depois nome ascendente** — atraso passa a ser o primeiro critério quando Conteúdo existir; busca por nome, razão social e @; filtro de status ativos (padrão) e arquivados. O card mostra foto ou iniciais, nome, @, os selos *encerra em dd/mm*, *N sugestões aguardando* e *convite pendente*, e a faixa de indicadores reservada. Vazio: "Nenhum cliente ainda", com **Cadastrar cliente** para quem tem permissão.
- **Cadastrar** é um modal curto, só com o nome; ao salvar, abre o detalhe do cliente novo, onde **Editar** tem todos os campos.
- **Detalhe `/clientes/:id`**: cabeçalho com foto, nome, @, status e selo de encerramento, **Editar** com `cliente.operar` e o menu **Encerrar contrato** e **Arquivar/Reativar** com `cliente.arquivar`. **Todas as abas nascem no MVP** — Geral, Conteúdos, Tarefas, Estudo de marca, Relatórios e Acessos, esta só para quem tem `cliente.convidar_usuario`. As que dependem de módulo futuro nascem como **esqueleto**, preenchidas conforme os módulos entram.

**Consequência.** A ordem por "espera resposta" é o que torna a tela útil antes de Conteúdo. Aba esqueleto não pode mostrar dado fictício nem controle que não funciona: mostra que a área existe e o que virá, e nada que pareça quebrado. O custo aceito é conviver com abas sem uso até seus módulos entrarem.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — O portal nasce com navegação de celular, tour do que funciona e sem notificação

**Contexto.** O portal não tem tela nenhuma, e a única rota de cliente é a que marca o onboarding como visto. O sistema só envia e-mail de autenticação; não existe notificação de nenhum tipo.

**Decisão.**

- **Rotas** `/portal/:clienteId/...`, em português como as de autenticação. **Barra inferior** com Início, Calendário, Marca e Relatórios; Calendário e Relatórios nascem como esqueleto. Quem acessa mais de um cliente troca pelo menu de conta já decidido em auth.
- **Início**: saudação com o nome do cliente e a próxima ação óbvia — no MVP, "a agência respondeu N sugestões suas" ou "conheça o estudo da sua marca" —, com o espaço dos conteúdos a aprovar reservado.
- **Onboarding**: tour guiado na primeira entrada daquela pessoa naquele cliente, usando o `onboarding_seen_at` que já existe; pode ser pulado e revisto pelo menu de conta. **Mostra só o que funciona** — no MVP, Marca e como sugerir.
- **Estudo de marca no portal**: seções em leitura, em linguagem de cliente; **Sugerir** e as conversas em cada seção; seção não preenchida diz "sua agência está preparando esta parte"; o cliente vê nome e foto de quem respondeu.
- **Aba Acessos** na agência: pessoas no portal com Remover e Reativar, removidas num filtro; convites pendentes com Reenviar e Cancelar; Convidar é um modal só com o e-mail; vazio "ninguém deste cliente acessa o portal ainda", com Convidar. O mesmo desenho da seção de convites de Colaboradores.
- **Sem notificação no MVP**: cada lado descobre a conversa dentro do produto — o selo na listagem da agência, o aviso no Início do portal.

**Consequência.** Notificação fica em aberto, com gatilho: **Conteúdo fechar o fluxo de aprovação** — é ali que o cliente precisa ser chamado de fora, e notificação é mecanismo transversal (destinatário, preferência, agrupamento) que não deve ser desenhado para o caso menos urgente. O risco aceito é o cliente sugerir e só ver a resposta na entrada seguinte.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — ESTRUTURAL: os campos do cliente entram como colunas em `clients`

**Esta é uma mudança estrutural**, pelo primeiro critério de [structural-changes.md](structural-changes.md): altera uma tabela que já existe. Registrada antes de qualquer implementação.

**Contexto.** O cadastro decidido nesta entrevista — empresa, contato do dono, @ do Instagram, foto —, a data de encerramento, o "quem alterou por último" e a unicidade de nome entre ativos não cabem nas duas colunas atuais de `clients`. A alternativa era uma tabela 1:1, `client_profiles`, para não tocar a tabela implantada.

**Decisão.** **Colunas novas em `clients`**, todas anuláveis, sem backfill, mais o **índice único parcial** de nome entre ativos, sem diferenciar maiúsculas. `clients` ganha também as policies de `INSERT` e `UPDATE`, que hoje não existem. O estudo de marca, as personas e as threads nascem em tabelas próprias.

**Consequência.** O cadastro **é** o cliente, e a tabela 1:1 obrigaria um join em toda leitura só para evitar um `alter table` que agora custa pouco: não há dado real em lugar nenhum, porque tudo é local até o deploy. A migration dispara o gate de CI, e esta entrada é o que o satisfaz. Como o portal lê a linha inteira de `clients`, vale a regra já decidida: nenhum campo interno da agência sobre o cliente mora aqui.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

**Implementação.** PR #162, migration `20260928000100_clients_module.mjs`.

---

## 2026-09-26 — ESTRUTURAL: a conversa com o cliente é uma tabela de threads por cliente, com assunto tipado

**Esta é uma mudança estrutural**, pelo critério de formato que outras rotas copiam: é o primeiro mecanismo de conversa entre cliente e equipe, e Conteúdo vai reaproveitá-lo.

**Contexto.** As threads do estudo de marca e, depois, as de conteúdo precisam da mesma RLS — só a agência e as pessoas daquele cliente — e da mesma contagem de "conversas aguardando resposta" que alimenta o card da listagem.

**Decisão.** **Uma tabela de threads** com `client_id` sempre preenchido e o assunto em **colunas tipadas com chave estrangeira** — a seção do estudo ou `persona_id` —, com restrição de exatamente um assunto por thread. Os comentários pendem da thread. A RLS é uma só, pelo `client_id`.

Descartadas: **uma tabela por assunto**, que duplicaria RLS e contagem a cada módulo; e a **polimórfica** com `subject_type` e `subject_id` sem chave estrangeira, que perde integridade e obriga a RLS a descobrir o dono do assunto em tempo de consulta.

**Consequência.** **Conteúdo acrescenta uma coluna `content_id`** a esta tabela — `alter table` aditivo que também passará pelo gate, e que já fica anunciado aqui. "Quantas conversas esperam resposta neste cliente" continua uma consulta só depois disso.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — ESTRUTURAL: arquivar cliente é uma função `security definer` de escopo único, usada pelo job e pela rota

**Esta é uma mudança estrutural**, por mudar **como a autorização é avaliada** para trabalho sem requisição: abre uma exceção à decisão de 18/09 de que o worker age como um usuário e não contorna a RLS.

**Contexto.** O encerramento agendado precisa de um job que arquive o cliente na data. Pelo modelo atual ele agiria como quem agendou, e o defeito já registrado para a mídia se repetiria com consequência pior: se essa pessoa perder a permissão, o job vira no-op silencioso, **o contrato não se encerra e o portal continua aberto**. Havia um segundo acoplamento: arquivar revoga convites pendentes, o que exige permissão sobre `invitations`, que `cliente.arquivar` não implica.

**Decisão.** Uma função `security definer` que faz **uma coisa só**: arquiva o cliente, revoga os convites pendentes dele e grava um evento em `audit.events`. O **job** a chama apenas para clientes com data de encerramento vencida. A **rota de arquivar** chama a mesma função, depois de a API conferir `cliente.arquivar` — os dois caminhos têm exatamente o mesmo efeito.

**Consequência.** A regra "o worker não contorna a RLS" passa a ter uma exceção documentada: **função de escopo único, auditada, chamável só para o efeito que nomeia** — nunca uma identidade de serviço com acesso amplo. Esse é o **modelo que a publicação agendada de Conteúdo deve seguir**, e qualquer exceção nova precisa ter a mesma forma. O defeito da mídia, que continua agindo como o usuário, não é corrigido por esta decisão.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — Cliente na mídia fica para Conteúdo, com diagnóstico mais grave que o registrado

**Contexto.** A estrutural conhecida dizia que `media_assets` é escopado só por agência. A leitura das policies mostra mais: o `SELECT` de `media_assets` exige `midia.enviar`, então **o portal não vê mídia nenhuma**, nem a própria. E Clientes não usa `media_assets` — a foto do cliente vai para o armazenamento de identidade.

**Decisão.** A estrutural continua **pendente** e é decidida no **bloco de impacto estrutural da entrevista de Conteúdo**, que é o gatilho. A forma — cliente por arquivo, por pasta ou pelo conteúdo que usa o arquivo — depende do modelo de pastas que só Conteúdo vai desenhar.

**Consequência.** Qualquer que seja a forma, ela terá de dar ao vínculo de cliente leitura sobre mídia, que hoje nenhuma policy concede — é migration mais RLS nova, e continua estrutural.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-26 — A foto do cliente vive no armazenamento de identidade

**Contexto.** O armazenamento de identidade, decidido em Colaboradores, é separado da mídia, não consome quota e já previa servir a identidade visual de portal.

**Decisão.** A foto do cliente vai para esse armazenamento, não para `media_assets`.

**Consequência.** A foto do cliente **depende da issue #100**, que cria o armazenamento de identidade; isso entra como dependência no recorte deste módulo. Avatar decorativo não disputa quota com vídeo de cliente.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

---

## 2026-09-28 — A tela é implementada a partir do esboço, e o designer refina a tela que já funciona

**Contexto.** A entrada de 2026-09-24 fixou a sequência esboço → design → código: a task de `escopo:web` nascia pronta e ficava parada em `aguardando-design` até o designer entregar a tela. Ela mesma registrou o custo — a entrega do designer entra no caminho crítico de toda tela, num prazo que não depende de nós — e o custo se realizou: em 2026-09-28 há 27 tasks de interface abertas com esse rótulo, das SPECs de autenticação, colaboradores e clientes, e ao menos três delas não dependem de nenhuma outra task e esperam só o design.

**Decisão.** A sequência passa a ser **esboço → código → refino**.

- A tela de `escopo:web` é **implementada a partir do esboço e da tabela de elementos da issue**, com o design system do produto, definido na página [UI System — Figma, Design Tokens & CSS](https://app.notion.com/p/3d886d2ba8b08172a3fbcc31e1548c31) do Notion, filha de "Branding & Design System — Ageniza": os tokens e os componentes são os definidos nela. Nada de componente ou estilo avulso, nada de layout inventado. O esboço deixa de ser briefing e passa a ser a **especificação da tela**, e a primeira implementação cobre todos os estados que ele lista.
- O designer **refina a tela já funcionando**, depois do merge. No quadro, a coluna **Design** passa a receber telas **já mergeadas** para refino, marcadas com o label **`refino-design`**, e **Design review** passa a ser o refino entregue, à espera de aprovação.
- **`aguardando-design` deixa de existir, e falta de design não bloqueia mais.** A task de interface espera a dependência real — normalmente a task de API que a alimenta, declarada em "Depende de" — **e a fundação do design system no código**, o segundo ponto de "Fica em aberto". Sem essa fundação nenhuma tela consegue cumprir "só tokens e componentes do design system". O campo **Bloqueio** do quadro tem um valor só, então vale a precedência: **enquanto a fundação estiver pendente, toda task de tela fica com Bloqueio `decisão`**, e a dependência técnica continua visível só em "Depende de". **Atualizado em 2026-09-28** pela entrada seguinte: a parte A da fundação (documento, tokens em CSS, `Button` no vocabulário novo) **basta** para tirar as 27 tasks do Bloqueio `decisão` — a saída não esperava mais decisão nenhuma além dessa, e passa a ser automática quando o PR que traz a parte A é mergeado em `develop`. A página viva em `/design-system` (parte B) não é pré-requisito.
- Da entrada de 2026-09-24 continuam valendo o esboço em nível de wireframe, sem cor, tipografia ou espaçamento; as tasks de web escritas junto com as demais, com o esboço dentro do corpo; e `escopo:api` e `escopo:db` em paralelo.

**Consequência.** O risco aceito é o **retrabalho quando o refino mudar estrutura**: hierarquia, componentes ou navegação de uma tela já codificada e testada que o designer decida refazer. O custo deixa de ser espera e passa a ser código refeito, e isso é escolha, não descuido: em troca, o designer sai do caminho crítico de toda tela. A frase "ninguém codifica tela a partir do wireframe", da entrada anterior, deixa de valer.

As issues que hoje carregam `aguardando-design` deixam de esperar design e passam a esperar as dependências que já declaram **e a fundação do design system**. Isso vale para as 27, inclusive as que não dependem de nenhuma outra task: todas ficam com Bloqueio `decisão` enquanto a fundação estiver pendente, e nenhuma deve ser pega antes de ela existir no código.

**Fica em aberto**, cada ponto com o seu gatilho:

- **Quem aplica o refino, em qual issue e PR, e onde fica o card enquanto a tela mergeada também espera a promoção.** Não é decidido aqui. O `pnpm board:released` só move o que está em *Pronto para subir*; um card parado em *Design* na promoção não iria para *Em produção*. Gatilho: a primeira tela mergeada que chegar à coluna Design. Até lá, `refino-design` e a coluna descrevem um estado, não um procedimento.
- **A fundação do design system no código.** Tratada na entrada seguinte, de 2026-09-28 ("O repositório é a fonte do design system, com documento e página viva"), que registra o que o dono do produto decidiu, o que a parte A entrega e o que continua em aberto, cada ponto com o seu gatilho.
- **Como fica, na primeira implementação, um ponto que a SPEC deixou para o designer.** A seção de UX das SPECs entrega decisões ao designer que, no fluxo novo, chegam à tela sem dono: em `specs/clientes.md`, a navegação do portal no desktop ("a lateral ou o topo — decisão do designer") e os rótulos das seções do portal ("são do designer"); em `specs/auth.md`, o esboço "para o designer desenhar", sem cor, tipografia nem espaçamento, que dependem da fundação do ponto anterior. Não é decidido aqui: as SPECs não foram alteradas, e "nada de layout inventado" não diz o que fazer com um ponto que a SPEC deixou em aberto. **Pendente de decisão do dono do produto.** Gatilho: a task #141, ou a primeira task que esbarrar em um ponto assim, ser pega.

**Origem.** Decidido em sessão (orquestração do projeto). Substitui a entrada de 2026-09-24 quanto à ordem e ao rótulo `aguardando-design`, e a de 2026-09-25 quanto ao que a coluna *Design* significa. **Atualizada em 2026-09-28** pela entrada seguinte, sobre o repositório como fonte do design system: a referência à página do Notion no primeiro item da decisão passa a ser [`docs/design-system.md`](../design-system.md), e o ponto sobre a fundação passa a ser tratado lá.

---

## 2026-09-28 — O repositório é a fonte do design system, com documento e página viva

**Contexto.** A entrada anterior deixou pendente a fundação do design system no código, que precisa existir antes da primeira task de tela. O design system estava especificado numa página do Notion, ["UI System — Figma, Design Tokens & CSS"](https://app.notion.com/p/3d886d2ba8b08172a3fbcc31e1548c31), e o `AGENTS.md` trata o Notion como insumo histórico, nunca como fonte de verdade: a tela seria obrigada a seguir um documento que o próprio repositório não reconhece. No código havia 20 linhas de CSS com as cores escritas direto e um `Button` com `tone`, onde a página definia `variant`.

**Decisão.** O design system **sai do Notion e passa a viver no repositório**, que vira a fonte de verdade dele. Ele tem duas formas:

- um **documento**, [`docs/design-system.md`](../design-system.md), com o conteúdo migrado da página e adaptado aos caminhos e à stack reais;
- uma **página no próprio app** que mostra os tokens e os componentes ao vivo.

A entrega sai em duas partes: a **parte A** traz o documento, os tokens em CSS em `apps/web/src/styles/` e o `Button` de `packages/ui` no vocabulário do documento (`variant`, `size`, `loading`); a **parte B** traz a página viva.

**Consequência.** O `AGENTS.md`, o `CONTRIBUTING.md` e o `module-process.md` passam a apontar o design system para o documento, e a página do Notion vira registro histórico. Os valores vivem nos arquivos de CSS: em divergência entre o documento e o CSS, vale o CSS.

**Os cinco pontos abaixo, deixados em aberto quando esta entrada foi escrita, foram decididos pelo dono do produto ainda em 2026-09-28**, na revisão do PR #157 (parte A):

1. **Confirmado: o repositório é a fonte do design system.** A página do Notion vira registro histórico, nunca mais referência de trabalho — como a "Decisão" acima já registrava, e agora sem ponto em aberto associado.
2. **A Definition of Done de UI (seção 23 do documento) passa a ser critério de aceite de toda task `escopo:web`**, não mais proposta — **sem** o item de paridade com o Figma, removido em vez de reescrito para "quando houver Figma": na sequência esboço → código → refino (entrada anterior), o Figma só entra no refino, depois que a tela já está no ar, então não é critério de aceite da implementação inicial. Seção 23 do documento reescrita de acordo.
3. **Os valores de token propostos na parte A foram aprovados, depois de corrigir os pares que falhavam WCAG AA.** As quatro falhas listadas na seção 20.1 (`text/muted` sobre `bg/hover` nos dois temas e sobre `bg/elevated` no Dark; `text/link` e `text/danger` no Dark sobre `bg/canvas`/`bg/surface`) foram corrigidas ajustando a luminosidade de `color/slate/500` e `color/slate/400` e introduzindo dois primitives-irmãos só de texto (`color/indigo/400` para `text/link` no Dark, `color/red/400` novo para `text/danger` no Dark), sem mudar a matiz de nenhum token nem o valor de `action/primary/bg` ou `action/danger/bg`. A tabela final, com as razões de contraste recalculadas, está na seção 20.1 do documento; `text/link` e `text/danger` ficam restritos a `bg/canvas`/`bg/surface` (não passam sobre `bg/elevated`/`bg/hover` no Dark), registrado no documento em vez de deixados falhando.
4. **A parte A basta para tirar as 27 tasks de tela do Bloqueio `decisão`.** Não espera a parte B: a página viva é conveniência de consulta, não pré-requisito de implementação. A saída do Bloqueio passa a ser automática quando o PR que traz a parte A é mergeado em `develop` — refletido no bullet de Bloqueio da entrada anterior.
5. **A parte B adota shadcn/ui**, copiado para o repositório como base de mecânica e acessibilidade, com as variáveis do shadcn (`--primary`, `--muted-foreground`, `--ring` etc.) como ponte para os tokens Ageniza, como a seção 15 do documento já descrevia. Não fica com mecânica própria.

**Origem.** Decidido pelo dono do produto em sessão, em 2026-09-28, ao aprovar as recomendações apresentadas na revisão dos PRs.

---

## 2026-09-29 — O login aceita o token do convite para quem tem zero contextos

**Contexto.** A entrada de 2026-09-24 ("Credencial correta sem nenhum contexto não cria sessão") diz que a conta continua existindo depois de perder todo contexto, e que "um convite novo para o mesmo e-mail volta a funcionar pelo fluxo de conta existente — não é exclusão, é acesso sem vínculo". Esse fluxo (`POST /invitations/:token/accept`, estado "já tem conta" da tela de convite) exige sessão via `requireSession`, e essa sessão só existe hoje se `POST /auth/login` a criar antes — exatamente o que a mesma entrada de 2026-09-24 passou a negar para quem tem zero contextos. O furo foi encontrado na implementação da issue #68 (PR #164): sem um mecanismo à parte, a própria decisão de 2026-09-24 se contradiz para quem foi removido de tudo e reconvidado.

**Decisão.** `POST /auth/login` aceita um campo opcional `inviteToken`. Quando a credencial é correta e a conta tem zero contextos, a sessão é criada **somente se** `inviteToken` corresponder a um convite **válido** — não usado, não revogado, não expirado (relógio do banco), endereçado ao **mesmo e-mail** da conta (comparação já normalizada, como o resto do código), de agência ativa e, se for convite de cliente, de cliente ativo — usando a mesma checagem de validade que o módulo de convites já usa (`app_private.invitation_by_token_hash`), nunca duplicada. Caso contrário, a resposta é o `403 NO_CONTEXT_ACCESS` de sempre. Um token ausente, inválido, de e-mail diferente, expirado, revogado ou de agência/cliente inativo produz **exatamente a mesma resposta**, byte a byte: `inviteToken` nunca serve para descobrir se um convite ou uma conta existe.

A sessão criada assim continua **sem contexto** até o convite ser de fato aceito. `GET /me/contexts/resolve` continua encerrando qualquer sessão sem contexto na sua própria passagem (2026-09-24), então a tela de convite (issue #76) precisa chamar `POST /invitations/:token/accept` **antes** de qualquer chamada a `resolve` — chamar `resolve` primeiro encerraria a sessão sem dar chance ao aceite.

**Consequência.** O caso que a entrada de 2026-09-24 já previa ("convite novo volta a funcionar pelo fluxo de conta existente") passa a ter um caminho de fato executável. O custo é a tela de convite ter que conhecer essa ordem (`login` com token → `accept` → só então `resolve`), documentada no README do módulo `auth`. Nenhuma migration; nenhum formato de resposta muda, só um campo opcional a mais no corpo de `POST /auth/login`.

**Origem.** Decidido em sessão (orquestração), a partir do achado registrado no PR #164. **Pendente de validação.**

---

## 2026-09-29 — O SQL do papel de runtime (ageniza_app) é confiável

**Contexto.** A re-revisão de segurança do PR #159 (issue #94) mostrou que a autorização dentro do trigger `app_private.check_agency_membership_update`, que decide *se* roda por `current_user`, continua lendo o GUC `app.user_id` — forjável por `ageniza_app` no meio do `UPDATE`. Forjando o GUC para o `user_id` do Owner, um `account_manager` sem `colaborador.atribuir_admin` concede `admin`. O achado é pré-existente (reproduzido igualmente no commit `4120330`), exige SQL bruto emitido como o papel de runtime e não é alcançável pelas rotas atuais, que só escrevem em `agency_memberships` a partir da #97.

**Decisão.** Aceitar o modelo de confiança em que o SQL emitido pela aplicação como `ageniza_app` é confiável: a aplicação define `app.user_id` por transação via `SET LOCAL`, a partir da sessão autenticada, e todo SQL é parametrizado (Knex), de modo que o cliente não influencia o GUC. Em troca, o trigger deixa de alegar imunidade a "any GUC trick"; o que ele garante é que roda sob `ageniza_app` e que um GUC limpo não pula a verificação.

**Consequência.** O endurecimento real — um contexto de ator por transação não forjável pelo papel de runtime — fica na #166 e precisa landar antes da #97. Até lá, qualquer barreira que dependa de `app.user_id` apoia-se na confiança no papel de runtime, e isso vale para a autorização do produto como um todo, não só para este trigger.

**Origem.** Re-revisão de segurança do PR #159 (issue #94); decisão do dono do produto em 2026-09-29.

---

## 2026-09-29 — O reset de senha sempre autentica, exceto sem nenhum contexto

**Contexto.** `specs/auth.md` (§7, "Redefinir senha") já decidia que, ao final do reset, a pessoa **já está autenticada** — segue para o aceite do convite quando houver um, ou para o `resolve`. A API só cumpria isso no ramo **com** `inviteToken`: `POST /auth/password/reset` sem convite respondia `204` sem cookie, e não havia como a tela cumprir esse aceite. A divergência foi achada pela #73, ao tentar implementar a tela de reset contra o contrato real.

**Decisão.** `POST /auth/password/reset` sempre autentica quem redefiniu, pelo mesmo mecanismo `signInEmail` que o ramo com convite já usava — **exceto** a mesma exceção que já vale para o login (2026-09-24, "Credencial correta sem nenhum contexto não cria sessão"): conta com **zero contextos** e sem `inviteToken` válido para o mesmo e-mail. Nesse caso a senha é trocada (a redefinição em si nunca deixa de acontecer, regra 8), mas **nenhuma sessão é criada** — se o mecanismo do Better Auth chegar a criar uma, ela é revogada pelo mesmo caminho que o login já usa (issue #68), e nenhuma linha sobrevive em `auth."session"`.

A resposta passa a ser sempre `200`, com corpo que diz o que aconteceu: `{ signedIn: true }` quando há sessão, `{ signedIn: false, reason: 'NO_CONTEXT_ACCESS' }` quando não há. O `400 INVALID_LINK` de token de reset inválido, usado ou expirado não muda. A resposta não vira oráculo de existência de conta além do que um token de reset **válido** já prova — quem chegou até aqui já provou o e-mail pelo link.

`AuthLoginRequestSchema`, em `packages/contracts/src/auth.ts`, passa a declarar o `inviteToken` opcional que a rota de login já aceitava desde a decisão de 2026-09-29 anterior ("O login aceita o token do convite..."), mas que só existia como extensão local em `routes.ts` — o web enviava esse campo fora do que o contrato validava.

**Consequência.** É **mudança de contrato numa rota implantada**: o `204` sem corpo, fora do ramo de convite, deixa de existir; os testes de integração de `password/reset` mudaram junto. Não há migration nem policy nova — reaproveita `countValidContexts` (injetado do módulo `contexts`) e a mesma rotina de revogação que o login já tinha.

**Origem.** Issue #175, achado registrado pela #73. Decidido pelo dono do produto em sessão, em 2026-09-29.

**Correção pós-revisão (2026-09-29, PR #176).** A revisão de segurança achou que a primeira versão confundia dois casos sob um único motivo: `signedIn: false, reason: 'NO_CONTEXT_ACCESS'` também saía quando a conta **tinha** contexto e a assinatura pós-reset falhava por outro motivo — reproduzido com uma falha transitória na contagem de contextos e com dois tokens de reset válidos da mesma conta usados em paralelo (o segundo perde a corrida pela senha atual e recebe o motivo errado). Havia ainda um caso em que a contagem falhando **depois** da assinatura deixava uma sessão órfã no banco (nunca alcançável pelo cliente, mas contrariando "nenhuma sessão sobrevive").

A correção: a contagem de contextos passa a rodar **antes** da assinatura, não depois — uma conta confirmada em zero contextos nunca chega a ter sessão criada para revogar, o que também fecha o caso da sessão órfã. E `signedIn: false` passa a ter dois motivos: `NO_CONTEXT_ACCESS` fica reservado ao zero **confirmado** pela contagem; qualquer outra causa que impeça a sessão — conta não identificável, contagem falhando, ou a própria assinatura falhando — usa `reason: 'SIGN_IN_REQUIRED'`, e a tela leva a `/entrar` em vez de `/sem-acesso`. A senha muda nos dois casos; a distinção é só sobre o próximo passo da pessoa. `AuthPasswordResetResponseSchema`, `specs/auth.md` (regra 8a, §6, §7) e o README do módulo `auth` foram atualizados juntos. Toda falha nesse caminho passa a gerar um log estruturado (sem senha, token ou e-mail), onde antes o `catch` era silencioso.

**Origem da correção.** Revisão de segurança do PR #176 (issue #175); decisão do dono do produto em sessão, em 2026-09-29.

---

## 2026-09-29 — A área da agência vive em `/agencia/:agenciaId/...` no navegador

**Contexto.** A decisão de 2026-09-15 manda o contexto na rota e nunca na sessão, mas ela falava da API (`/agencies/:agencyId/...`). No navegador, as SPECs de colaboradores e clientes usavam `/colaboradores` e `/clientes/:clienteId` sem contexto, e depois do login a pessoa caía em `/app`, um stub. A casca da área da agência (#181) não podia começar sem essa forma definida.

**Decisão.** Toda tela da área da agência fica sob **`/agencia/:agenciaId/...`**, com as rotas em português (`/agencia/:agenciaId/colaboradores`, `/agencia/:agenciaId/clientes/:clienteId/<aba>`). É o espelho do `/portal/:clienteId` já decidido para o cliente. A página inicial da agência é `/agencia/:agenciaId`, e `/app` deixa de ser destino.

**Consequência.** Duas abas com duas agências funcionam lado a lado sem interferência, e o link de qualquer tela carrega o contexto. As seções 7 de `specs/colaboradores.md` e `specs/clientes.md` passam a ser lidas com esse prefixo, e a #181 corrige o texto delas no mesmo PR. Trocar a agência na URL troca o contexto inteiro, inclusive o cache.

**Origem.** Decidido pelo dono do produto em sessão, a partir da #181.

---

## 2026-09-30 — Limite de tamanho do nome no perfil próprio

**Contexto.** A SPEC de colaboradores (`specs/colaboradores.md`, §§3, 5 e 6) exige que o nome do próprio perfil seja obrigatório, não vazio e com **limite de tamanho**, mas não fixa um número. A task #101 precisava de um valor para validar `PATCH /me/profile`.

**Decisão.** O nome é aparado (trim) e aceito entre 1 e **120** caracteres. Nome vazio, só com espaços, tabulação ou NBSP é recusado. O e-mail não é editável por nenhuma rota do módulo de perfil.

**Consequência.** 120 é folgado para um nome de exibição e não colide com nada existente. Se o dono do produto quiser outro número, é mudança de uma constante em `packages/contracts/src/profile.ts` e do teste correspondente — sem migration nem mudança de formato.

**Origem.** Task #101. **Pendente de validação** — o número foi escolhido na implementação porque a SPEC não o define.

---

## 2026-09-30 — O menu de conta encerra a sessão e não troca o contexto

**Contexto.** A issue #70 leva para a interface as ações de sessão que já existem na API e exige o menu em toda tela autenticada. A troca de contexto tem fluxo próprio na issue #78 e não deve ser antecipada pelo menu desta issue.

**Decisão.** O cabeçalho autenticado mostra o nome e o e-mail da pessoa dentro do menu de conta. Quando houver contexto ativo, ele aparece no menu e permanece visível no cabeçalho fechado. `POST /auth/logout` encerra a sessão atual; `POST /auth/logout-all` encerra todas as sessões e exige confirmação explícita. Depois de qualquer sucesso, a interface limpa o cache client-side da conta anterior e leva a pessoa para `/entrar`. Um `401` no logout significa que a sessão já não existe: a saída é tratada como concluída e não guarda o destino da conta anterior, para que a próxima conta na mesma aba não seja levada ao endereço de quem saiu. A troca de contexto continua fora do escopo da #70 e fica para a #78.

**Consequência.** O menu não oferece seletor nem inventa uma regra para escolher contexto. A ação de encerrar todas as sessões fica separada e com tratamento visual destrutivo, para distinguir o alcance da ação antes da confirmação.

**Origem.** Decidido pelo dono do produto na especificação da issue #70 e confirmado durante sua implementação.

---

## 2026-10-01 — Rota própria para os cargos que existem na agência

**Contexto.** `specs/colaboradores.md` (linha 190) diz que o filtro de cargo "lista os valores que existem naquela agência", mas nenhuma rota da seção 6 devolvia essa lista: a listagem paginada (#95) traz só uma página, e o formato dela é o que as próximas listagens vão copiar. A lacuna apareceu ao preparar a grade de crachás (#102).

**Decisão.** Uma rota própria e mínima, `GET /agencies/:agencyId/collaborators/job-titles`, com as mesmas guardas da listagem (`requireAgencyAccess` + `requirePermission('colaborador.visualizar')`). A resposta é `{ data: string[] }` com os cargos **distintos** dos vínculos **ativos** da agência — aparados com `btrim`, sem nulos e sem vazios —, em ordem alfabética e no máximo 200 valores. A consulta parte de `agency_memberships` filtrada pela agência da rota. O formato da listagem paginada não muda.

**Consequência.** O filtro de cargo da grade tem fonte própria, sem alterar o formato de resposta que outras rotas já usam. Rota aditiva: nenhuma migration, nenhuma policy nova, nenhum campo novo em contrato existente. Como é um caminho novo de leitura da agência, entra com a mesma barreira de escopo da listagem (a RLS mostra as agências do chamador, nunca uma só; o filtro de agência da consulta é a barreira que separa).

**Origem.** Issue #218, decidida pelo maestro a partir da lacuna achada na #102. **Pendente de validação** pelo dono do produto.
