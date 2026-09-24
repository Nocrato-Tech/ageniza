# Anatomia de um módulo da API

O `AGENTS.md` diz que módulo novo, permissão nova e tabela nova "se encaixam no padrão existente". Este documento é esse padrão, escrito — para que a pessoa que escrever o sexto módulo não precise adivinhá-lo lendo os cinco primeiros.

A API é um **monolito modular**. Cada módulo de domínio vive em `apps/api/src/modules/<nome>` e é registrado em `apps/api/src/app.ts`. Módulo **não vira pacote** por padrão: `packages/` é infraestrutura compartilhada, e não existe um `packages/shared` genérico.

## Os arquivos

Nenhum módulo tem todos; cada um tem os que precisa.

| arquivo | responsabilidade |
|---|---|
| `routes.ts` | registra as rotas e **exporta `register<Nome>Module`**. É a única porta de entrada do módulo |
| `service.ts` | o SQL e as regras. Recebe a transação, nunca abre uma por conta própria |
| `policy.ts` | limites e constantes de política — tamanhos, prazos, tetos |
| `guards.ts` | pré-condições reutilizáveis por outros módulos (é o caso de `tenancy`) |
| `<nome>.integration.test.ts` | o aceite do módulo, contra o banco real |
| `README.md` | o que o módulo resolve e o que ficou fora. Todo módulo deveria ter |

Os contratos HTTP **não ficam aqui**: vivem em `packages/contracts`, porque o navegador também os importa. Um módulo que valida entrada e saída com schema próprio está duplicando o contrato.

## Como um módulo é registrado

`routes.ts` exporta uma função de registro que recebe suas dependências por parâmetro — banco, autenticação, guards de outro módulo. Nada é importado de um singleton global, e é isso que torna o módulo testável sem subir a aplicação inteira.

```ts
export const registerClientModule = (app: FastifyInstance, dependencies: ClientModuleDependencies): void => {
  // ...
};
```

Quando um módulo precisa de uma guarda que pertence a outro, ela é **injetada**, não reimplementada. O módulo `contexts` recebe `requireClientAccess` do `tenancy` exatamente por isso: duas cópias da mesma regra divergem, e a que diverge sem ninguém perceber é a que vira falha de autorização.

## As duas barreiras

Toda operação sobre dado de tenant passa por duas checagens independentes, e **nenhuma substitui a outra**:

1. **API** — `requireAgencyAccess` popula `request.tenant` com o contexto, e `requirePermission('<modulo>.<acao>')` exige a permissão nomeada.
2. **Banco** — a policy de RLS da tabela chama `app_private.has_agency_permission(agency_id, '<modulo>.<acao>')`.

Uma falha na API ainda encontra o banco. Remover uma delas porque "a outra já cobre" desfaz o desenho inteiro.

Como a autorização é avaliada, e o formato do catálogo de permissões, estão em [`specs/autorizacao.md`](../specs/autorizacao.md).

## O que acompanha um módulo novo

- **Migration** em `packages/database/migrations`, criando as tabelas **com RLS habilitada** e as policies. Migration aplicada nunca se edita.
- **Permissões** inseridas no catálogo: `<modulo>.visualizar`, `<modulo>.operar`, e uma por ação administrativa ou destrutiva.
- **Preset de papel** — a SPEC do módulo diz o que cada um dos cinco papéis pode. Sem essa linha a SPEC está incompleta.
- **Contratos** em `packages/contracts`, usando o contrato de paginação existente quando houver listagem.
- **Teste de integração** contra o banco real, cobrindo as regras invioláveis da SPEC **e** o isolamento entre tenants.
- **README do módulo**, dizendo o que ele resolve e o que ficou de fora.

## Listagem

A primeira listagem já foi desenhada, e todas copiam: paginação por página com `packages/contracts/src/pagination.ts`, teto global de 100 itens, tamanho padrão declarado por rota na SPEC, filtro e ordenação como parâmetros nomeados. Bloco de resumo não pagina.

Os detalhes estão na seção 6 de [`specs/autorizacao.md`](../specs/autorizacao.md).

## Ciclo de vida

Entidade de negócio usa `archived`; vínculo entre pessoa e tenant usa `removed`. **Nenhuma rota da aplicação apaga fisicamente entidade de negócio.** Introduzir um `DELETE` de verdade reabre uma decisão registrada.

## Os módulos de hoje

| módulo | o que resolve |
|---|---|
| `auth` | login, sessão, recuperação de senha |
| `invitations` | os três tipos de convite, aceite e criação de conta |
| `tenancy` | as guardas de acesso à agência e ao cliente. Exporta; não tem rota |
| `contexts` | listagem, resolução e troca de contexto |
| `media` | upload direto, confirmação e URLs assinadas |
| `system` | saúde e prontidão |

O worker é outro processo, em `apps/worker`, e consome uma fila durável no próprio PostgreSQL. Módulo de API que precisa de trabalho assíncrono **enfileira**, e não executa: o padrão está em `apps/api/src/modules/media/job-dispatcher.ts`.
