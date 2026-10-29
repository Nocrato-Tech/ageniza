# Revisão de segurança

> **Nível de risco:** aplica-se só ao nível Alto (ver a seção Níveis de risco do [AGENTS.md](../AGENTS.md)).

Todo pull request que toque **banco, autenticação, sessão, autorização, convite, armazenamento, upload, infraestrutura ou dado pessoal** passa por esta revisão antes do merge, feita por quem **não escreveu o código**. Este documento é o padrão da revisão. Ele vale para qualquer revisor: pessoa, agente no Claude Code (`.claude/agents/security-reviewer.md`), no Maestri ou em outra ferramenta.

Não é uma lista para marcar. O revisor **tenta quebrar** o que o PR entrega e só afirma o que provou. A regra que sustenta tudo o resto é esta: **um achado sem cenário concreto não é achado, e uma aprovação sem ataque executado não é aprovação**.

## Por que existe

Nas primeiras rodadas de implementação (PRs #159, #162, #163 e #176), a primeira revisão achou falha em quase todo PR de banco. Estes são os casos que justificam o processo:

- um Gestor de conta movia o vínculo do Owner para si e virava Admin, até em outra agência, porque o *grant* de `UPDATE` valia para todas as colunas;
- a pessoa do portal criava uma thread já "resolvida" pelo `INSERT`;
- o deploy de produção e o `pnpm dev` quebravam por uma variável de ambiente nova;
- a leitura do "valor antigo" dentro de uma `WITH CHECK` era burlada por duas transações concorrentes.

Os testes do próprio PR passavam em todos esses casos. Quem testa só o que implementou testa o caminho feliz.

## Referências do mercado

A revisão segue estas referências, na versão mais recente publicada:

| referência | uso aqui |
|---|---|
| **OWASP ASVS**, nível 2 | requisito verificável de autenticação, sessão, controle de acesso, validação, criptografia, logs e configuração |
| **OWASP API Security Top 10** | a lista de ataque padrão contra cada rota nova: BOLA, autenticação quebrada, BOPLA (propriedade exposta ou gravável), consumo sem limite, BFLA (função sem autorização), SSRF, configuração insegura, inventário de API |
| **OWASP Top 10** (aplicações web) | a interface: injeção, XSS, falhas de controle de acesso, falhas de integridade |
| **CWE Top 25** | a classificação dos achados, para que cada um tenha nome e severidade comparáveis |
| **LGPD** | dado pessoal: minimização, finalidade, retenção e o que aparece em log e em resposta |
| **Supply chain** (SLSA, OpenSSF Scorecard como referência) | dependência nova, script de `postinstall`, ação de CI de terceiro |

## O que o revisor faz, nesta ordem

### 1. Entender o que o PR promete
Leia a issue inteira, a seção da SPEC, as entradas de `docs/business/decisions/` que a issue cita e [`docs/business/structural-changes.md`](business/structural-changes.md). Liste as **fronteiras de confiança** que o PR toca: quem chama, com qual credencial, o que atravessa para o banco, para o armazenamento ou para o navegador.

### 2. Modelar a ameaça em uma página
Para cada rota, tabela ou tela nova, responda por escrito: quem são os atores (anônimo, pessoa do portal, cada papel da agência, Owner, worker, operação) e o que cada um **não pode** conseguir. Isso vira a lista de ataques do passo 3.

### 3. Atacar, executando

Sempre num **banco isolado** e num **worktree temporário fora do repositório**. Nunca no banco `ageniza`, nunca recriando containers compartilhados:

```sh
docker exec ageniza-local-postgres-1 psql -U postgres -c "create database ageniza_rev<N>"
export MIGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/ageniza_rev<N>
export DATABASE_URL=postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza_rev<N>
```

Os ataques de banco rodam como **`ageniza_app`**, nunca como `postgres`, que ignora RLS e *grants*. O contexto do usuário é definido como os testes fazem: o ator é gravado na transação por `app_private.bind_actor` (uma vez por transação). Desde a #166 o GUC `app.user_id` continua gravável, mas nada o lê — forjá-lo não reproduz mais nenhum ataque. Ao final, apague o banco e o worktree.

A lista mínima, adaptada ao que o PR toca:

**Banco e RLS**
- Ler e escrever dado de **outra agência**, de **outro cliente da mesma agência**, e sem vínculo algum.
- Mudar colunas de tenant e de identidade (`id`, `agency_id`, `client_id`, `user_id`, assunto, autor, lado) por `UPDATE` **e** por `INSERT`.
- Forjar colunas que o banco deveria fixar: `created_at`, `resolved_at`, `resolved_by`, `updated_by`, `status`.
- Conceder a si mesmo mais do que tem, como papel, admin ou posse.
- **Concorrência**: duas transações reais ao mesmo tempo contra a mesma linha (`READ COMMITTED` reaplica o `UPDATE` na versão nova).
- Funções `security definer`: `search_path` fixo, `revoke … from public`, e **toda** checagem de permissão escrita dentro da função.
- Ator por transação: desde a #166 o ator é gravado uma única vez pelo banco em `app_private.actor_context`, por `app_private.bind_actor`; um segundo bind na mesma transação (mesmo dentro da mesma instrução) dá 42501. `set_config('app.user_id', …)` continua executando mas nada o lê, então nenhuma regra pode depender desse GUC.
- DELETE físico de entidade de negócio.

**API**
- **BOLA**: trocar o id da URL por o de outro tenant. Precisa dar 404, sem revelar que o recurso existe.
- **BFLA**: cada papel contra cada rota de escrita. Teste com **papel personalizado de uma permissão só**, porque o Admin tem todas e esconde guarda com a permissão errada.
- **BOPLA**: campo a mais no corpo (`.strict()`), campo sensível na resposta (hash, token, dado de outro).
- Entrada hostil: tamanhos extremos, `page=1e20`, unicode, NBSP, tipos trocados, JSON profundo.
- Corpo malformado, corpo declarado como JSON e vazio, ou `content-type` inesperado: esperam **400/415**, sem `log.error` nem evento no Sentry, e sem ecoar trecho do corpo na resposta.
- Erro vira 500? Todo 500 provocável por entrada é achado.
- Oráculo: a resposta ou o tempo revelam se um e-mail, uma conta ou um recurso existe?
- Rate limit nas rotas de credencial e de envio de e-mail.

**Autenticação e sessão**
- Sessão antiga sobrevive a reset de senha, logout-all ou remoção de vínculo?
- Sessão criada e depois revogada deixa janela utilizável ou cookie aplicado?
- Token de convite, de reset ou de sessão aparece em URL persistida, log, `Referer`, storage do navegador ou resposta?
- Open redirect a partir de `state`, query ou destino guardado.
- CSRF: rota de escrita sem a proteção de origem global.

**Armazenamento e upload**
- Tipo validado pelo **conteúdo** (magic bytes), não pelo header nem pela extensão; SVG e HTML recusados.
- Tamanho aplicado antes de ler o corpo inteiro na memória.
- Chave de objeto derivada só de ids validados no servidor, sem path traversal.
- URL assinada: só GET, validade curta, `Content-Type` e `Content-Disposition` forçados. Nada público.

**Interface**
- XSS: todo texto vindo do servidor ou do usuário é renderizado como texto. Qualquer `dangerouslySetInnerHTML` ou HTML montado é achado até prova em contrário.
- Dado de uma conta aparecendo depois do login de outra (cache não limpo).
- Links externos com `rel="noopener noreferrer"`.

**Infraestrutura e CI**
- Variável de ambiente nova entra em `infra/vps/ageniza-deploy.sh` (allowlist), em `scripts/docker/local-stack.mjs` e nos exemplos. **O CI não pega isso.**
- Segredo commitado, placeholder aceito em produção, porta publicada (nunca a do PostgreSQL).
- Dependência nova: justificada, mantida, sem `postinstall` inesperado, com `pnpm audit` limpo nas severidades alta e crítica.

**Logs e LGPD**
- Nenhum log com senha, token, hash, e-mail completo ou dado pessoal além do necessário.
- A resposta devolve só o que a tela precisa. Campo "interno da agência" nunca em tabela que o portal lê.

### 4. Conferir os testes do PR
Para cada item de aceite, pergunte: **este teste falharia com o código errado?** A forma mais barata de responder é a **mutação**: altere a linha que implementa a regra (troque a permissão, remova um filtro, inverta um `>`), rode a suíte e veja se ela fica vermelha. Teste que continua verde com a regra removida é achado.

Sinais de teste fraco:
- afirma só que "não deu erro", quando a RLS filtra em silêncio e o certo é conferir a contagem de linhas ou o estado final;
- usa fake que responde diferente da API real, como 204 onde a real dá 401;
- injeta no fake o valor que o código deveria calcular sozinho;
- afirma "Page not found" em vez da rota de destino.

### 5. Publicar
Uma revisão por PR, com `gh pr review <N> --comment` e **nunca** `--approve` ou `--request-changes`, porque o merge é decisão do orquestrador. Em português:

```
Veredito: APROVADO | APROVADO COM RESSALVAS | MUDANÇAS NECESSÁRIAS

O que foi verificado e como (banco isolado, commit, suítes, ataques executados)

Achados
1. [Crítica|Alta|Média|Baixa] título curto — arquivo:linha
   Cenário: quem, fazendo o quê, consegue o quê.
   Evidência: o comando ou teste que provou, e o resultado.
   Correção sugerida.

O que está correto (o que foi tentado e resistiu)
```

**Severidade:**

| | quando |
|---|---|
| **Crítica** | escalada de privilégio, acesso a outro tenant, sessão ou credencial comprometida |
| **Alta** | quebra de regra inviolável da SPEC, dado pessoal exposto, regressão de fluxo principal, deploy quebrado |
| **Média** | 500 provocável, oráculo fraco, defesa em profundidade ausente, teste que não protege o aceite |
| **Baixa** | endurecimento, clareza de log, lacuna de teste secundária |

Crítica ou Alta impede o merge. Uma Média de segurança também impede, salvo decisão registrada em `docs/business/decisions/` com follow-up aberto, como o #166.

### 6. Re-revisão
Depois da correção, a re-revisão refaz **os mesmos ataques** e procura regressão introduzida pela correção. Nas rodadas reais, a correção de uma falha trouxe outra mais de uma vez: o trigger que resolveu a corrida quebrou o reaceite de convite, e a correção do logout em `/contextos` mandou quem perdeu o acesso para `/entrar`.

## Lições que já custaram caro

O registro detalhado vive no ai-memory, em `notes/licoes-seguranca-rls.md`. As regras que viraram padrão:

- *Grant* de `INSERT` e `UPDATE` **por coluna**, sempre.
- Comparação de valor antigo com novo por **trigger `BEFORE UPDATE`**, `security invoker`. O gatilho pula só para papel com bypass, pelo atributo e nunca pelo nome: `app_private.role_bypasses_rls(current_user)` (ou `session_user`, quando a trava é do login, como em `lock_active_client_of_child`), que lê `rolsuper` e `rolbypassrls` de `pg_roles` (#397). Nunca por subselect na `WITH CHECK`.
- Valor que o cliente não escolhe (`created_at`, autor, lado, quem resolveu) é fixado pelo banco.
- O lado de quem escreve (agência ou cliente) vem da rota e é conferido pela credencial, nunca pelo corpo.
- Teto de página é **limitar**, e `page` gigante não pode virar 500.
- Upload validado pelo conteúdo; URL assinada com tipo forçado.
- Mudança de ambiente entra na allowlist do deploy.
- Em VPS compartilhada, o isolamento de recurso entre ambientes (dev e prod) cobre também o **disco** (imagens, volumes, logs), e não só CPU, memória e pids. Um limite de container não impede que as imagens de cada release, os logs do Docker ou um volume sem teto encham o disco e derrubem a Postgres do outro ambiente (#774).
- Trocar a credencial (redefinir a senha, o Google assumir a conta) invalida a sessão **pela data da troca**, não só apagando as sessões uma vez: um login com a senha antiga em andamento grava a sessão depois do apagamento e sobrevive (#705, #719). Quem revisa roda logins com a credencial antiga em paralelo com a troca e conta as sessões que sobram.
- Um contador compartilhado entre caminhos (por exemplo, o de reenvio de confirmação usado pelo login e pelo cadastro) vira oráculo de existência de conta: quem chama um caminho lê o efeito do outro pelo limite. Contador de limite fica por caminho, ou o caminho público não o consome (#722).
- Quando a regra está em duas camadas (rota e banco), cada camada precisa de um teste que espione só ela, com a outra desligada; senão a mutação de uma camada fica verde, porque a outra segura (#722).
- Lógica que usa `now()` no banco vira uma função pura com o instante como parâmetro (`p_at`), chamada com `now()` por quem usa. Assim os testes fixam o instante e não ficam cegos em parte do dia, e `p_at` no futuro é recusado (#730, #732, #738).
- Coluna que a aplicação escreve e não pode ler (como o hash do token do e-mail) tem prova: `SELECT` como `ageniza_app` dá 42501, e nenhuma rota devolve a coluna (#731).
- Esconder um campo também esconde a **ordenação** e os **agregados** que o revelam: ordenar ou contar por um campo oculto o vaza (#728).
- Prefixo de migration segue a ordem de merge, não a de despacho. Uma migration que entra depois de outras com prefixo maior roda numa ordem num banco novo e em outra num banco existente. Quem revisa aplica o develop num banco limpo, aplica a branch por cima e compara o esquema com o de um banco do zero (#728, #733).
- Teste de 401 depois de invalidar sessão usa o cookie **assinado**; com cookie sem assinatura, o 401 vem da assinatura e não prova que a sessão morreu (#733).
- A mutação roda contra o arquivo de teste **inteiro**, não só contra o teste escrito para ela; e o mutante que o autor declara equivalente é rodado por quem revisa (#741).
- Quando uma regra se repete em duas funções, cada cópia ganha a sua mutação (#740).
- Nome vindo de provedor externo (o perfil do Google) passa pela mesma validação do formulário (#733).
- Decisão de implementação não revoga decisão do dono; o desvio vira achado (#736).
- Estado de uso único guardado no navegador para uma viagem externa (OAuth) morre em **todas** as saídas da viagem, inclusive na falha que a API manda para outra tela. Quem revisa roda o cancelamento seguido de outra entrada na mesma aba (#736).
- Tela que chama `refresh()` do store ao montar uma página que carrega do zero (a volta do OAuth) é testada com o fake respondendo em macrotarefa (`setTimeout`) ou no navegador real; o fake síncrono do jsdom esconde a corrida de gerações (#736).
- Marca de uso único no estado da navegação: conferir se um esqueleto monta o mesmo componente antes e gasta a marca (#736).
- O parser WHATWG URL apara espaço e C0 das pontas da string antes de resolver `..`; checagem de segmento feita no texto cru recusa espaço nas pontas, senão `/x/.. ` vira o pai (#741).
- Valor de configuração que entra num cabeçalho (o `Path` de cookie) aceita só caracteres seguros (`[A-Za-z0-9._~-]` por segmento) e é recusado no boot; um `;` no valor muda o cookie (#741).
- Regra de guarda de sessão se prova com um teste de varredura. Ele percorre as rotas registradas (`onRoute` ou `printRoutes`) com a sessão restrita e exige recusa em toda rota fora de **duas** listas fixas: as liberadas e as públicas. Classificar a rota pela resposta ao anônimo deixa escapar a rota que valida o corpo ou responde 404 antes da sessão (#749).
- Guarda de sessão nasce fail-closed. A liberação é opcional, por nome explícito na rota (por exemplo, `requireSessionUnconfirmedAllowed`), nunca padrão de um módulo inteiro (#749).
- Consulta em `audit.events` leva `agency_id` no predicado. Sem ele, não usa o índice `events_agency_action_occurred_idx` e varre os eventos de todas as agências, e isso dentro de uma trava de linha (#750).
- A fixture `agencySuspended` do content-world não grava `status='suspended'`. Teste de "agência suspensa" precisa gravar o status de verdade e conferir que a recusa veio do A0020 (#750).
- `sshd -T` sem `-C` não avalia `Match`, e as opções de um `Match` que casa sobrepõem as globais, seja qual for a ordem dos arquivos. Conferir a configuração efetiva do SSH exige `sshd -T -C user=<usuário>,host=<host>,addr=<ip>` para `root` e para o usuário de deploy, e o drop-in do projeto termina com `Match all` repetindo as opções sensíveis em `no`. Quem revisa roda o `Match User root` com `PasswordAuthentication yes` num drop-in posterior e tenta o login pela rede (#765).
- Com `ssh.socket` ativo (Ubuntu 24.04 e mais novo), o sshd ignora `Port`: mudar a porta no arquivo não muda onde ele escuta, e o que lê a configuração em disco dá PASS na porta errada. Depois de gravar o drop-in, `systemctl daemon-reload` e `systemctl restart ssh.socket`, e a porta se confere pelo que escuta (`ss -tlnp` e os sockets do `ssh.socket`), inclusive a porta antiga de um arquivo migrado, que não pode continuar aberta (#765).
- `cmd | grep -q` sob `pipefail` morre de SIGPIPE quando o `grep` sai no primeiro acerto e `cmd` ainda escreve (o `sshd -T` tem uns 4 KiB): o pipeline devolve 141 e a conferência falha com a configuração certa. Leia o comando uma vez numa variável e use `grep <<<"$saida"` (#765).
- Binário falso de saída curta esconde o SIGPIPE e esconde o `Match`: o `sshd` falso de um teste imprime poucas linhas e uma configuração só. O falso responde como o real, com saída maior que o buffer do pipe (mais de 64 KiB) e uma resposta por usuário em `-C`, e recusa argumento que o real recusaria (#765).
- Todo `spawnSync` de um harness de teste de shell leva `timeout` (e `killSignal`) e trata `result.error` como falha. Uma mutação que transforma um laço de espera em laço infinito trava a suíte inteira, e a mutação sobrevive por cansaço em vez de ficar vermelha. O script de teste que precisa travar usa `exec` para o processo morrer com o shell, senão o filho órfão segura o pipe (#765).
- Porta que o script vai passar a escutar (`ssh.socket`, serviço) é conferida antes de gravar a configuração: se outro processo a tem, o `restart` falha com `Job failed` cru e deixa o host entre o estado antigo e o novo. Recuse com mensagem clara antes de mudar qualquer coisa, e envolva o `restart` num `die` que diga para manter a sessão aberta (#765).
- "Equivalente porque o ramo não é alcançável numa transação" não vale para um valor relido depois de uma trava consultiva. Quem espera a trava lê o estado que o holder commitou: com duas transações reais, H segura a trava e muda o plano da agência, A já está na fila, e o ramo "o teto agora é nulo" passa a ser alcançável (no #779, `enforce-client-null-limit-zero` recusava a criação de uma agência recém-isenta com `A0091`). Só se declara equivalente um mutante depois de tentar o cenário H + A e ver os dois o aceitarem; o teste de duas transações é o que o mata (#779).
- Dois recursos com chaves de trava diferentes não se serializam, mesmo sendo da mesma agência. Quem compara um teto novo com o uso de um recurso precisa pegar também a chave de quem grava esse uso, sempre na mesma ordem das duas: a descida de plano lia `agency_storage_used_bytes` sob `agency_trial_limits:` enquanto a confirmação de upload gravava sob `media-quota:`, e as duas terminavam com 24 GiB usados numa cota de 20 GiB. Um comentário "o chamador segura a trava da agência" tem de dizer qual trava, e o teste de duas transações (uso em curso, descida, as duas ordens de commit) é o que prova (#779).
- Cada porta que muda uma assinatura confere o provedor da própria assinatura, não só que o nome do provedor é válido: a renovação recusava a confirmação de outro provedor com `A0114` e a subida de plano a aceitava, e uma assinatura `asaas` ficou `profissional` por uma confirmação `simulado`. Ao listar as portas (assinar, subir, descer, renovar, cancelar, reativar, avançar o relógio), a tabela de "o que cada uma confere" precisa ter a coluna do provedor, e o teste vai nos dois sentidos (`asaas` confirmada por `simulado` e o inverso) (#781).
- Valide a faixa de uma entrada antes de calcular qualquer coisa com ela: o preço de um extra de 2 147 483 647 estoura o inteiro (`22003`) antes de a checagem `A0116` rodar, e um `provider_ref` acima do `CHECK` da tabela vira `23514` no lugar do erro de domínio. A checagem de faixa vem primeiro, num só ponto, e o teste usa o extremo do tipo (`2147483647`, `-2147483648`), os dois lados do limite em bytes e não em caracteres (#781).
- A ordem das duas travas de uma agência (`media-quota:` primeiro, `agency_trial_limits:` depois) mora numa função só (`lock_subscription_change`), chamada por pedir, confirmar e renovar antes de qualquer leitura de uso. Quem toma só a da agência (criar cliente, cancelar, reativar, avançar o relógio) não compara uso e nunca pode, na mesma transação, chamar uma dessas três depois. O teste confere em `pg_locks` que quem espera a `media-quota` ainda não segura a da agência, e a API (#772) não junta as duas coisas numa transação (#781).
- A regra de preço e a regra do provedor moram em camadas diferentes e têm de combinar nos extremos: `greatest(valor proporcional, 0)` produz uma subida de valor zero, e nenhum provedor cobra zero (o simulado recusa `amountCents <= 0`, o Asaas não emite cobrança de R$ 0). Estado que o provedor não consegue cobrar não pode abrir cobrança: o banco aplica na hora o que a regra do dono manda ("cobrança zero e sem estorno") e nunca deixa uma cobrança `pending` que ninguém paga. Quem revisa caça o extremo do preço de ponta a ponta com o cenário "plano mais barato com teto maior" (essencial + 20 clientes + 80 GiB para profissional + 0 + 1 GiB), com o adaptador real e não com um fake que aceita o que o real recusa (#782).
- Uma exclusão que roda numa camada posterior não tira nada da imagem: `rm` depois de `COPY --from=build` deixa o arquivo na camada de baixo, e um `docker save` ainda o entrega. "A imagem nem leva o código" só é verdade se o estágio de build remove antes de a imagem final copiar a árvore, e se a prova é `docker save` mais a busca do caminho em cada tar de camada (nenhuma pode listá-lo). O teste de texto do Dockerfile confere onde a remoção está (no estágio de build, depois do `deploy`) e que o estágio final não a menciona (#782).
- O que separa dois ambientes é conferido pela superfície que o produz, com o valor perigoso presente: o compose de produção renderizado com `DEPLOY_TARGET=dev` e `PAYMENTS_PROVIDER=simulado` exportados no shell, o Dockerfile sem `ARG` para essas chaves (um `--build-arg` não chega ao ambiente da imagem) e a lista de chaves do deploy recusando as duas. Cada uma das duas chaves tem de falhar sozinha; a configuração que exige o Mailpit é uma terceira barreira, não a primeira (#782).
- Corrida entre pagar e cancelar se prova com atraso variável do segundo pedido (de 0 a dezenas de milissegundos, dez rodadas), para cobrir as duas ordens; o invariante é `cobrança confirmada ⇔ plano trocado`, e nenhuma ordem produz `500` (#782).
- Ao abrir o grupo de um segredo para o uid de um container (a pasta do túnel em `root:65532`), a **pasta pai** (`/etc/ageniza-dev`, `/etc/ageniza`, `root:root` 0750) vira a barreira contra os outros usuários do host, porque o uid 65532 também existe em outras imagens e no host. Ela precisa de teste, com a mutação para 0755 (#784).
- Plugin do Better Auth traz endpoint próprio (o `/expo-authorization-proxy` redireciona para qualquer `https`): nunca montar um `auth.handler` pega-tudo em `/auth/*`; as rotas são registradas uma a uma.
- Arquivo de integração novo entra no `test:integration` de `apps/api/package.json`; fora dele, a mutação só fica vermelha localmente e o CI nunca roda a prova.
- Check verde não prova que um job condicional rodou (#791): job pulado conta como sucesso. Confira o passo pelo nome.
