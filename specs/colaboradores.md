# Colaboradores

| | |
|---|---|
| **Status** | aprovado |
| **Submódulos** | equipe e crachás · detalhe do colaborador · convites pendentes · perfil próprio |
| **Sessões** | 2026-09-24 |
| **Decidido por** | Pedro Vidal, em sessão |

> **A capacidade central deste módulo não existe em nenhuma das duas camadas.** `agency_memberships` tem apenas policy de `SELECT`: trocar o papel de alguém ou remover alguém do quadro hoje encontraria zero linhas no banco. Não é regressão — nunca existiu.
>
> Herda de [`autorizacao.md`](autorizacao.md): o contrato de listagem, os três tratamentos de carregamento, "sem permissão" não é tela, e a invalidação de query depois de cada escrita.

## 1. Propósito

Administrar quem faz parte da agência: quem entra, com que papel, em que cargo, e quem saiu. É o primeiro módulo depois da porta de entrada, e é onde o catálogo de permissões deixa de ser teoria.

### Não resolve

- **Remuneração.** Vai para o módulo Financeiro — seção 10.
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
| Editar o cargo de outro | `colaborador.alterar_funcao` | ✅ | ✅ | — | — | — |
| **Conceder o papel `admin`** | `colaborador.atribuir_admin` | — | — | — | — | — |

¹ já existe no catálogo e já é concedida ao `admin`.

**`colaborador.atribuir_admin` não é concedida a ninguém.** Só o Owner passa nela, porque ele faz curto-circuito na verificação por posse. É uma permissão que existe para que a regra fique no catálogo em vez de num `if`.

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

Convite pendente **não é um estado do vínculo**: é uma linha em `invitations`, com ciclo próprio, e por isso vive em outra seção da tela.

## 5. Regras invioláveis

1. Quem tem `colaborador.visualizar` vê a equipe **inteira** daquela agência: a lista é a mesma para todos, e sua contagem não depende de quem olha.
2. Nome, e-mail e foto de colaborador só são lidos **através de `agency_memberships`**. Uma consulta que alcance `auth."user"` sem o vínculo é defeito, mesmo que a resposta pareça correta.
3. Conceder o papel `admin` — em troca de papel **ou** em convite — exige `colaborador.atribuir_admin`, que nenhum preset possui.
4. O Owner não é removido nem tem o papel alterado por este módulo.
5. Ninguém altera o próprio papel, nem o Admin.
6. Ninguém remove a si mesmo.
7. Reativar um vínculo `removed` sem `role_id` no corpo é rejeitado.
8. O Gestor de conta altera `job_title` e **nunca** `role_id`.
9. Colaborador `removed` não aparece na listagem padrão, e o filtro que o revela exige permissão administrativa.
10. `pageSize` nunca passa de 100; sem parâmetro, são 24.
11. Remover não apaga a linha de `agency_memberships`.
12. Editar o próprio nome ou a própria foto não exige permissão de módulo, e não permite alcançar outra pessoa.

## 6. Backend

### Rotas novas

| método | rota | permissão | devolve |
|---|---|---|---|
| `GET` | `/agencies/:agencyId/collaborators` | `colaborador.visualizar` | `{ data, meta }` paginado |
| `GET` | `/agencies/:agencyId/collaborators/:membershipId` | `colaborador.visualizar` | o detalhe de uma pessoa |
| `PATCH` | `/agencies/:agencyId/collaborators/:membershipId` | `alterar_papel` e/ou `alterar_funcao` | o vínculo atualizado |
| `POST` | `/agencies/:agencyId/collaborators/:membershipId/remove` | `colaborador.remover` | o vínculo em `removed` |
| `POST` | `/agencies/:agencyId/collaborators/:membershipId/reactivate` | `alterar_papel` | o vínculo em `active` |
| `GET` | `/agencies/:agencyId/invitations` | `colaborador.convidar` | convites pendentes, paginado |
| `PATCH` | `/me/profile` | — (identidade) | nome atualizado |
| `POST` | `/me/photo` | — (identidade) | a foto do usuário |

As rotas de perfil **não são escopadas por agência**: o usuário é global, e escopá-las sugeriria que a pessoa tem um nome por tenant.

`PATCH` do vínculo aceita `job_title`, `role_id`, ou os dois — e a permissão exigida é a de cada campo presente no corpo, não a do endpoint.

### Rotas que já existem

`POST /agencies/:agencyId/invitations/collaborators`, `POST …/invitations/:invitationId/resend` e `DELETE …/invitations/:invitationId`. A de criação ganha a condição nova da seção 9.

### Listagem

- **24 por página**, ordenada por **nome ascendente**. Teto global de 100.
- **Busca** por nome e e-mail; **filtros** por papel, por cargo e por status.
- `status=removed` exige permissão administrativa; sem ele, só `active` é devolvido.

### Persistência

Nenhuma tabela nova e nenhuma coluna nova — o schema não muda. Mas a migration **não é puramente aditiva**: ela substitui uma policy existente (ver RLS abaixo), e é por isso que a seção 9 está marcada.

Permissões novas no catálogo: `colaborador.visualizar`, `colaborador.remover`, `colaborador.alterar_papel`, `colaborador.alterar_funcao`, `colaborador.atribuir_admin`. As quatro primeiras são concedidas conforme a tabela da seção 2; a última, a nenhum preset.

### RLS

