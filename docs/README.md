# Índice da documentação

Encontre o documento certo pela tarefa. Cada linha diz **que pergunta o documento responde** e **quando ler**. Leia só o que a tarefa pede: a regra de negócio está em `business/`, a de implementação nos documentos da tarefa, e `AGENTS.md` traz os invariantes que valem sempre.

## Começar

- [Primeiros passos](onboarding.md) — o roteiro de entrada no projeto. **Leia quando:** você acabou de chegar e não sabe por onde começar.
- [Visão do produto](business/product-overview.md) — o que é o Ageniza, quem são os papéis e os fluxos. **Leia quando:** precisar entender o domínio antes de qualquer código.
- [Ambiente local](local-environment.md) — como sair de um clone novo para um ambiente que roda o produto. **Leia quando:** for preparar a máquina ou subir o banco e a API.
- [Negócio](business/README.md) — o índice da pasta de regras de negócio. **Leia quando:** quiser saber onde fica cada tipo de regra.

## Antes de implementar algo novo

- [Mudanças estruturais](business/structural-changes.md) — quando uma mudança altera tabela, RLS entre módulos, autorização ou exige backfill. **Leia quando:** for implementar qualquer coisa nova, antes de escrever código.
- [Como um módulo é fechado](business/module-process.md) — a ordem entre entrevista, SPEC, issues e implementação. **Leia quando:** for abrir um módulo novo ou dúvida sobre quando ele pode começar.

## Implementar migration ou tabela

- [ADR 0011: PostgreSQL self-hosted e Better Auth](adr/0011-self-hosted-postgres-and-better-auth.md) — por que o banco e a autenticação são próprios, e não Supabase. **Leia quando:** for mexer no banco, em papéis do PostgreSQL ou na autenticação.

## Implementar rota da API

- [Anatomia de um módulo da API](module-anatomy.md) — onde cada arquivo de um módulo mora e como ele é registrado. **Leia quando:** for criar módulo, rota ou permissão nova.
- [Referência da API](api/README.md) — como a API autentica e quais erros devolve. **Leia quando:** for definir resposta, erro ou autenticação de uma rota.
- [Contrato OpenAPI](api/openapi.json) — o documento gerado a partir dos schemas. **Leia quando:** for conferir o formato exato de uma rota já publicada. Não edite à mão.

## Implementar tela

- [Design system](design-system.md) — tokens, cores, espaçamento e componentes permitidos na interface. **Leia quando:** for escrever qualquer estilo ou componente de tela.
- [SPEC de autenticação, convite e contexto](../specs/auth.md) — telas de login, convite e troca de contexto. **Leia quando:** for implementar ou alterar essas telas.
- [SPEC de autorização e transversais](../specs/autorizacao.md) — catálogo de permissões, papéis e convenções de tela que todos os módulos herdam. **Leia quando:** for implementar qualquer tela com permissão.
- [SPEC de clientes](../specs/clientes.md) — carteira, detalhe, estudo de marca, acessos ao portal e encerramento. **Leia quando:** for implementar ou alterar o módulo de clientes.
- [SPEC de colaboradores](../specs/colaboradores.md) — equipe, convites pendentes e perfil próprio. **Leia quando:** for implementar ou alterar o módulo de colaboradores.
- [SPEC de conteúdo](../specs/conteudo.md) — calendário, aprovação, mídia e portal do cliente. **Leia quando:** for implementar o módulo de conteúdo (ainda em revisão).
- [Modelo de SPEC](../specs/TEMPLATE.md) — a estrutura de uma SPEC nova. **Leia quando:** for escrever a SPEC de um módulo que ainda não existe.

## Revisar segurança

- [Revisão de segurança](security-review.md) — o roteiro de ataque para PRs de banco, autenticação, convite, armazenamento ou dado pessoal. **Leia quando:** for revisar ou se preparar para revisar um PR sensível.

## Revisar código e abrir PR

- [Checklist do implementador](implementation-checklist.md) — o que conferir antes de abrir ou atualizar um PR, incluindo as mutações que provam cada aceite. **Leia quando:** for abrir ou atualizar um PR.
- [Integração contínua](ci/README.md) — o que o workflow de CI roda e como reproduzir localmente. **Leia quando:** o CI falhar ou for preciso rodar os mesmos portões na máquina.

## Decisões de negócio

- [Decisões de negócio](business/decisions/) — a pasta com o registro cronológico, uma decisão por arquivo, nomeada `AAAA-MM-DD-<slug>.md`. Busque por data e título. **Leia quando:** quiser saber o que já foi decidido e por quê.
- [Decisões de negócio (arquivo antigo)](business/decisions.md) — arquivo de compatibilidade que não recebe mais entradas; as citações antigas se acham pelo título. **Leia quando:** encontrar uma citação de `decisions.md` e precisar achar a decisão.

## Operação e infraestrutura

- [ADR 0010: deploy na VPS e borda](adr/0010-vps-edge-and-production-deployment.md) — o mecanismo de deploy controlado; a parte de borda foi substituída pelo ADR 0012. **Leia quando:** for mexer no processo de release.
- [ADR 0012: Cloudflare Tunnel como borda pública](adr/0012-cloudflare-tunnel-edge.md) — por que a entrada pública usa Cloudflare Tunnel e não Caddy. **Leia quando:** for mexer na exposição pública do sistema.
- [Observabilidade](observability.md) — formato de logs, health e ready, e o que nunca logar. **Leia quando:** for adicionar log, probe ou erro novo.
- [Docker](infra/docker.md) — a stack local em containers. **Leia quando:** for subir, parar ou resetar a stack Docker.
- [Baseline da VPS Ubuntu](infra/vps-baseline.md) — como preparar o host limpo. **Leia quando:** for provisionar ou reconstruir o servidor.
- [Deploy e rollback em produção](infra/production-deploy.md) — o runbook de release e reversão. **Leia quando:** for publicar ou reverter uma versão.
- [Checklist de prontidão para produção](infra/production-readiness.md) — as ações humanas pendentes antes do lançamento. **Leia quando:** for agendar ou revisar o lançamento em produção.
- [Backup e restauração](infra/backup-restore.md) — o backup diário do banco e como restaurar. **Leia quando:** for verificar, testar ou restaurar um backup.
