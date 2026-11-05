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

### Demonstração no aplicativo completo

No web dev, `EXPO_PUBLIC_DEMO_WORKSPACE=true` habilita exemplos dentro da aplicação oficial. Login, cadastro, confirmação do e-mail, termos e permissões continuam reais. No seletor de contexto, a pessoa pode confirmar a criação de uma agência própria com clientes, pastas, imagem, conteúdos e tarefas fictícios gravados pela API. Falhas parciais oferecem retomada e acesso ao que já foi criado. Não há repositório local substituindo o backend.

ML está no detalhe dos conteúdos (treino sintético explicitamente identificado), avisos locais na tela Notificações e pagamento simulado no plano/assinatura quando o servidor oferece esse provedor. A preparação não envia convites automaticamente. Leia [a SPEC](../../specs/demonstracao-mobile.md).

`pnpm --filter @ageniza/mobile build:presentation` agora exporta e confere o aplicativo completo com base `/app-mobile/`, sem uma aplicação separada de apresentação. Saída: `launch-dist/presentation`. A imagem web dev habilita o mesmo recurso; produção não.

Clientes, conteúdos em lista/kanban/calendário, criação e edição em três etapas, biblioteca e upload de mídia, prévia do Instagram, tarefas, comentários, aprovação e ajustes no portal. Todos os módulos usam o repositório real autenticado. Equipe, relatórios calculados e exportação CSV também estão disponíveis. As continuações do Figma são páginas roláveis.

O aplicativo abre no login e exige uma conta e contexto válidos para entrar. A área de trabalho consome a API real e não troca erros de integração por dados de demonstração. Cadastro, convite, recuperação, gestão de clientes/equipe, estudo de marca, roteiros e perfil usam os contratos existentes.

A exportação web em outra origem não equivale ao cliente nativo autenticado: cookies e CSRF continuam sujeitos ao servidor. O ambiente de desenvolvimento aceita `expo-origin: ageniza://` para o cliente nativo. Não há proxy para contornar a política.

Ainda faltam validação física, revisão de segurança, pagamento de produção, Google seguro (#799), ML validado e distribuição assinada. Consulte [prontidão de lançamento](../../docs/mobile/prontidao-lancamento.md) antes de tratar esta implementação como pronta para clientes reais.

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
