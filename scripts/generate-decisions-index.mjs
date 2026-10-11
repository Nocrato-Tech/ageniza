#!/usr/bin/env node
// Regenera docs/business/decisions/README.md a partir dos arquivos de decisão.
//
// Título (linha "# ") e data ("**Data.**") vêm de cada arquivo. O módulo de cada decisão
// vem das seções atuais do índice: o índice guarda o agrupamento, e uma decisão nova sem
// linha cai em "A classificar" até ser movida para o módulo. O script não move decisão pelo
// título. Módulo novo exige editar MODULES. Roda fora dos PRs de entrega, ao fim de cada onda.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const UNCLASSIFIED = 'A classificar';

export const MODULES = [
  'Autenticação',
  'Colaboradores',
  'Clientes',
  'Conteúdo',
  'Mídia',
  'Autorização e transversais',
  'Processo e operação',
  'Infra',
  UNCLASSIFIED,
];

const LINK = /\]\(([^)\s]+\.md)\)/;

// Fim de linha CRLF (core.autocrlf=true no Windows) vira LF antes de qualquer leitura.
const toLf = (text) => text.replace(/\r\n/g, '\n');

// Seções "## " do índice que não estão em MODULES: as decisões delas caem em "A classificar".
export function unknownSections(readme) {
  return readme
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim())
    .filter((section) => !MODULES.includes(section));
}

export function parseGroups(readme) {
  const groups = Object.fromEntries(MODULES.map((m) => [m, []]));
  let current = null;
  for (const line of readme.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.slice(3).trim();
      continue;
    }
    if (current && Object.hasOwn(groups, current)) {
      const match = line.match(LINK);
      if (match) groups[current].push(match[1]);
    }
  }
  return groups;
}

export function readDecision(text, name) {
  const lines = text.split('\n');
  const title = lines.find((l) => l.startsWith('# '))?.slice(2).trim();
  const date = lines
    .map((l) => l.match(/^\*\*Data\.\*\*\s*(\d{4}-\d{2}-\d{2})/))
    .find(Boolean)?.[1];
  if (!title || !date) {
    throw new Error(`${name}: falta a linha "# " ou "**Data.**" com AAAA-MM-DD`);
  }
  return { title, date };
}

// Monta o índice. `files` é { nome: conteúdo }; `readme` é o índice atual (intro e agrupamento).
export function buildIndex({ files, readme: rawReadme }) {
  const readme = toLf(rawReadme);
  const intro = readme.split('\n## ')[0].trimEnd() + '\n';
  const warnings = [];
  const decisions = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, readDecision(toLf(text), name)]),
  );

  for (const section of unknownSections(readme)) {
    warnings.push(`seção "${section}" não está em MODULES: as decisões dela vão para "${UNCLASSIFIED}"`);
  }

  const groups = parseGroups(readme);
  const placed = new Map();
  for (const module of Object.keys(groups)) {
    groups[module] = groups[module].filter((name) => {
      if (!(name in decisions)) {
        warnings.push(`índice cita ${name}, que não existe na pasta: linha removida`);
        return false;
      }
      if (placed.has(name)) {
        throw new Error(`${name} aparece em "${placed.get(name)}" e em "${module}"`);
      }
      placed.set(name, module);
      return true;
    });
  }

  for (const name of Object.keys(decisions).sort()) {
    if (!placed.has(name)) {
      groups[UNCLASSIFIED].push(name);
      warnings.push(`${name} não tem módulo no índice: vai para "${UNCLASSIFIED}"`);
    }
  }

  let out = intro;
  for (const module of MODULES) {
    const rows = groups[module]
      .map((name) => ({ name, ...decisions[name] }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    if (module === UNCLASSIFIED && rows.length === 0) continue;
    out += `\n## ${module}\n\n`;
    if (rows.length === 0) out += '_Nenhuma decisão._\n';
    for (const row of rows) {
      out += `- ${row.date} — [${row.title}](${row.name})\n`;
    }
  }
  return { text: out, warnings };
}

function main() {
  const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'docs', 'business', 'decisions');
  const readmePath = join(dir, 'README.md');
  const files = {};
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.md') && name !== 'README.md') {
      files[name] = readFileSync(join(dir, name), 'utf8');
    }
  }
  const { text, warnings } = buildIndex({ files, readme: readFileSync(readmePath, 'utf8') });
  writeFileSync(readmePath, text, 'utf8');
  for (const warning of warnings) console.warn(`aviso: ${warning}`);
  console.log(`índice regenerado: ${Object.keys(files).length} decisões`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
