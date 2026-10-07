# <Módulo>

> Copie este arquivo para `specs/<modulo>.md` e apague as instruções em citação.
> O processo que gera este documento está em [docs/business/module-process.md](../docs/business/module-process.md).

| | |
|---|---|
| **Status** | rascunho · em revisão · aprovado · implementado |
| **Submódulos** | |
| **Sessões** | datas das entrevistas |
| **Decidido por** | quem aprovou |

## 1. Propósito

O que este módulo resolve, em duas ou três frases.

### Não resolve

O que fica explicitamente de fora, e para onde vai. Esta seção evita que a próxima conversa reabra o escopo.

## 2. Atores e autorização

Quem opera o módulo e com que permissão nomeada. Uma linha por capacidade, não por papel — papel é preset, permissão é a autorização.

| capacidade | permissão | quem tem no preset |
|---|---|---|
| | | |

> Owner tem acesso total por posse, não por papel. Visibilidade de menu é UX; a autorização é validada no backend em toda operação.

## 3. Entidades e campos

O que é invariante do domínio. Campo que existe só porque a tela pede não entra aqui.

### <Entidade>

| campo | tipo | obrigatório | regra |
|---|---|---|---|
| | | | |

**Pertence a:** agência? cliente? outra entidade?
**Relações:** com o quê, e em que cardinalidade.

## 4. Estados e transições

As transições legítimas e o que cada uma exige. Estado derivado de data — "atrasado", "publica em X dias" — é calculado, nunca persistido.

```
ESTADO_A → ESTADO_B   # quem pode, e o que exige
```

## 5. Regras invioláveis

O que nunca pode acontecer. Cada linha daqui deve virar um teste; regra que nenhum teste verifica diverge do código em semanas.

- 

## 6. Backend

### Rotas

| método | rota | permissão | devolve |
|---|---|---|---|
| | | | |

### Persistência

Tabelas novas, colunas novas, índices. Migration que toca tabela existente é mudança estrutural — ver seção 9.

### RLS

Quais policies, e por qual coluna o isolamento acontece. Toda tabela de negócio tem RLS, e a aplicação nunca a contorna.

## 7. Frontend

### Telas

| tela | rota | o que mostra | quem acessa |
|---|---|---|---|
| | | | |

### Esboço

Baixa fidelidade: o que existe em cada tela e onde. Sem cor, sem tipografia, sem espaçamento.

**Esta seção é a especificação da tela.** Ela não descreve o design final — descreve o que a tela precisa resolver, e é dela que a tela é implementada, só com componentes e tokens do [design system](../docs/design-system.md). O designer refina depois, sobre a tela já funcionando.

```
┌─────────────────────────────┐
│                             │
└─────────────────────────────┘
```

### Variação por papel

O que some, o que fica somente leitura, o que muda de texto conforme quem olha.

### Estados da tela

- **Vazio:** o que aparece quando não há nada ainda, e qual é a ação de saída.
- **Carregando:**
- **Erro:** o que a pessoa vê, e o que ela consegue fazer a respeito.
- **Sem permissão:** a tela não existe no menu, mas a URL pode ser digitada.

## 8. Infraestrutura

Só se houver: job no worker, armazenamento, e-mail, fila, agendamento. Diga também quando não há.

## 9. Impacto estrutural

Confrontar com [structural-changes.md](../docs/business/structural-changes.md). Se qualquer condição for verdadeira, a decisão é registrada em `docs/business/decisions/` **antes** da implementação, dita como estrutural.

- [ ] altera tabela que já existe
- [ ] muda formato de resposta que outras rotas copiam
- [ ] mexe em RLS de mais de um módulo
- [ ] muda como a autorização é avaliada
- [ ] exigiria backfill

## 10. Em aberto

Todo item precisa de um **gatilho**: o evento que obriga a decisão. Sem gatilho, não é item em aberto — é dívida invisível.

| ponto | gatilho | quem decide |
|---|---|---|
| | | |

## 11. Decisões registradas

Links para as entradas correspondentes em [decisions/](../docs/business/decisions/). Aqui fica só o índice; o texto da decisão vive lá.

- 

## 12. Recorte de implementação

O que esta SPEC gera no GitHub.

**History:** 

| task | escopo | depende de |
|---|---|---|
| | | |
