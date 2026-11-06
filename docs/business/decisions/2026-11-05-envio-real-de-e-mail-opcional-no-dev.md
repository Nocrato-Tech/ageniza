# Envio real de e-mail opcional no ambiente dev

**Validação.** Decidida pelo maestro com delegação do dono em 05/11/2026.

## Contexto

Até aqui o ambiente dev entregava todo e-mail apenas à caixa Mailpit, e a política era imposta em três lugares: o compose fixava `SMTP_URL` e `EMAIL_FROM`, a configuração do servidor exigia `smtp://mailpit:1025` e o script de deploy recusava essas variáveis no `runtime.env`. Os testes autenticados do mobile (issue #835) precisam de várias contas com endereços distintos recebendo os próprios links de cadastro, recuperação e convite.

## Decisão

No dev, o envio real é opcional e explícito. Sem configuração, continua o Mailpit. O operador liga o envio real com três chaves no `runtime.env` da VPS (`DEV_REAL_EMAIL=1`, `DEV_SMTP_URL`, `DEV_EMAIL_FROM`), todas juntas ou nenhuma. O provedor é qualquer SMTP autenticado: `smtps` ou `smtp` na porta 587 com STARTTLS obrigatório e certificado válido, em host público (sem localhost, nome interno nem IP privado ou de metadados). O script de deploy valida o formato sem imprimir o valor, e a API e o worker validam de novo ao iniciar. Para desligar, basta remover as três linhas e refazer o deploy.

Produção não muda. Confirmação de e-mail, senha, cookies, CSRF e limitação de tentativas não mudam, a caixa Mailpit continua atrás do Cloudflare Access, e nenhuma conta é confirmada automaticamente.

## Consequências

A credencial do provedor existe só no `runtime.env` da VPS (modo 0600), nunca no repositório, em issue ou em log. O dev passa a poder enviar para endereços reais de testadores: vale a cota do provedor e o dado pessoal desses endereços, que seguem as regras de dado do dev. Instalar a credencial, validar SPF, DKIM e DMARC e aplicar o script atualizado são ações do mantenedor, descritas em `docs/infra/dev-environment.md`.

Issue: #835.
