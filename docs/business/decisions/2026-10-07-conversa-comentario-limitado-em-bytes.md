# O limite de 5.000 do comentário é em bytes UTF-8, não em caracteres

**Data.** 2026-10-07

**Contexto.** A SPEC diz que o comentário tem "até 5.000 caracteres", e a issue #128 pede 400 acima disso. A coluna `client_thread_comments.body` limita por `octet_length(body) <= 5000`, ou seja, em bytes. Um texto de 5.000 caracteres com acentos passa de 5.000 bytes e, se a rota só contasse caracteres, chegaria ao banco e voltaria como 500.

**Decisão.** A rota valida em **bytes UTF-8**, o mesmo teto da coluna, e o comentário é aparado antes. Texto em branco, só com espaços, ou com caractere de controle (fora tabulação e quebra de linha) é 400.

**Consequência.** Qualquer texto acima de 5.000 caracteres continua sendo 400, como a SPEC pede. Um texto em português com muitas letras acentuadas pode ser recusado um pouco antes dos 5.000 caracteres. Se o produto quiser contar caracteres de verdade, é uma migration que troque o `check` da coluna, e o contrato muda junto.

**Origem.** Issues #128 e #130; `specs/clientes.md`, seção 3.

**Validação.** Pendente de validação do dono.
