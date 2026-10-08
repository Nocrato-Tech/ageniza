# Colaboradores

| | |
|---|---|
| **Status** | aprovado |
| **Submódulos** | equipe e crachás · detalhe do colaborador · convites pendentes · perfil próprio |
| **Sessões** | 2026-09-24 · alinhada às decisões de 2026-10-01 a 2026-10-07 em 2026-10-07 (#358) |
| **Decidido por** | Pedro Vidal, em sessão (2026-09-24); as decisões posteriores foram tomadas pelo maestro e estão **pendentes de validação** do dono, exceto onde a seção disser o contrário (#359) |

> **A capacidade central deste módulo não existe em nenhuma das duas camadas.** `agency_memberships` tem apenas policy de `SELECT`: trocar o papel de alguém ou remover alguém do quadro hoje encontraria zero linhas no banco. Não é regressão — nunca existiu.
>
> Herda de [`autorizacao.md`](autorizacao.md): o contrato de listagem, os três tratamentos de carregamento, "sem permissão" não é tela, e a invalidação de query depois de cada escrita.

## 1. Propósito

Administrar quem faz parte da agência: quem entra, com que papel, em que cargo, e quem saiu. É o primeiro módulo depois da porta de entrada, e é onde o catálogo de permissões deixa de ser teoria.

### Não resolve

- **Remuneração.** Fora do MVP (2026-10-07, pendente de validação): nenhuma rota, coluna ou tela a mostra. Volta como módulo próprio, com SPEC, quando o dono pedir — seção 10.
- **Estatísticas do colaborador** (entregas, pendências). Não há o que contar antes de Tarefas existir — seção 10.
- **Pré-cadastro no convite.** O convite leva e-mail e papel, e nada mais.
- **Solicitação de troca de e-mail.** A troca é operação, e a conversa acontece fora do produto.
- **Hierarquia entre colaboradores.** Não existe "gestor de quem": o modelo nunca liga colaborador a colaborador. A ligação entre colaborador e cliente — citada como `ClientAssignment` — também não existe em migration; nasce em Conteúdo e Tarefas (ver [`clientes.md`](clientes.md)).
- **Transferência de posse.** Fluxo próprio, que não existe.
- **Qualquer campo além dos seis da seção 3** — telefone incluído.

## 2. Atores e autorização

| capacidade | permissão | Admin | Gestor de conta | Produção | Vendas | Financeiro |
|---|---|:-:|:-:|:-:|:-:|:-:|
| Ver a equipe | `colaborador.visualizar` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Convidar colaborador | `colaborador.convidar` ¹ | ✅ | — | — | — | — |
| Reenviar convite | `convite.reenviar` ¹ | ✅ | — | — | — | — |
| Cancelar convite | `convite.cancelar` ¹ | ✅ | — | — | — | — |
| Remover do quadro | `colaborador.remover` | ✅ | — | — | — | — |
| Trocar o papel de outro | `colaborador.alterar_papel` | ✅ | — | — | — | — |
| Editar o cargo de outro ² | `colaborador.alterar_funcao` | ✅ | ✅ | — | — | — |
| Reativar um removido | `colaborador.alterar_papel` | ✅ | — | — | — | — |
| Ver os removidos ³ | `colaborador.remover` **ou** `colaborador.alterar_papel` | ✅ | — | — | — | — |
| Ler a lista de papéis atribuíveis | `colaborador.convidar` **ou** `colaborador.alterar_papel` | ✅ | — | — | — | — |
| **Conceder o papel `admin`** | `colaborador.atribuir_admin` | — | — | — | — | — |

¹ já existe no catálogo e já é concedida ao `admin`.

² A API recusa a edição do **próprio** cargo e a do cargo do **Owner** (`403`), como já recusa a do papel: o modal mostra o cargo como leitura nos dois casos. Decisão do dono em 2026-10-08 (`docs/business/decisions/2026-10-08-cargo-proprio-e-do-owner-nao-se-edita.md`), que substitui o item 7 da decisão de 2026-10-07 do `PATCH` do vínculo.

³ Além deles, o Owner, por posse. O critério é a tarefa, não o nome do papel: quem remove ou reativa precisa encontrar a pessoa, e uma agência pode montar um papel personalizado de administração do quadro sem usar o preset `admin`. É um desvio deliberado de "apenas para Admin e Owner" (2026-09-24): o `account_manager`, que edita cargo mas não papel, **não** vê removidos. **Pendente de validação** (2026-10-07).

**`colaborador.atribuir_admin` não é concedida a ninguém.** Só o Owner passa nela, porque ele faz curto-circuito na verificação por posse — inclusive o Owner sem vínculo, que existe só em `agencies.owner_user_id`. É uma permissão que existe para que a regra fique no catálogo em vez de num `if`, e um papel personalizado que a receba também passa. A API pede a permissão, não a posse, e identifica o papel `admin` pela mesma função do banco que o trigger e a policy usam (`app_private.is_admin_role`), para API e banco não divergirem sobre o que é "admin".

**Não existe `colaborador.operar`.** Entre olhar a equipe e administrar alguém não há um terceiro uso, e editar o próprio perfil não é permissão: é sobre si, e se resolve por identidade.

### Cargo não é papel

`job_title` descreve o trabalho e **não concede autorização**; `role_id` concede. É isso que permite ao Gestor de conta organizar a equipe sem poder aumentar o acesso de ninguém.

"Gestor de operação", "gestor financeiro" e "gestor de vendas" são **cargos**. O papel `account_manager` é um só.

### Por que o Gestor não convida

Convidar obriga a escolher o papel, e **os cinco presets não têm ordem entre si**. Sem hierarquia de papéis, nada impediria um Gestor de convidar alguém como Admin e pedir para ser promovido de volta.

## 3. Entidades e campos

**Nenhuma tabela nova. Nenhuma coluna nova.**

| campo | onde vive | quem edita |
|---|---|---|
| Nome | `auth."user".name` | a própria pessoa |
| Foto | `auth."user".image` | a própria pessoa |
| E-mail | `auth."user".email` | ninguém no produto |
| Cargo/função | `agency_memberships.job_title` | Admin, Gestor de conta |
| Papel de acesso | `agency_memberships.role_id` | Admin (e Owner para `admin`) |
| Data de entrada | `agency_memberships.created_at` | ninguém: é derivado |

Nome, foto e e-mail pertencem ao **usuário**, que é global; cargo, papel e data de entrada pertencem ao **vínculo** com aquela agência. A mesma pessoa tem um nome e pode ter dois cargos, em duas agências.

### O que o cargo aceita

`job_title` é texto livre mostrado sobre uma pessoa, e segue a regra de caracteres do **nome exibido** (2026-10-07, #324):

- **1 a 256 unidades UTF-16** depois do `trim` do JavaScript. A regra de caracteres recusa controle, formato (exceto os dois joiners entre letras, marcas ou pictogramas), invisíveis, separadores de linha e de parágrafo e os preenchimentos Hangul, e exige ao menos uma letra ou número. Um cargo só de emoji ou só de pontuação **não** é aceito, como já vale para o nome.
- **`null` e texto em branco limpam o cargo.** "Branco" é o que o `trim` remove (espaço, tabulação, NBSP, BOM nas bordas). Um valor só de invisíveis **não** é branco: é recusado com `400`, para que não se grave nem se apague o cargo com algo invisível. **Pendente de validação** (2026-10-07): que branco limpe, em vez de ser `400`.
- **O banco guarda o valor aparado e limita a forma** (`CHECK` de 1 a 256 unidades UTF-16, migration `20261001000000_job_title_format`, 2026-10-01). O backfill que acompanha a migration transforma em `null` o cargo legado só de espaços e o que passa de 256 unidades, **sem truncar**, e imprime as contagens no log da migration. **Pendente de validação** (2026-10-01): descartar, e não truncar, o legado acima do limite.
- **A regra de caracteres não está no banco**, de propósito: é de exibição, não de integridade, e uma `CHECK` mais estrita exigiria backfill. Cargos legados com algum desses caracteres continuam sendo lidos (o contrato de resposta aceita qualquer cargo não vazio de até 256 unidades, para um legado nunca derrubar a leitura da agência com `500`) e se corrigem pelo `PATCH`. **Pendente de validação** (2026-10-07): sem migration e sem backfill para esses legados.

### O perigo que o banco não cobre

**`auth."user"` não tem RLS.** O schema é gerenciado pelo Better Auth, e o gate de CI que exige *row level security* cobre apenas `public`. O `ageniza_app` lê **qualquer** usuário da plataforma.

Logo: nome, e-mail e foto de um colaborador só ficam isolados se a consulta **partir de `agency_memberships`**. Uma consulta que leia `auth."user"` sem amarrar no vínculo vaza usuários de outras agências, e o banco não vai impedir. Ver a regra 2 da seção 5.

## 4. Estados e transições

```
(sem vínculo) → active     # aceite de convite, com o papel que o convite carrega
active        → removed    # exige colaborador.remover
removed       → active     # o MESMO registro, e exige role_id novo no corpo
```

O registro é sempre o mesmo, porque `unique (agency_id, user_id)` impede dois vínculos da mesma pessoa na mesma agência. **Reativar não herda a autorização anterior**: quem volta pode voltar em outra função, e herdar o papel antigo em silêncio é o caso que essa regra existe para impedir.

**A remoção não apaga linha.** `status` vai para `removed` e o histórico permanece — é o vocabulário fixado na sessão 0.

**O estado errado é `409`, nos dois sentidos** (2026-10-07, pendente de validação): remover quem já está removido (`COLLABORATOR_ALREADY_REMOVED`) e reativar quem não está removido (`COLLABORATOR_NOT_REMOVED`) são rejeitados, e nada muda, nem `updated_at`. A remoção idempotente (`200` sem escrita) foi descartada: responderia sucesso sem uma linha alterada.

**Remover encerra todas as sessões da pessoa** (2026-10-08, decisão do dono, #411). A sessão é global e não existe sessão por agência, então a remoção apaga as linhas dela em `auth."session"` na mesma transação, mesmo que a pessoa tenha outra agência: a requisição seguinte com o cookie antigo é `401`, e ela entra de novo e escolhe a agência que ainda tem (se não tem nenhuma, o login é recusado). Vale também para remover o acesso ao portal de um cliente. Quem remove não perde a própria sessão, e só a passagem para `removed` encerra sessões: remover quem já está removido (`409`) ou reativar não muda nenhuma. O web confere a sessão a cada 45 s e quando a aba volta ao foco, na área da agência e no portal, porque uma aba parada não faria requisição nenhuma.

**Reativar com o papel `admin` exige `colaborador.atribuir_admin`**, inclusive para quem já foi Admin e volta como Admin (mantendo o mesmo `role_id`). Quem reaceita um convite depois de removido entra por `accept_invitation`, que não passa pelo trigger do vínculo.

Convite pendente **não é um estado do vínculo**: é uma linha em `invitations`, com ciclo próprio, e por isso vive em outra seção da tela.

## 5. Regras invioláveis

1. Quem tem `colaborador.visualizar` vê a equipe **inteira** daquela agência: a lista é a mesma para todos, e sua contagem não depende de quem olha.
2. Nome, e-mail e foto de colaborador só são lidos **através de `agency_memberships`**. Uma consulta que alcance `auth."user"` sem o vínculo é defeito, mesmo que a resposta pareça correta.
3. Conceder o papel `admin` — em troca de papel, em convite (criação **e** reenvio) **ou** em reativação — exige `colaborador.atribuir_admin`, que nenhum preset possui.
4. O Owner não é removido nem tem o papel alterado por este módulo.
5. Ninguém altera o próprio papel, nem o Admin.
6. Ninguém remove a si mesmo.
7. Reativar um vínculo `removed` sem `role_id` no corpo é rejeitado.
8. O Gestor de conta altera `job_title` e **nunca** `role_id`.
9. Colaborador `removed` não aparece na listagem padrão, e o filtro que o revela exige `colaborador.remover` ou `colaborador.alterar_papel` (ou ser o Owner), conforme a seção 2.
10. `pageSize` nunca passa de 100; sem parâmetro, são 24.
11. Remover não apaga a linha de `agency_memberships`. A regra vale também no banco: a migration `20261007000600` (issue #356, decisão de 2026-10-07 pendente de validação) revoga `delete` de `ageniza_app` em `agency_memberships` e em `invitations`, então uma policy de DELETE criada por engano não apaga vínculo nem convite, e remover e reativar continuam `UPDATE` de `status`.
12. Editar o próprio nome ou a própria foto não exige permissão de módulo, e não permite alcançar outra pessoa.

## 6. Backend

### Rotas novas

| método | rota | permissão | devolve |
|---|---|---|---|
| `GET` | `/agencies/:agencyId/collaborators` | `colaborador.visualizar` | `{ data, meta }` paginado |
| `GET` | `/agencies/:agencyId/collaborators/:membershipId` | `colaborador.visualizar` | o detalhe de uma pessoa |
| `GET` | `/agencies/:agencyId/collaborators/job-titles` | `colaborador.visualizar` | `{ data: string[] }` com os cargos que existem na agência |
| `GET` | `/agencies/:agencyId/roles` | `colaborador.convidar` **ou** `colaborador.alterar_papel` | `{ data: { id, key, name }[] }` com os papéis atribuíveis |
| `PATCH` | `/agencies/:agencyId/collaborators/:membershipId` | `alterar_papel` e/ou `alterar_funcao` | o vínculo atualizado |
| `POST` | `/agencies/:agencyId/collaborators/:membershipId/remove` | `colaborador.remover` | o vínculo em `removed` |
| `POST` | `/agencies/:agencyId/collaborators/:membershipId/reactivate` | `alterar_papel` | o vínculo em `active` |
| `GET` | `/agencies/:agencyId/invitations` | `colaborador.convidar` | convites pendentes, paginado |
| `PATCH` | `/me/profile` | — (identidade) | nome atualizado |
| `POST` | `/me/photo` | — (identidade) | a foto do usuário |

As rotas de perfil **não são escopadas por agência**: o usuário é global, e escopá-las sugeriria que a pessoa tem um nome por tenant.

**`job-titles`** (2026-10-01, #218, pendente de validação) existe porque o filtro de cargo da seção 7 "lista os valores que existem naquela agência" e a listagem paginada traz só uma página. Devolve os cargos **distintos** dos vínculos **ativos**, aparados, sem nulos nem vazios, em ordem alfabética e no máximo 200. A consulta parte de `agency_memberships` filtrada pela agência da rota (regra 2). Não altera o formato da listagem paginada.

**`roles`** (2026-10-06, #287, pendente de validação) é a única rota que entrega ids de papel ao front, e alimenta o convite, a troca de papel e a reativação. O papel `admin` só aparece na resposta para o Owner; esconder na tela é conveniência, e as barreiras da regra 3 continuam recusando quem montar a requisição na mão. Os papéis saem em ordem determinística por `key`. Sem nenhuma das duas permissões (e sem ser o Owner), `403`.

#### O `PATCH` do vínculo

(2026-10-07, #97; o item 6 da decisão está pendente de validação, e o item 7 foi substituído pela decisão de 2026-10-08, validada — ver a seção 2, nota ², e a seção 3.)

- O corpo usa os nomes `jobTitle` e `roleId`, ambos opcionais; a resposta é o item de colaborador (abaixo).
- Para chegar à rota basta uma de `alterar_funcao` ou `alterar_papel`. Lido o corpo, a permissão exigida é a de **cada campo presente** — e, quando o papel é `admin`, também `colaborador.atribuir_admin`.
- **Ordem das respostas**, para que quem não pode não descubra nada antes do `403`: `401`; `404` da agência; `403` da porta; `400` do corpo; `403` por campo; `404` do vínculo (de outra agência, inexistente, malformado ou removido: o mesmo); `400 INVALID_ROLE`; `403` de `atribuir_admin` quando o papel é `admin`; `403` do Owner e do próprio papel; `403` do Owner e do próprio cargo, quando o corpo traz `jobTitle`.
- **Toda recusa de autorização é `403 FORBIDDEN`**, com mensagem própria para as três que a pessoa precisa entender: falta de `atribuir_admin`, papel do Owner e papel próprio. Um `42501` vindo do banco (policy ou trigger) também é `403`, nunca `500`. Um `UPDATE` que não altera nenhuma linha é `403`, nunca `200`: a policy filtra em silêncio, e responder sucesso afirmaria uma mudança que não houve.
- O limite do cargo é aplicado pelo schema **antes** de a instrução chegar ao banco, porque a função que mede unidades UTF-16 é quadrática no tamanho.

#### Remover e reativar

(2026-10-07, #98; as decisões 1 e 2 estão pendentes de validação.)

- `…/remove` não tem corpo. `…/reactivate` exige `roleId` no corpo (regra 7) e rejeita papel inexistente com `400 INVALID_ROLE`.
- O estado errado é `409`, nos dois sentidos (seção 4).
- `?status=removed` sem `colaborador.remover`, `colaborador.alterar_papel` nem posse é `403`, depois da guarda e da validação e antes de qualquer leitura. O detalhe de um removido é `404`; a listagem padrão e `status=active` nunca mostram removidos.
- A remoção continua sem regra de "último Admin" (2026-09-24).

#### O item de colaborador

O mesmo formato serve à listagem, ao detalhe, ao `PATCH`, a remover e a reativar: `membershipId`, `name`, `email`, `photoUrl`, `jobTitle`, `role` (`key` e `name`), `isOwner`, `isSelf`, `status` e `joinedAt` (`agency_memberships.created_at`). Não traz remuneração nem o `userId`, que é de outras pessoas.

**`isSelf: boolean`** (2026-10-07, #286, **estrutural**, pendente de validação) é obrigatório em todas as respostas e calculado no servidor: o `user_id` do vínculo é igual ao usuário da sessão. É assim que a tela sabe qual vínculo é o da própria pessoa (seção 7), em vez de comparar e-mails — a operação pode trocar o e-mail, e a tela ficaria sem edição até a sessão ser relida. O Owner sem vínculo não tem linha, então nunca é `isSelf` em lista alguma; o vínculo é da pessoa em cada agência separadamente. Uma próxima rota que devolva uma pessoa de colaborador usa o mesmo item e herda o campo; não o recalcula à mão.

### Rotas que já existem

`POST /agencies/:agencyId/invitations/collaborators`, `POST …/invitations/:invitationId/resend` e `DELETE …/invitations/:invitationId`. A de criação ganha a condição nova da seção 9: o convite com o papel `admin` exige `colaborador.atribuir_admin`, e o **reenvio** de um convite que o carrega também (`403`; sem isso o reenvio devolvia `500`, porque a policy o recusa no banco).

**A criação responde `supersededInvitationId`** (2026-10-07, #333, pendente de validação): `201 { invitationId, expiresAt, supersededInvitationId }`, em que o último é o id do convite ainda válido que a própria criação revogou, ou `null` quando não havia nenhum (um vencido é revogado, mas já não era link). A resposta tem schema próprio; a criação de convite de cliente e o reenvio ficam intactos, e o reenvio não precisa do campo: quem chamou já conhece o convite substituído. A tela usa o campo da resposta, nunca o cache das páginas já carregadas.

**Ordem de trava e `409 TRY_AGAIN`** (#335 e #304, 2026-10-07; decididas pelo maestro, sem pendência de validação registrada):

- Criar e reenviar travam **na mesma ordem**: primeiro o slot dos convites equivalentes (mesma agência, mesmo destinatário), depois a linha do convite. A ordem oposta levava a deadlock (`40P01`) com o mesmo destinatário ao mesmo tempo.
- Deadlock (`40P01`) e falha de serialização (`40001`) em qualquer rota de convite viram `409 TRY_AGAIN`, sem detalhe do banco.
- A **pendência** do convite é decidida **depois** da última trava, quando a versão final da linha já é conhecida, e não no início da transação. Um convite que vence enquanto a requisição espera uma trava passa a ser visto como vencido: reenvio e cancelamento respondem `409 INVITATION_NOT_PENDING`, a aceitação responde `410`, e nada é escrito. A borda exata é o relógio do banco, no fim da espera.

### Listagem

- **24 por página**, ordenada por **nome ascendente, sem distinguir acento nem maiúsculas** (2026-10-07, #355, pendente de validação): `Álvaro`, `ana`, `bruno`, `Éder`, `Zelia` — e não `Zelia`, `ana`, `bruno`, `Álvaro`, `Éder`, que é o que a ordenação por código de caractere produz. A ordem é regra do produto, garantida pela consulta e provada por teste com nomes acentuados e de caixa mista, e não pelo que cada banco entrega (#355). Teto global de 100.
- **Busca** por nome e e-mail; **filtros** por papel, por cargo e por status.
- `status=removed` exige `colaborador.remover`, `colaborador.alterar_papel` ou posse (seção 2); sem isso a API recusa com `403`. Sem o parâmetro, ou com `status=active`, a listagem devolve só `active`.

`GET /agencies/:agencyId/invitations` (convites pendentes) usa o mesmo teto global e o mesmo contrato de página, com tamanho e ordem próprios da rota, como `autorizacao.md` §6 exige: **24 por página**, ordenada por **data de criação ascendente** — convite não tem nome, então a ordem que existe é a de quem está esperando há mais tempo. Sem busca e sem filtro: a issue #99 não pede nenhum.

### Persistência

Nenhuma tabela nova e nenhuma coluna nova — o schema não muda. Mas a migration **não é puramente aditiva**: ela substitui uma policy existente (ver RLS abaixo), e é por isso que a seção 9 está marcada. Depois dela, a migration `20261001000000_job_title_format` acrescentou a `CHECK` e o backfill do cargo (seção 3), e a `20261007000100_reactivation_admin_grant` substituiu o trigger do vínculo no lugar.

Permissões novas no catálogo: `colaborador.visualizar`, `colaborador.remover`, `colaborador.alterar_papel`, `colaborador.alterar_funcao`, `colaborador.atribuir_admin`. As quatro primeiras são concedidas conforme a tabela da seção 2; a última, a nenhum preset.

### RLS

| tabela | o que muda |
|---|---|
| `agency_memberships` | ganha policy de **`UPDATE`**, que não existe hoje. `using` e `with check` exigem `colaborador.alterar_papel`, `colaborador.alterar_funcao` ou `colaborador.remover` — a policy só olha essas três. O `grant` de `UPDATE` é por coluna (`role_id`, `job_title`, `status`, `updated_at`) |
| `agency_memberships` (trigger) | a **regra do valor** vive no trigger `BEFORE UPDATE` `app_private.check_agency_membership_update`, e não na policy: `role_id` exige `alterar_papel`, e `colaborador.atribuir_admin` quando o papel alvo é `admin`; `job_title` exige `alterar_funcao`; `status` para `removed` exige `remover`, e para `active` exige `alterar_papel`. Desde 2026-10-07 a transição `removed` → `active` com o papel `admin` também exige `atribuir_admin`, mude o `role_id` ou não. Só governa `ageniza_app`: o dono do schema e as funções `security definer` que ele possui (`accept_invitation`) ficam fora |
| `invitations` | a policy de **`INSERT` é substituída** para exigir `colaborador.atribuir_admin` quando o convite carrega o papel `admin` |
| `invitations` (trigger) | `revoked_at` e `used_at`, uma vez preenchidos, não mudam de valor nem voltam a `null` (2026-10-06): o estado do convite só anda para frente, e uma revogação feita por engano não se desfaz — cria-se outro convite |

A substituição da policy de `INSERT` é `drop policy` — o gate de CI dispara, e é por isso que a decisão está registrada antes. Ver a seção 9. A API devolve o `403` com mensagem e o banco é a barreira que sobra se alguém esquecer a da API; um teste confere que as duas concordam, para cada ator e cada alteração.

### Armazenamento de identidade

A foto vive em **armazenamento de identidade**, separado do módulo de mídia e **sem consumir quota de agência**. Com a foto dentro da mídia da agência, a pessoa sai dali ou a agência é suspensa e o avatar dela desaparece nas outras — porque o arquivo pertencia ao tenant, não a ela.

O mesmo armazenamento servirá a identidade visual de portal quando a personalização por agência existir.

O **transporte** (presigned como na mídia, ou upload pelo servidor, dado que avatar é pequeno) e os limites de tipo e tamanho são escolha da task de API, seguindo a allowlist já usada pela mídia. Não é regra de negócio.

## 7. Frontend

### Equipe — `/agencia/:agenciaId/colaboradores`

```
┌──────────────────────────────────────────────────────────┐
│  Colaboradores                        [ + Convidar ]     │
│                                                          │
│  [ buscar por nome ou e-mail......]  Papel ▾  Cargo ▾     │
│                                                          │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────┐ │
│  │   ( foto ) │ │   ( AB )   │ │   ( foto ) │ │  …     │ │
│  │  Nome      │ │  Nome      │ │  Nome      │ │        │ │
│  │  Cargo     │ │  Cargo     │ │  Cargo     │ │        │ │
│  │  Papel     │ │  Papel     │ │  Papel     │ │        │ │
│  └────────────┘ └────────────┘ └────────────┘ └────────┘ │
│                                                          │
│  ‹ 1 2 3 ›                          24 de 61 pessoas     │
└──────────────────────────────────────────────────────────┘
```

**Elementos e para que servem**

| elemento | função |
|---|---|
| Crachá | identificação rápida. Quatro informações e nada mais: foto, nome, cargo, papel |
| Foto ou iniciais | quem não enviou foto aparece com as iniciais do nome, nunca com um ícone genérico |
| Papel visível para todos | a equipe precisa saber a quem pedir o que; esconder faria as pessoas descobrirem por tentativa |
| Busca | por nome **e** e-mail, porque quem procura às vezes só lembra do e-mail |
| Filtros | papel e cargo. Cargo é texto livre, então o filtro lista os valores que existem naquela agência (a rota `job-titles`, seção 6) |
| Ordem | por nome, sem distinguir acento nem maiúsculas (seção 6) |
| Convidar | ação primária, visível só para quem tem `colaborador.convidar` |
| Contagem | `totalItems` do contrato de listagem |

**24 por página**, grade de 3 ou 4 colunas conforme a largura — 24 é múltiplo dos dois e nunca deixa linha quebrada.

**A lista não tem estado vazio:** quem olha está nela, e uma agência recém-ativada tem o Owner.

**Busca sem resultado é estado próprio**, e não vazio:

```
│  Nenhuma pessoa encontrada para "mariana"                │
│  [ limpar busca ]                                        │
```

### Detalhe — modal sobre a lista

Abre ao clicar no crachá. A URL reflete a pessoa aberta, para o link ser compartilhável e o "voltar" fechar o modal.

```
┌────────────────────────────────────────────────────────┐
│  ( foto )   Nome                                   ✕   │
│             Cargo · Papel                              │
│             pessoa@exemplo.com                         │
│             Na agência desde 12/03/2026                │
├────────────────────────────────────────────────────────┤
│  [ Detalhes ]  [ Performance ]  [ Entregas ]           │
├────────────────────────────────────────────────────────┤
│                                                        │
│   Cargo        [ Editor de Vídeo............]          │
│   Papel        [ Produção ▾               ]            │
│                                                        │
│                          [ Salvar ]                    │
│                                                        │
│   ─────────────────────────────────────────            │
│   Remover do quadro                                    │
└────────────────────────────────────────────────────────┘
```

**A data "Na agência desde"** aparece no cabeçalho do modal **para todos**, inclusive quando a pessoa abre o **próprio** perfil (2026-10-07, #357, pendente de validação). Ela vem de `joinedAt`, que é `agency_memberships.created_at`.

**Quem é a própria pessoa** a tela sabe por `isSelf` no item de colaborador (seção 6), nunca comparando e-mails.

**Abas.** `Detalhes` no MVP; **`Performance` e `Entregas` existem desabilitadas**, com a razão visível — elas dependem do módulo Conteúdo (entregas e subtarefas), que atribui o trabalho a pessoas (2026-10-07, pendente de validação). Declarar a estrutura agora evita que o modal seja redesenhado quando aquele módulo chegar; o conteúdo das abas é definido por uma issue aberta quando o Conteúdo existir, a partir dos dados reais — seção 10.

**Variação por quem olha**

| quem | o que pode neste modal |
|---|---|
| **Admin** e **Owner** | editam cargo e papel; removem. O Owner é o único que pode conceder `admin` |
| **Gestor de conta** | edita **cargo**; o papel aparece como leitura |
| **Produção, Vendas, Financeiro** | só leem |
| **A própria pessoa** | edita nome e foto; vê a data de entrada ("Na agência desde"), como todos; cargo e papel são leitura, com a nota de que quem muda é quem administra |
| Qualquer um, olhando o **Owner** | sem ação de remover e sem edição de papel |

**E-mail** aparece como leitura em todos os casos, com a nota de que a troca é feita pela operação — nunca um campo desabilitado sem explicação.

**Remover** fica separado do resto, ao pé do modal, e pede confirmação dizendo o que acontece: a pessoa perde o acesso àquela agência e o registro permanece.

### Convites pendentes — seção separada

Visível apenas para quem tem `colaborador.convidar`.

```
┌──────────────────────────────────────────────────────────┐
│  Convites aguardando aceite                     3        │
│                                                          │
│  pessoa@exemplo.com   Produção   expira em 5 dias        │
│                                  [ reenviar ] [ cancelar ]│
│  outra@exemplo.com    Admin      expira amanhã           │
│                                  [ reenviar ] [ cancelar ]│
└──────────────────────────────────────────────────────────┘
```

Separada da equipe de propósito: na mesma lista, a mesma tela mostraria contagens diferentes para pessoas diferentes, e "página 2" passaria a depender de quem olha.

**Vazio:** "Nenhum convite aguardando aceite", com a ação de convidar.

### Removidos — filtro, não seção

Um filtro de status na própria lista, visível só para quem pode ver removidos: `colaborador.remover`, `colaborador.alterar_papel` ou o Owner (seção 2, nota ³). O Gestor de conta não o vê. Crachá de pessoa removida mostra que o vínculo terminou e oferece **reativar** — que **exige escolher o papel de novo**, nunca reaproveita o anterior; a lista de papéis é a da rota `roles`, e `Admin` só aparece nela para o Owner.

**Vazio:** "Ninguém foi removido desta agência".

**Link com `?status=removed` para quem não pode vê-lo** (2026-10-07, #322, pendente de validação): a tela nunca pede o filtro proibido. O parâmetro é ignorado, a listagem cai nos ativos e um aviso diz "Você não tem permissão para ver colaboradores removidos. Mostrando os ativos." O `403` da API continua sendo a barreira; a tela só não o provoca, em vez de transformá-lo num "não encontrado" da página inteira. O aviso não revela a existência de vínculo removido nenhum, então "sem permissão não é tela" continua valendo.

### Convidar — modal pequeno

```
│  Convidar colaborador                                  │
│                                                        │
│  E-mail    [..............................]            │
│  Papel     [ Selecione ▾                  ]            │
│                                                        │
│                       [ Enviar convite ]               │
```

Dois campos, porque o convite carrega dois dados. **`Admin` só aparece na lista de papéis para o Owner** — e se alguém montar a requisição na mão, as duas barreiras recusam. A lista de papéis vem da rota `roles` (seção 6).

Convidar um e-mail que já tem convite pendente **substitui** o anterior: a criação o revoga na mesma transação, e a tela avisa "O convite anterior para este e-mail deixou de valer." quando a resposta traz `supersededInvitationId` (seção 6).

### Estados de tela

| estado | comportamento |
|---|---|
| **Carregando** | skeleton em forma de crachá, na quantidade da página |
| **Erro** | oferece repetir a ação |
| **Sem permissão** | não é tela: o item não aparece no menu e a URL cai em "não encontrado" |
| **Salvando** | estado no próprio botão; ao concluir, a lista é invalidada e o crachá reflete a mudança imediatamente |

## 8. Infraestrutura

**Armazenamento de identidade** — a primeira infraestrutura nova desde a mídia. Separado do bucket de mídia da agência e fora da quota.

Nenhum job, nenhuma fila, nenhum e-mail novo: o convite já tem o seu.

## 9. Impacto estrutural

- [ ] altera tabela que já existe
- [x] **muda formato de resposta que outras rotas copiam** — depois da SPEC, pelo `isSelf` (abaixo)
- [x] **mexe em policies de RLS de mais de um módulo**
- [x] **muda como a autorização é avaliada**
- [x] **exigiria backfill** — pequeno, no cargo (abaixo)

**É estrutural, e a decisão está registrada antes desta implementação:** *"ESTRUTURAL: só o Owner concede o papel de Admin, e a autorização passa a depender do valor"*, em `decisions.md`.

O que a torna estrutural:

- **Dois módulos.** `agency_memberships` ganha a policy de `UPDATE` que falta, e a policy de `INSERT` de `invitations` é **substituída** — `drop policy` dispara o gate de CI.
- **A pergunta muda.** Até aqui `has_agency_permission` responde "tem a chave?". Agora a resposta depende do **valor concedido**. Qualquer regra futura do mesmo tipo segue este formato — duas permissões nomeadas —, não um `if` dentro da rota.

O formato da **listagem** não estava marcado: ela aplica o contrato que a sessão 0 já fixou e passa a ser a referência que as próximas copiam. O que mudou depois da SPEC foi o **item** de colaborador, e as decisões abaixo foram registradas como estruturais em `decisions.md`, todas **pendentes de validação**:

- **`isSelf` no item de colaborador** (2026-10-07, #286) muda o formato de resposta que a listagem, o detalhe, o `PATCH`, remover e reativar compartilham, e que as próximas rotas copiam. É um campo novo, sem migration e sem backfill.
- **O trigger do vínculo também exige `atribuir_admin` na reativação com papel `admin`** (2026-10-07, #98) muda como a autorização é avaliada num ponto que a regra não alcançava: reativar muda `status` e não `role_id`, e quem foi Admin e volta como Admin passava sem a permissão. Migration `20261007000100_reactivation_admin_grant`, trigger substituído no lugar; sem backfill.
- **O cargo com `CHECK` e backfill pequeno** (2026-10-01, #225), migration `20261001000000_job_title_format`: o backfill trata o legado e imprime as contagens; não há truncamento silencioso (seção 3).

## 10. Em aberto

| ponto | gatilho | quem decide |
|---|---|---|
| Remuneração no crachá e no modal | o pedido do dono (2026-10-07, pendente de validação). Fora do MVP: volta como módulo próprio, com SPEC, e as três regras pré-decididas em 2026-09-24 (quem lê, tabela própria, histórico) são o ponto de partida | Pedro Vidal |
| Conteúdo das abas Performance e Entregas | uma issue aberta quando o módulo Conteúdo existir (2026-10-07, pendente de validação), que define as métricas a partir dos dados reais | Pedro Vidal |

Os dois pontos tinham as issues [#109](https://github.com/Nocrato-Tech/ageniza/issues/109) e [#110](https://github.com/Nocrato-Tech/ageniza/issues/110), hoje fechadas com essas decisões. Se o Financeiro básico continua no MVP depois de Tarefas não é tratado aqui: fica a cargo do dono.

**Decisões à espera do dono:** todas as marcadas "pendente de validação" acima estão reunidas na issue [#359](https://github.com/Nocrato-Tech/ageniza/issues/359). Quando o dono responder, a marca sai desta SPEC e a linha `**Validação.**` de cada decisão, em [`docs/business/decisions/`](../docs/business/decisions/), passa a `Validada pelo dono em AAAA-MM-DD.` — a única edição permitida num arquivo de decisão já registrado (README, "Como registrar").

## 11. Decisões registradas

Em [`docs/business/decisions.md`](../docs/business/decisions.md), 2026-09-24:

- Escopo do módulo de colaboradores
- Remuneração pertence ao Financeiro, que entra no MVP depois de Tarefas
- Foto de perfil vive em armazenamento de identidade, separado do módulo de mídia
- Permissões de colaboradores: o Gestor edita cargo, nunca papel
- **ESTRUTURAL:** só o Owner concede o papel de Admin, e a autorização passa a depender do valor
- Proteções de integridade do quadro, e a que não deve existir
- A listagem de colaboradores estreia o contrato de listagem

E, 2026-10-01 (**pendente de validação**):

- Rota própria para os cargos que existem na agência
- CHECK no cargo do vínculo, com backfill pequeno e explícito

E, 2026-10-06:

- Quem lê a lista de papéis atribuíveis (`GET /agencies/:agencyId/roles`) (**pendente de validação**)
- ESTRUTURAL: o estado do convite só anda para frente, e quem garante é o banco

E, 2026-10-07 (**pendente de validação**, salvo a marcada):

- PATCH do vínculo: o corpo, a ordem das recusas e o que o cargo aceita (os itens 6 e 7: o que o cargo contém e a edição do próprio cargo)
- Remuneração fica fora do MVP
- As abas Performance e Entregas ficam desabilitadas, com o motivo, até o Conteúdo
- Remover e reativar: quem vê removidos, o estado errado é 409, e a sessão não é encerrada (as decisões 1 e 2)
- ESTRUTURAL: o trigger do vínculo também exige `atribuir_admin` quando o vínculo volta a `active` com papel `admin`
- O cargo segue a regra de caracteres do nome exibido (o branco que limpa e a ausência de migration)
- Link com `?status=removed` sem permissão cai nos ativos, com aviso
- ESTRUTURAL: o item de colaborador diz se o vínculo é da própria pessoa (`isSelf`)
- A criação de convite de colaborador devolve `supersededInvitationId`
- O modal do próprio perfil mostra a data de entrada, como o wireframe (#357)
- A lista de colaboradores ordena sem distinguir acento nem maiúsculas (#355)

E, 2026-10-07, decididas pelo maestro e **não** incluídas na lista de pendentes de validação (#359):

- A pendência do convite é decidida no fim da espera pela trava, não no início da transação
- Criar e reenviar convite travam na mesma ordem, e o deadlock vira 409 TRY_AGAIN (#335)

E, 2026-10-08, validadas pelo dono (#359):

- O nome no aceite do convite tem o limite do perfil: 120 caracteres (#409; substitui a de 2026-09-30)
- A API recusa editar o próprio cargo e o cargo do Owner (#410; substitui o item 7 da de 2026-10-07 do `PATCH` do vínculo)

Herdadas de [`autorizacao.md`](autorizacao.md): o vocabulário `archived`/`removed`, a reativação que não herda autorização, o contrato de listagem, e as convenções de tela.

## 12. Recorte de implementação

**Épico [#88](https://github.com/Nocrato-Tech/ageniza/issues/88)** — 5 histories, 15 tasks, 2 pontos em aberto.

| history | tasks | escopo |
|---|---|---|
| [#89](https://github.com/Nocrato-Tech/ageniza/issues/89) Ver a equipe | [#95](https://github.com/Nocrato-Tech/ageniza/issues/95) `GET` da listagem · [#102](https://github.com/Nocrato-Tech/ageniza/issues/102) grade de crachás | api · web |
| [#90](https://github.com/Nocrato-Tech/ageniza/issues/90) Ver o detalhe | [#96](https://github.com/Nocrato-Tech/ageniza/issues/96) `GET` do detalhe · [#103](https://github.com/Nocrato-Tech/ageniza/issues/103) modal com abas | api · web |
| [#91](https://github.com/Nocrato-Tech/ageniza/issues/91) Administrar o vínculo | [#94](https://github.com/Nocrato-Tech/ageniza/issues/94) migration `estrutural` · [#97](https://github.com/Nocrato-Tech/ageniza/issues/97) `PATCH` com a regra de admin · [#98](https://github.com/Nocrato-Tech/ageniza/issues/98) remover e reativar · [#104](https://github.com/Nocrato-Tech/ageniza/issues/104) ações no modal · [#105](https://github.com/Nocrato-Tech/ageniza/issues/105) filtro de removidos | db · api · web |
| [#92](https://github.com/Nocrato-Tech/ageniza/issues/92) Gerir convites | [#99](https://github.com/Nocrato-Tech/ageniza/issues/99) `GET` dos pendentes · [#106](https://github.com/Nocrato-Tech/ageniza/issues/106) seção de convites · [#107](https://github.com/Nocrato-Tech/ageniza/issues/107) modal de convidar | api · web |
| [#93](https://github.com/Nocrato-Tech/ageniza/issues/93) Editar o próprio perfil | [#100](https://github.com/Nocrato-Tech/ageniza/issues/100) armazenamento de identidade · [#101](https://github.com/Nocrato-Tech/ageniza/issues/101) `PATCH` do nome e foto · [#108](https://github.com/Nocrato-Tech/ageniza/issues/108) edição no próprio perfil | infra · api · web |

**Em aberto:** [#109](https://github.com/Nocrato-Tech/ageniza/issues/109) remuneração no crachá · [#110](https://github.com/Nocrato-Tech/ageniza/issues/110) abas Performance e Entregas — as duas fechadas em 2026-10-07 com as decisões da seção 10.

**Depois do recorte**, o módulo ganhou issues próprias, que carregam as decisões da seção 11: [#218](https://github.com/Nocrato-Tech/ageniza/issues/218) rota de cargos · [#225](https://github.com/Nocrato-Tech/ageniza/issues/225) `CHECK` do cargo · [#287](https://github.com/Nocrato-Tech/ageniza/issues/287) rota de papéis · [#286](https://github.com/Nocrato-Tech/ageniza/issues/286) `isSelf` · [#322](https://github.com/Nocrato-Tech/ageniza/issues/322) link com filtro de removidos · [#324](https://github.com/Nocrato-Tech/ageniza/issues/324) regra de caracteres do cargo · [#333](https://github.com/Nocrato-Tech/ageniza/issues/333) `supersededInvitationId` · [#304](https://github.com/Nocrato-Tech/ageniza/issues/304) e [#335](https://github.com/Nocrato-Tech/ageniza/issues/335) trava do convite · [#355](https://github.com/Nocrato-Tech/ageniza/issues/355) ordem alfabética · [#357](https://github.com/Nocrato-Tech/ageniza/issues/357) data de entrada no próprio perfil · [#358](https://github.com/Nocrato-Tech/ageniza/issues/358) esta SPEC · [#359](https://github.com/Nocrato-Tech/ageniza/issues/359) validação do dono.

A decisão da #355 define a regra; o código e o teste que a cumprem são o aceite da própria issue. A da #357 já está implementada, com teste.

### A ordem que a dependência impõe

A migration [#94](https://github.com/Nocrato-Tech/ageniza/issues/94) vem **primeira** e destrava tudo: sem a policy de `UPDATE`, as rotas de alteração devolvem sucesso e não mudam nada. Ela e [#97](https://github.com/Nocrato-Tech/ageniza/issues/97) carregam o rótulo `estrutural`.

**Oito das quinze tasks não esperam o designer** — a migration, cinco de API e a de infraestrutura. É a diferença em relação ao épico de auth, onde o backend já existia e onze das doze tasks eram de interface.

As sete de `escopo:web` nascem escritas, com o wireframe e a tabela de elementos no corpo da própria issue, e esperam com `aguardando-design`.
