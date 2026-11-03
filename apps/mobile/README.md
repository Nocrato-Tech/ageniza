# Ageniza Mobile

Primeiro incremento nativo em React Native e Expo, dentro do monorepo. Consome os contratos existentes de `@ageniza/contracts` e a API real do ambiente dev. Não contém contas, senha, token de teste nem banco local.

## Rodar no Expo Go

Na raiz, com Node 22.14.x e pnpm 9.15.4:

```sh
pnpm install
pnpm --filter @ageniza/contracts build
pnpm --filter @ageniza/mobile start
```

Escaneie o QR pelo Expo Go. O SDK 54 foi escolhido para compatibilidade com o Expo Go disponível na App Store; no Android, pode ser necessário instalar o cliente compatível em <https://expo.dev/go>. O código nativo usa `expo-origin: ageniza://` explicitamente: o login por e-mail não depende do esquema do Expo Go. Google, links de retorno e universal links não estão implementados neste incremento.

Para acesso fora da rede local: `pnpm --filter @ageniza/mobile preview`. O túnel é temporário e exige o processo ligado; não substitui uma publicação permanente ou APK.

## O que funciona neste incremento

Na prévia web da Vercel, **Entrar na demonstração** abre um ambiente fictício sem conta e sem chamada à API. É possível buscar clientes de exemplo, consultar conteúdos, criar rascunho, simular envio, alternar agência/cliente e aprovar ou pedir ajuste com comentário. Esses fluxos são simulações locais, não operações de negócio implementadas na API mobile. Os dados são apagados ao sair do teste ou recarregar a página. O portal de demonstração esconde a legenda de rascunhos e não oferece seleção de clientes.

- Login por e-mail, recuperação de senha e restauração da sessão.
- Cookie persistido com Expo SecureStore e devolvido pelo transporte nativo; nenhuma senha é persistida.
- Sessão revogada encerra o acesso; conferência ao voltar ao app e a cada 45 segundos em primeiro plano.
- Decisão de entrada vinda da API, escolha e troca de contexto confirmada antes de navegar, saída do aparelho.
- Documentos obrigatórios pendentes são apresentados para leitura e aceite explícito.
- Carteira real de clientes, busca e paginação. Conteúdos reais por mês, na agência e no portal, com estados de carregamento, erro e vazio.
- Paleta e tipografia oficiais (Archivo/Geist); agência escura e portal claro.

Cadastro, criação de agência, confirmação de e-mail, redefinição pelo link e detalhe/edição/aprovação de conteúdo ainda abrem o site dev. A sessão do navegador é independente da sessão do app: pode ser necessário entrar novamente. Não há criação de posts, upload, equipe, notificações ou ML nativos neste primeiro incremento.

## Backend e segurança

Leia [o guia mobile](../../docs/mobile/comecar.md). A base pública correta do dev é `https://dev.ageniza.com.br/api` — o túnel do servidor não expõe as rotas da API na raiz.

Em 03/11/2026, o servidor dev devolveu `403 CSRF_REJECTED` para `expo-origin: ageniza://`. A operação precisa habilitar essa origem no runtime conforme a [issue #803](https://github.com/Nocrato-Tech/ageniza/issues/803). Até isso acontecer, a interface abre, mas o login real nativo fica bloqueado. Não habilitar `exp://` ou modificar o backend pelo cliente.

O Google permanece fora do app por causa da [#799](https://github.com/Nocrato-Tech/ageniza/issues/799). A produção deve continuar sem origens nativas até resolver a pendência e obter a revisão de segurança prevista pelo projeto.

## Verificação e distribuição

### Prévia web na Vercel

Importe `Nocrato-Tech/ageniza`, selecione a branch de entrega e configure **Root Directory: `apps/mobile`**. O `vercel.json` desse diretório instala o workspace, compila os contratos e exporta o app web. O diretório publicado é `web-dist`, com fallback de SPA. A hospedagem não usa o ChatGPT. O proprietário da conta Vercel deve manter o projeto e definir o acesso público da prévia.

Essa publicação continua sendo uma prévia visual: o login permanece no aplicativo nativo até que o servidor autorize a origem web escolhida. A conexão GitHub não concede automaticamente acesso a uma conta Vercel.

```sh
pnpm --filter @ageniza/mobile lint
pnpm --filter @ageniza/mobile typecheck
pnpm --filter @ageniza/mobile test
pnpm --filter @ageniza/mobile exec expo install --check
pnpm --filter @ageniza/mobile build
```

O build exporta bundles Android, iOS e web em `dist/`; não gera um APK nem prova execução no aparelho. A exportação web serve para conferir layout. Login web fora da origem do Ageniza depende da política CORS e dos cookies do backend; não há proxy que burle essa política.

`eas.json` prepara um APK interno do ambiente dev. Após vincular este app a uma conta/projeto Expo autenticado, execute em `apps/mobile`: `eas build --platform android --profile preview`. Não há ID de projeto ou proprietário inventado. Atualizações EAS e distribuição em lojas ficam para o próximo incremento. A configuração atual não está autenticada no EAS nesta máquina.
