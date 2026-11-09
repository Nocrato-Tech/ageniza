export const brandGuides: Record<string, { title: string; hint: string; fields: { label: string; placeholder: string }[] }> = {
  branding: { title: 'Identidade da marca', hint: 'Transforme a essência da marca em orientações para quem cria.', fields: [{ label: 'Identidade da marca', placeholder: 'Quem é a marca e por que ela existe?' }, { label: 'Valores e diferenciais', placeholder: 'O que ela defende? O que a torna reconhecível?' }, { label: 'Direção visual', placeholder: 'Estilo de imagens, referências e elementos que devem aparecer.' }] },
  tone_of_voice: { title: 'Tom de voz', hint: 'Defina como a marca conversa, com exemplos que a equipe possa usar.', fields: [{ label: 'Tom de voz', placeholder: 'Acolhedor, direto, técnico… Descreva a personalidade.' }, { label: 'Como falar', placeholder: 'Vocabulário, ritmo e expressões que combinam com a marca.' }, { label: 'O que evitar', placeholder: 'Termos, promessas e estilos que não devem ser usados.' }, { label: 'Exemplo de mensagem', placeholder: 'Escreva uma frase que represente essa voz.' }] },
  positioning: { title: 'Posicionamento', hint: 'Conecte público, valor e diferenciais para orientar cada conteúdo.', fields: [{ label: 'Posicionamento', placeholder: 'Qual lugar a marca quer ocupar para seu público?' }, { label: 'Público e contexto', placeholder: 'Para quem falamos e qual necessidade atendemos?' }, { label: 'Proposta de valor', placeholder: 'Que benefício concreto a marca entrega?' }, { label: 'Diferenciais', placeholder: 'Por que escolher essa marca? Use fatos verificáveis.' }] },
};

export function readBrandFields(key: string, body: string): string[] {
  const fields = brandGuides[key]?.fields;
  if (!fields) return [body];
  if (!body.startsWith(`${fields[0]!.label}\n`)) return fields.map((_, index) => index === 0 ? body : '');
  const values: string[] = [];
  let rest = body;
  for (let index = 0; index < fields.length; index += 1) {
    const prefix = `${fields[index]!.label}\n`;
    if (index === fields.length - 1 && rest === fields[index]!.label) { values.push(''); break; }
    if (!rest.startsWith(prefix)) return fields.map((_, i) => i === 0 ? body : '');
    rest = rest.slice(prefix.length);
    const next = fields[index + 1];
    const boundary = next ? rest.indexOf(`\n\n${next.label}${index + 1 === fields.length - 1 && rest.endsWith(next.label) ? '' : '\n'}`) : -1;
    if (next && boundary < 0) return fields.map((_, i) => i === 0 ? body : '');
    values.push(next ? rest.slice(0, boundary) : rest);
    if (next) rest = rest.slice(boundary + 2);
  }
  return values;
}

export function writeBrandField(key: string, body: string, index: number, value: string): string {
  const fields = brandGuides[key]?.fields;
  if (!fields) return value;
  const values = readBrandFields(key, body);
  values[index] = value;
  if (!values.some((item) => item.trim())) return '';
  return fields.map((field, i) => `${field.label}\n${values[i] ?? ''}`).join('\n\n');
}
