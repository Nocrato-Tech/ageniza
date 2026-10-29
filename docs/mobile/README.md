# Ageniza no celular — ponto de partida

O Ageniza organiza a produção de conteúdo entre uma **agência** e os **clientes** dela: a agência planeja, produz e envia posts para aprovação; o cliente aprova ou pede ajuste pelo portal ou por um link no e-mail.

Esta pasta é para quem vai construir o app em Expo. Ela descreve **o que o backend já faz hoje**; arquitetura, telas e design do app são decisão do time mobile.

## Por onde começar

1. [Começar o projeto](comecar.md): ambiente, como a API autentica, o que falta no backend para o app e as regras de compatibilidade.
2. Os fluxos, um arquivo por quem usa:

| arquivo | quem | o que tem |
|---|---|---|
| [Entrada](fluxos/entrada.md) | qualquer pessoa | cadastro, confirmação do e-mail, login, Google, senha, convite, termos e a escolha do contexto |
| [Agência](fluxos/agencia.md) | equipe da agência | clientes, conteúdos, subtarefas, roteiros de stories, mídias, conversas, equipe e assinatura |
| [Portal do cliente](fluxos/portal.md) | pessoa do cliente com conta | início, aprovar ou pedir ajuste, conversar, roteiros |
| [Link de aprovação](fluxos/link-de-aprovacao.md) | pessoa do cliente sem login | aprovar o lote que chegou por e-mail |

## Referências

- [Referência da API](../api/README.md): cada rota com acesso, permissão, exemplo de corpo e erros. Gerada do código; é a fonte da verdade dos contratos.
- [`openapi.json`](../api/openapi.json): o mesmo em OpenAPI 3.1, para gerar cliente.
- `packages/contracts`: os schemas zod de onde a referência sai.
- `specs/`: as especificações completas de cada módulo, quando o fluxo daqui não bastar.

## Palavras do produto

| termo | significado |
|---|---|
| Agência | o cliente pagante do Ageniza; tem equipe, clientes e assinatura |
| Owner | quem criou a agência; acesso total e o único que gerencia a assinatura |
| Colaborador | pessoa da equipe, com um papel (Admin, Gestor de conta, Produção, Vendas, Financeiro) |
| Cliente | a marca atendida pela agência |
| Pessoa do portal | alguém do cliente com acesso ao portal |
| Contexto | onde a pessoa está atuando: uma agência ou um cliente. A mesma conta pode ter vários |
| Conteúdo | um post planejado, com data, formato, legenda e mídia |
| Lote | os conteúdos enviados juntos para aprovação num e-mail |

> Esta pasta acompanha o produto: todo PR que muda um fluxo atualiza o arquivo do fluxo aqui.
