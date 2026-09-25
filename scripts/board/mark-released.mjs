// Move para "Em produção" todo card que está em "Pronto para subir". A promoção para `main` é o
// único passo do fluxo que nenhuma automação cobre: o GITHUB_TOKEN de um workflow não escreve em
// projeto de organização, e um PAT guardado como secret custa mais do que este comando.
//
// Uso:
//   node scripts/board/mark-released.mjs --dry-run
//   node scripts/board/mark-released.mjs
//
// Exige o `gh` autenticado com o escopo `project`.
import { execFileSync } from 'node:child_process';

const OWNER = process.env.AGENIZA_PROJECT_OWNER ?? 'Nocrato-Tech';
const NUMBER = Number(process.env.AGENIZA_PROJECT_NUMBER ?? 1);
const FROM = 'Pronto para subir';
const TO = 'Em produção';

// Sem `shell`: no Windows o shell quebra uma query GraphQL multilinha passada como argumento.
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

const graphql = (query, variables = {}) => {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push('-F', `${key}=${value}`);
  const payload = JSON.parse(gh(args));
  if (payload.errors !== undefined) throw new Error(payload.errors[0]?.message ?? 'GraphQL error');
  return payload.data;
};

const PROJECT = `
query($owner:String!,$number:Int!,$cursor:String){
  organization(login:$owner){
    projectV2(number:$number){
      id
      field(name:"Status"){ ... on ProjectV2SingleSelectField { id options { id name } } }
      items(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id
          content{ ... on Issue { number title } ... on PullRequest { number title } }
          fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`;

const SET = `
mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
  updateProjectV2ItemFieldValue(input:{
    projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}
  }){ projectV2Item { id } }
}`;

const main = () => {
  const dryRun = process.argv.includes('--dry-run');
  let cursor = '';
  let projectId;
  let statusFieldId;
  let targetOptionId;
  const pending = [];

  for (;;) {
    const variables = { owner: OWNER, number: NUMBER };
    if (cursor !== '') variables.cursor = cursor;
    const project = graphql(PROJECT, variables).organization.projectV2;
    projectId ??= project.id;
    statusFieldId ??= project.field?.id;
    targetOptionId ??= project.field?.options?.find((option) => option.name === TO)?.id;

    for (const item of project.items.nodes) {
      if (item.fieldValueByName?.name !== FROM) continue;
      pending.push({ id: item.id, number: item.content?.number, title: item.content?.title ?? '(sem título)' });
    }
    if (!project.items.pageInfo.hasNextPage) break;
    cursor = project.items.pageInfo.endCursor;
  }

  if (statusFieldId === undefined) throw new Error('Campo Status não encontrado no projeto.');
  if (targetOptionId === undefined) throw new Error(`A coluna "${TO}" não existe no campo Status.`);

  if (pending.length === 0) {
    process.stdout.write(`Nada em "${FROM}".\n`);
    return;
  }

  process.stdout.write(`${pending.length} card(s) em "${FROM}":\n`);
  for (const item of pending) {
    process.stdout.write(`  #${item.number ?? '?'} ${item.title}\n`);
  }

  if (dryRun) {
    process.stdout.write(`\n--dry-run: nada foi movido.\n`);
    return;
  }

  for (const item of pending) {
    graphql(SET, { project: projectId, item: item.id, field: statusFieldId, option: targetOptionId });
  }
  process.stdout.write(`\nMovidos para "${TO}".\n`);
};

main();
