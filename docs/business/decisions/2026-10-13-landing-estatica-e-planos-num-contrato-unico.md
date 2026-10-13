# Landing estática, separada do app, e planos num contrato único

**Data.** 2026-10-13

**Contexto.** A landing (produto, funcionalidades, planos) muda com frequência e precisa de SEO e carregamento rápido; o app é uma SPA autenticada, com CSP e cookies próprios.

**Decisão.** A landing é um site estático no mesmo repositório, separado do app (por exemplo `ageniza.com.br` e `app.ageniza.com.br`). Nomes, preços, limites e adicionais dos planos vivem num contrato versionado no repositório, consumido pela landing e pelo app; ninguém copia a tabela à mão. O backend continua sendo a autoridade sobre o preço e o limite aplicados.

**Consequência.** Em aberto, com gatilho: construtor visual ou CMS, quando marketing precisar publicar sem desenvolvimento com frequência, integrado ao mesmo contrato.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