| tabela | o que muda |
|---|---|
| `agency_memberships` | ganha policy de **`UPDATE`**, que não existe hoje. `using` e `with check` exigem `colaborador.alterar_papel` ou `colaborador.alterar_funcao`, e **exigem `colaborador.atribuir_admin` quando o `role_id` alvo é o papel `admin`** |
| `invitations` | a policy de **`INSERT` é substituída** para exigir `colaborador.atribuir_admin` quando o convite carrega o papel `admin` |

A segunda é `drop policy` — o gate de CI dispara, e é por isso que a decisão está registrada antes. Ver a seção 9.

### Armazenamento de identidade

A foto vive em **armazenamento de identidade**, separado do módulo de mídia e **sem consumir quota de agência**. Com a foto dentro da mídia da agência, a pessoa sai dali ou a agência é suspensa e o avatar dela desaparece nas outras — porque o arquivo pertencia ao tenant, não a ela.

O mesmo armazenamento servirá a identidade visual de portal quando a personalização por agência existir.

O **transporte** (presigned como na mídia, ou upload pelo servidor, dado que avatar é pequeno) e os limites de tipo e tamanho são escolha da task de API, seguindo a allowlist já usada pela mídia. Não é regra de negócio.

## 7. Frontend

### Equipe — `/colaboradores`

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
| Filtros | papel e cargo. Cargo é texto livre, então o filtro lista os valores que existem naquela agência |
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

**Abas.** `Detalhes` no MVP; **`Performance` e `Entregas` existem desabilitadas**, com a razão visível — elas dependem de Tarefas. Declarar a estrutura agora evita que o modal seja redesenhado quando aquele módulo chegar.

**Variação por quem olha**

| quem | o que pode neste modal |
|---|---|
| **Admin** e **Owner** | editam cargo e papel; removem. O Owner é o único que pode conceder `admin` |
| **Gestor de conta** | edita **cargo**; o papel aparece como leitura |
| **Produção, Vendas, Financeiro** | só leem |
| **A própria pessoa** | edita nome e foto; cargo e papel são leitura, com a nota de que quem muda é quem administra |
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

Um filtro de status na própria lista, visível só para Admin e Owner. Crachá de pessoa removida mostra que o vínculo terminou e oferece **reativar** — que **exige escolher o papel de novo**, nunca reaproveita o anterior.

**Vazio:** "Ninguém foi removido desta agência".

### Convidar — modal pequeno

```
│  Convidar colaborador                                  │
│                                                        │
│  E-mail    [..............................]            │
│  Papel     [ Selecione ▾                  ]            │
│                                                        │
│                       [ Enviar convite ]               │
```

Dois campos, porque o convite carrega dois dados. **`Admin` só aparece na lista de papéis para o Owner** — e se alguém montar a requisição na mão, as duas barreiras recusam.

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
- [ ] muda formato de resposta que outras rotas copiam
- [x] **mexe em policies de RLS de mais de um módulo**
- [x] **muda como a autorização é avaliada**
- [ ] exigiria backfill

**É estrutural, e a decisão está registrada antes desta implementação:** *"ESTRUTURAL: só o Owner concede o papel de Admin, e a autorização passa a depender do valor"*, em `decisions.md`.

O que a torna estrutural:

- **Dois módulos.** `agency_memberships` ganha a policy de `UPDATE` que falta, e a policy de `INSERT` de `invitations` é **substituída** — `drop policy` dispara o gate de CI.
- **A pergunta muda.** Até aqui `has_agency_permission` responde "tem a chave?". Agora a resposta depende do **valor concedido**. Qualquer regra futura do mesmo tipo segue este formato — duas permissões nomeadas —, não um `if` dentro da rota.

O formato de resposta **não** está marcado: esta é a primeira listagem, mas ela aplica o contrato que a sessão 0 já fixou. Ela passa a ser a referência que as próximas copiam.

## 10. Em aberto

| ponto | gatilho | quem decide |
|---|---|---|
| Remuneração no crachá e no modal | a entrevista do módulo Financeiro | Pedro Vidal |
| Conteúdo das abas Performance e Entregas | a primeira entrevista que criar tarefa atribuível a colaborador | Pedro Vidal |

## 11. Decisões registradas

Em [`docs/business/decisions.md`](../docs/business/decisions.md), 2026-09-24:

- Escopo do módulo de colaboradores
- Remuneração pertence ao Financeiro, que entra no MVP depois de Tarefas
- Foto de perfil vive em armazenamento de identidade, separado do módulo de mídia
- Permissões de colaboradores: o Gestor edita cargo, nunca papel
- **ESTRUTURAL:** só o Owner concede o papel de Admin, e a autorização passa a depender do valor
- Proteções de integridade do quadro, e a que não deve existir
- A listagem de colaboradores estreia o contrato de listagem

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

**Em aberto:** [#109](https://github.com/Nocrato-Tech/ageniza/issues/109) remuneração no crachá · [#110](https://github.com/Nocrato-Tech/ageniza/issues/110) abas Performance e Entregas.

### A ordem que a dependência impõe

A migration [#94](https://github.com/Nocrato-Tech/ageniza/issues/94) vem **primeira** e destrava tudo: sem a policy de `UPDATE`, as rotas de alteração devolvem sucesso e não mudam nada. Ela e [#97](https://github.com/Nocrato-Tech/ageniza/issues/97) carregam o rótulo `estrutural`.

**Oito das quinze tasks não esperam o designer** — a migration, cinco de API e a de infraestrutura. É a diferença em relação ao épico de auth, onde o backend já existia e onze das doze tasks eram de interface.

As sete de `escopo:web` nascem escritas, com o wireframe e a tabela de elementos no corpo da própria issue, e esperam com `aguardando-design`.
