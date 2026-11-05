# Apresentação acadêmica web

| | |
|---|---|
| Status | em revisão |
| Escopo | demonstração web autorizada pelo usuário; não é lançamento de produção |
| Referência | decisão 2026-11-05-apresentacao-web-com-ml-e-cobranca-ficticios |

## 1. Propósito

Apresentar ML, notificações web e assinatura simulada sem depender de histórico real, pagamentos ou distribuição nativa. A aplicação real continua disponível pelo seu endereço autenticado.

## 2. Atores e autorização

A demonstração é pública, sem autenticação ou dados de agência. Não concede acesso aos módulos reais. Só existe com build web explicitamente habilitado e caminho `/apresentacao/`.

## 3. Dados

Histórico sintético determinístico: dias restantes, fração de tarefas pendentes, revisões e resultado fictício de atraso. Treino e teste são separados. Modelo k-NN com cinco vizinhos; votos e métrica exibidos são calculados, nunca números fixos de apresentação. Toda métrica declara sua origem sintética.

Planos e recibos são fictícios, com preços de referência do escopo aprovado de planos. Nenhum formulário recebe cartão. Estado da demonstração vive apenas na sessão da página; recarregar reinicia os cenários.

## 4. Estados e transições

ML: editar sinais → recalcular classificação e vizinhos. Assinatura: selecionar → conferir → processar simulação → aprovado ou recusado. Recusa preserva plano anterior; aprovado ativa plano fictício e gera recibo. Cancelamento exige confirmação e apenas marca fim do ciclo simulado; reativar desfaz a marca. Cliques simultâneos não duplicam a mesma simulação.

Notificação: não solicitada → concedida/negada/indisponível → envio local/erro. Permissão só é solicitada após clique; não há solicitação automática ao abrir. Notificação abre somente a própria apresentação. Não coleta subscription endpoints nem envia mensagens de terceiros.

## 5. Invariantes

- Nenhuma leitura/escrita da API, sessão, cartão ou cadastro real.
- Dados e recibos fictícios identificados na interface.
- Entrada normal e nativa não ganham dados artificiais.
- Classificação varia com os sinais e usa somente o conjunto de treino.
- Resultado do conjunto de teste não participa do treino.
- Recusa não ativa assinatura; cancelar/reativar só altera estado fictício.
- Permissão negada/ausência de navegador compatível é tratada sem falso sucesso.

## 6. Backend e persistência

Não há rota de backend ou alteração de banco. Sem armazenamento persistente de dados financeiros. Service worker exclusivo da apresentação serve apenas à entrega local de notificações; não intercepta fetch ou autenticação.

## 7. Frontend

Três abas: ML, avisos e planos. Tema e componentes existentes da UI mobile, Sora/Inter, responsivo e rolável. ML mostra controles, risco, vizinhos e avaliação sintética; avisos mostram permissão e resultado; planos mostram seleção, conferência, aprovação/recusa, recibos e cancelamento/reativação. Há saída para o app real. Estados de carregamento/processamento, erro, vazio e falta de suporte têm texto e ação adequados.

## 8. Infraestrutura

Exportação Expo web habilitada por `EXPO_PUBLIC_PRESENTATION_FEATURES=true`, publicada no projeto Vercel existente. O redirecionamento da raiz para o app real e o download do APK são preservados. A entrega de notificação usa service worker em `/apresentacao/` sem push remoto, VAPID ou assinatura nativa.

## 9. Impacto estrutural

Nenhum: não altera tabelas, resposta compartilhada, RLS, autorização ou histórico existente.

## 10. Em aberto

Antes de produção: dados reais e avaliação do ML, push remoto, provedor financeiro real e distribuição assinada seguem os módulos próprios. A autorização atual permite a demonstração sem esses recursos.

## 11. Verificação

Testes do modelo, holdout, entradas inválidas, estados financeiros e guardas de entrada; interface com aprovação/recusa/cancelamento; testes de notificações com permissão negada e suporte ausente. Tipos, lint, exportação web e verificação visual do endereço publicado.

## 12. Recorte

Entrega #831 de apresentação web, sem alterações no backend. #817–#820 mantêm o escopo de produção separado. O PR registra as verificações, as mutações e o endereço publicado.
