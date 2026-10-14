# A página /design-system existe só no ambiente de desenvolvimento

**Data.** 2026-10-14

**Contexto.** A decisão de 2026-09-28 (o repositório é a fonte do design system, com documento e página viva) previa a rota `/design-system`, que nunca foi criada. A issue #641 pede a página, e a pergunta aberta era onde ela vive: em produção ela expõe a lista de tokens e componentes a quem não é da equipe, sem ganho para o produto.

**Decisão.**
1. A rota `/design-system` só é registrada quando `import.meta.env.DEV` é verdadeiro (servidor de desenvolvimento do Vite). O build de produção não a contém: nem a rota, nem a página, nem o CSS dela, e o endereço cai no "página não encontrada" comum.
2. A página não entra em nenhum menu e não exige sessão, para abrir sem depender da API local.
3. Os valores dos tokens são lidos dos arquivos de `apps/web/src/styles` como texto (`?raw`), nunca copiados à mão: um token novo aparece sozinho.
4. Os componentes vêm de um registro (`apps/web/src/design-system/components.tsx`) e um teste reprova quando um componente exportado por `@ageniza/ui` não consta nele: componente novo entra na página no mesmo PR que o cria.
5. Hover e foco são mostrados em instâncias reais (passe o mouse, navegue com Tab), sem estado forçado por classe, para a página não depender de CSS de componente além do que o app já usa.

**Consequência.** Um build "de homologação" (build de produção apontado para outra API) também não tem a página. Quem precisar dela sobe `pnpm --filter @ageniza/web dev`. O vitest passa a carregar os arquivos `.css?raw` com conteúdo (`test.css.include`), porque por padrão ele os entrega vazios.

**Origem.** Issue #641, épico #621; decisão de 2026-09-28.

**Validação.** Pendente de validação do dono.
