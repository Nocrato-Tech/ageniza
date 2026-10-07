# Termos e Privacidade são conteúdo estático versionado, com aceite único
**Data.** 2026-09-24

**Contexto.** O banco registra as versões de Termos e de Privacidade separadamente, o contrato de aceite pede um único `acceptTerms: true`, e nenhuma rota entrega os documentos ao navegador.

**Decisão.** O conteúdo dos dois documentos vive **estático e versionado no repositório**, servido pelas páginas `/termos` e `/privacidade` — sem rota de API. O aceite é **um checkbox**, com os links dos dois documentos dentro do próprio texto, e grava as duas versões.

**Reaceite quando uma versão muda fica em aberto**, com gatilho: a primeira alteração de um dos documentos depois de existir gente com conta. Hoje ninguém tem conta.

**Consequência.** Redigir os dois textos é **trabalho da implementação**, não decisão pendente: entra como task do épico. Os textos precisam de revisão jurídica antes de valerem como documento — o que sai daqui é minuta, não parecer.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

