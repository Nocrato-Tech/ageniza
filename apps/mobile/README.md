# Ageniza Mobile

Aplicativo React Native + Expo Go reconstruído a partir das telas aprovadas no Figma. A interface usa Sora/Inter, tema claro, navegação inferior, clientes em stories e prévia do Instagram.

## Rodar

Na raiz, com Node 22 e pnpm 9.15.4:

```sh
pnpm install --frozen-lockfile
pnpm --filter @ageniza/contracts build
pnpm --filter @ageniza/mobile start
```

No Expo Go, escaneie o QR do Metro. SDK 54; no Android use o cliente compatível em https://expo.dev/go. Para túnel temporário, use `pnpm --filter @ageniza/mobile preview`.

## Funcionalidades

Clientes, conteúdos em lista/kanban/calendário, criação e edição em três etapas, biblioteca e upload de mídia, prévia do Instagram, tarefas, comentários, aprovação e ajustes no portal. Os mesmos componentes usam um repositório real autenticado ou um repositório de demonstração explicitamente separado. Equipe, relatórios calculados e exportação CSV também estão disponíveis. As continuações do Figma são páginas roláveis.

A prévia web abre diretamente a demonstração persistente. As alterações ficam no aparelho/navegador, e podem ser reiniciadas nas configurações. Não é necessário e-mail ou senha para testar. O login real está no Expo Go: a origem nativa foi liberada no dev na #803. A origem web da Vercel não foi liberada, portanto não há login real nela nem proxy que contorne essa restrição.

Google, notificações push e um modelo de ML validado com dados reais continuam pendentes. O experimento local de k-NN é identificado como treinado em exemplos sintéticos. A demonstração não publica no Instagram nem envia e-mail.

Leia [o mapa das telas, integrações, limites e evidências](../../docs/mobile/interface-mobile.md) e [o guia da API mobile](../../docs/mobile/comecar.md).

## Verificar

```sh
pnpm --filter @ageniza/mobile lint
pnpm --filter @ageniza/mobile typecheck
pnpm --filter @ageniza/mobile test
pnpm --filter @ageniza/mobile exec expo install --check
pnpm --filter @ageniza/mobile build
```

A exportação gera bundles, não APK e não prova execução no aparelho. `eas.json` prepara um APK interno depois de vincular uma conta/projeto Expo; esta máquina ainda não possui autenticação EAS. Login real, persistência no SecureStore, troca de contexto e logout no dispositivo precisam de validação com uma conta antes de afirmar conclusão da integração nativa.

## Vercel

A publicação está em https://mobile-vercel-preview.vercel.app/. O artefato web exportado é publicado no projeto `mobile-vercel-preview`, da equipe `marcosvmgs-projects`. Isso não configura integração Git automática. Para importar o monorepo na Vercel, use Root Directory `apps/mobile`, cuja configuração está em `vercel.json`.
