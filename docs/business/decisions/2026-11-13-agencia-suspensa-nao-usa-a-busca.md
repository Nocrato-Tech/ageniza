# A agência suspensa não usa a busca da barra superior

**Data.** 2026-11-13

**Contexto.** A SPEC da busca (`specs/busca.md`, seção 2) dizia que a agência suspensa ou em somente leitura "pode buscar (é leitura)". Na implementação, a guarda de acesso à agência fecha a agência suspensa para toda rota com `404 Agency not found.`, e a busca passa por ela como as demais. A revisão da rota levantou a dúvida: a intenção era a suspensa buscar também, o que exigiria abrir uma exceção na guarda?

**Decisão.**

1. A agência em **somente leitura** (teste encerrado) busca normalmente.
2. A agência **suspensa** não busca: recebe o mesmo `404` que recebe em qualquer outra rota. A busca não abre exceção na guarda de acesso, e a guarda fica como está.

**Substitui.** A linha da seção 2 de `specs/busca.md` que dizia que a agência suspensa pode buscar. A decisão [`2026-11-11-busca-na-agencia-e-no-portal`](2026-11-11-busca-na-agencia-e-no-portal.md) não tratava da suspensa e segue valendo.

**Consequência.**

- Nenhum código muda: a rota já responde `404` à agência suspensa, e o teste da busca grava `status = 'suspended'` de verdade para provar.
- A SPEC da busca (seções 2 e 12) e o fluxo mobile da agência passam a dizer o que a rota faz.
- Mudar a guarda para deixar a suspensa ler seria decisão estrutural própria, fora da busca.

**Origem.** Decisão do dono do produto em 2026-11-13, respondendo à pergunta do maestro sobre a revisão de segurança da rota de busca.

**Validação.** Validada pelo dono em 2026-11-13.
