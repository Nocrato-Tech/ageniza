# Módulo só é implementado depois de fechado nas três frentes, com SPEC no repositório
**Data.** 2026-09-23

**Contexto.** A decisão anterior tirou o escopo dos módulos do Notion, mas não disse como ele seria produzido aqui. O repositório mostra o resultado de não ter esse fluxo: a API tem cinco módulos implementados e `apps/web/src` não tem uma tela — backend inteiro primeiro, interface depois, com o modelo de dados nunca confrontado por uma tela. A própria leitura das páginas do Notion deixou claro que decisão de produto espalhada entre issue, comentário e conversa não sobrevive à entrada de mais gente no time.

**Decisão.** Todo módulo passa por quatro fases, descritas em [module-process.md](module-process.md): entrevista de escopo em sete blocos, consolidação numa SPEC em `specs/<modulo>.md`, recorte em issues (*history* + *tasks* por frente) e fechamento com a SPEC corrigida no mesmo PR que divergir dela. A SPEC cobre backend, frontend e UX no mesmo documento, e nenhum módulo novo começa a ser implementado sem ela — `AGENTS.md` passa a exigir isso.

Três regras sustentam o fluxo:

- **UX é o último bloco da entrevista, e é esboço.** Tela desenhada antes de estado definido inventa estado; direção de arte não entra na sessão de escopo.
- **Fechar o módulo é passar por todas as frentes, não zerar dúvidas.** Ponto em aberto é esperado — mas só é válido com **gatilho**, o evento que obriga a decisão. Sem gatilho é dívida invisível.
- **Decisão fechada é registrada na hora**, aqui, marcada como pendente de validação enquanto ninguém validou. A SPEC consolida depois; a decisão não espera.

**Consequência.** Cada módulo passa a custar uma sessão antes da primeira linha de código, e a entrada de devs novos depende de a SPEC existir e estar honesta. Em troca, a issue deixa de ser o lugar onde a regra de negócio nasce. Duas consequências imediatas: as páginas do Notion viram insumo histórico explícito — `AGENTS.md` não as trata mais como autoritativas — e **autenticação e convite ficam com débito de frontend reconhecido**, porque pelo critério deste fluxo o módulo não está fechado: login, aceite de convite, criação de conta com Termos e troca de contexto nunca foram desenhados.

**Origem.** Decidido em sessão, a partir da leitura das páginas de domínio e de permissões do Notion.

