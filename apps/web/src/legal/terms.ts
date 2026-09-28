import { DRAFT_NOTICE, type LegalDocument } from './document.js';

export const termsOfUse: LegalDocument = {
  title: 'Termos de Uso',
  version: '2026-01-01',
  draftNotice: DRAFT_NOTICE,
  sections: [
    {
      heading: 'Quem somos e o que este documento cobre',
      paragraphs: [
        'O Ageniza é operado por [PENDENTE: razão social], inscrita no CNPJ sob o nº [PENDENTE: CNPJ], com sede em [PENDENTE: endereço]. Neste documento, "nós" é quem opera o Ageniza, e "você" é a pessoa que tem uma conta nele.',
        'Estes Termos regem o uso do Ageniza. A Política de Privacidade, aceita junto com eles, explica o que acontece com os seus dados.'
      ]
    },
    {
      heading: 'O que o Ageniza é',
      paragraphs: [
        'O Ageniza é uma plataforma para agências que produzem conteúdo de redes sociais para os seus clientes. Ele tem dois lados separados:',
        'Um colaborador da agência não entra no portal de um cliente só por ser da agência: precisa de um acesso a esse cliente, recebido por convite.',
        'Nesta versão, o Ageniza não se conecta a nenhuma rede social: não publica conteúdo em seu nome e não lê métricas de perfis.'
      ],
      items: [
        'a área da agência, onde os colaboradores cadastram clientes, organizam o trabalho e gerenciam quem tem acesso;',
        'o portal do cliente, onde as pessoas de um cliente da agência acompanham o que é feito para ele e conversam com a agência.'
      ]
    },
    {
      heading: 'Como se entra',
      paragraphs: [
        'Não existe cadastro aberto. Uma conta só nasce de um convite enviado por e-mail, e é criada com o endereço para o qual o convite foi enviado. Os convites são de três tipos: a ativação de uma agência nova, feita pela nossa operação; o convite de colaborador, feito por um Admin da agência; e o convite de cliente, feito por um Admin da agência para o portal de um cliente específico.',
        'O convite vale por 7 dias e só pode ser usado uma vez. A agência pode cancelá-lo ou reenviá-lo, e reenviar invalida o anterior. O papel de cada pessoa vem definido no convite: você não escolhe o próprio papel.',
        'A mesma conta pode ter acesso a várias agências e a vários clientes. A cada entrada, você escolhe em qual deles vai trabalhar.',
        'Para usar o Ageniza é preciso ter [PENDENTE: idade mínima e capacidade civil exigidas].'
      ]
    },
    {
      heading: 'Sua conta e sua senha',
      paragraphs: [
        'A senha tem no mínimo 10 caracteres e é pessoal. Você é responsável por guardá-la e por não compartilhar a conta. Se perder a senha, pode pedir um link de redefinição pelo e-mail da conta; o link vale por 30 minutos.',
        'Uma sessão aberta expira depois de 7 dias. Enquanto você usa o produto, ela é renovada, até um limite máximo de duração; depois dele, é preciso entrar de novo. Você pode sair a qualquer momento, e também sair de todas as sessões abertas em outros aparelhos. Redefinir a senha encerra todas as sessões.',
        'Para proteger as contas, o número de tentativas de entrada e de pedidos de redefinição é limitado por período. Ao atingir o limite, é preciso esperar para tentar de novo.',
        'O e-mail da conta não pode ser trocado pelo próprio produto nesta versão. [PENDENTE: como a pessoa pede a troca de e-mail, que specs/auth.md mantém em aberto.]'
      ]
    },
    {
      heading: 'Agências, papéis e acesso',
      paragraphs: [
        'Cada agência tem um dono (Owner) e colaboradores com um papel: Admin, Gestor de conta, Produção, Vendas ou Financeiro. O papel define o que a pessoa pode fazer na agência; o cargo é só uma descrição do trabalho e não concede acesso.',
        'Quem administra a agência pode alterar o papel de um colaborador e removê-lo da equipe. A remoção encerra o acesso àquela agência, mas não apaga o registro de que a pessoa fez parte dela, nem o que ela produziu. Seus acessos a outras agências e clientes não são afetados.',
        'Nós podemos suspender uma agência. Enquanto ela estiver suspensa, ninguém acessa os dados dela, convites pendentes deixam de valer, e os dados são preservados integralmente. A reativação devolve o acesso. Os outros acessos das mesmas pessoas continuam funcionando. [PENDENTE: em que situações a suspensão ocorre e com que aviso.]'
      ]
    },
    {
      heading: 'O portal do cliente',
      paragraphs: [
        'Todas as pessoas com acesso ao portal de um cliente têm o mesmo acesso: veem o cadastro e o estudo de marca daquele cliente e podem abrir conversas e comentar. Pelo portal não se edita o estudo de marca.',
        'Comentários, tanto no portal quanto na área da agência, não podem ser editados nem apagados depois de enviados, nem por quem os escreveu. Escreva sabendo que o texto permanece.',
        'Quando a agência arquiva um cliente, por exemplo no fim do contrato, o portal daquele cliente deixa de funcionar e os convites pendentes para ele são cancelados. Nada é apagado, e a agência pode reativar o cliente depois. A agência também pode remover o acesso de uma pessoa ao portal a qualquer momento.'
      ]
    },
    {
      heading: 'O que você envia',
      paragraphs: [
        'Imagens e vídeos enviados à plataforma ficam vinculados à agência em que foram enviados, em armazenamento privado, e registram quem os enviou. Só são aceitos os tipos de arquivo permitidos, até o tamanho máximo de cada tipo e dentro da quota de armazenamento da agência. Um arquivo fora dessas regras é recusado e apagado.',
        'O arquivo original nunca é convertido. Para vídeos, geramos uma miniatura e uma prévia em até 720p, para que o conteúdo possa ser conferido sem baixar o original.',
        '[PENDENTE: titularidade do conteúdo enviado, licença que a pessoa ou a agência nos concede para armazenar e processar os arquivos, e responsabilidade por conteúdo de terceiros.]'
      ]
    },
    {
      heading: 'Usos não permitidos',
      paragraphs: ['Não é permitido:'],
      items: [
        'tentar acessar dados de uma agência ou de um cliente aos quais você não tem acesso;',
        'usar a conta de outra pessoa ou compartilhar a sua;',
        'tentar contornar os limites de tentativa, de tipo de arquivo, de tamanho ou de quota;',
        '[PENDENTE: demais condutas vedadas e consequências do descumprimento.]'
      ]
    },
    {
      heading: 'Disponibilidade e cópias de segurança',
      paragraphs: [
        'Fazemos uma cópia de segurança criptografada do banco de dados por dia. Em uma falha grave do servidor, o que foi registrado depois da última cópia pode ser perdido: hoje, até 24 horas de alterações.',
        '[PENDENTE: compromisso de disponibilidade, se houver, e limitação de responsabilidade.]'
      ]
    },
    {
      heading: 'Preço',
      paragraphs: [
        'O Ageniza não faz nenhuma cobrança pelo próprio sistema nesta versão. [PENDENTE: condições comerciais entre a operação e cada agência, e como uma cobrança futura seria comunicada.]'
      ]
    },
    {
      heading: 'Fim do uso',
      paragraphs: [
        'Perder o acesso a uma agência ou a um cliente não apaga a sua conta: se ela não tiver mais nenhum acesso, você não consegue entrar, mas pode voltar a usar a mesma conta ao receber um convite novo.',
        'O produto não tem hoje uma função para excluir a conta. [PENDENTE: canal e prazo para pedir a exclusão da conta, e o que acontece com o que a pessoa produziu nas agências.]'
      ]
    },
    {
      heading: 'Mudanças nestes Termos',
      paragraphs: [
        'Cada versão destes Termos é identificada pela data que aparece no topo. Ao criar a conta, registramos a versão que você aceitou, com data e hora.',
        '[PENDENTE: como uma versão nova é comunicada e se exige novo aceite, ponto que specs/auth.md mantém em aberto.]'
      ]
    },
    {
      heading: 'Lei aplicável e foro',
      paragraphs: [
        'Estes Termos seguem a lei brasileira. [PENDENTE: foro eleito.]'
      ]
    },
    {
      heading: 'Contato',
      paragraphs: [
        '[PENDENTE: canal de contato para dúvidas sobre estes Termos.]'
      ]
    }
  ]
};
