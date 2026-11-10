import { describe, expect, it } from 'vitest';

import {
  approvalDueSoonEmail,
  approvalOverdueEmail,
  contentsAwaitingApprovalEmail,
  contentsPublishedEmail,
  type ApprovalBatch,
  type ClientApprovalEmailInput,
  type ClientContentEmailInput,
  type ContentNotificationItem
} from '../src/index.js';

const portalUrl = 'https://app.ageniza.example/portal/00000000-0000-4000-8000-0000000000c1/calendario';
const approvalUrl = 'https://app.ageniza.example/aprovar#x9Qm2L0vWk3pTz8RjYb4Nc7HsAe1UdFgO5iXqKrMtV6';
const items: ContentNotificationItem[] = [{ title: 'Pão de queijo', publishOn: '2026-10-20' }, { title: 'Promoção de sexta', publishOn: null }];
const names = { agencyName: 'Agência Aurora', clientName: 'Padaria Sol' };
const mark = (codePoint: number): string => String.fromCodePoint(codePoint);

type Names = Partial<Pick<ClientApprovalEmailInput, 'agencyName' | 'clientName'>>;
const published = (overrides: Partial<ClientContentEmailInput> = {}): ClientContentEmailInput => ({ ...names, portalUrl, items, ...overrides });
const approval = (overrides: Partial<ClientApprovalEmailInput> = {}): ClientApprovalEmailInput => ({
  ...names,
  approvalUrl,
  batches: [{ dueOn: null, note: null, items }],
  ...overrides
});
const batch = (overrides: Partial<ApprovalBatch> = {}): ApprovalBatch => ({ dueOn: null, note: null, items, ...overrides });

// The four e-mails that carry a list of contents, each with the way to give it a list of items and the names.
const everyEmail = [
  ['contents to approve', (list: ContentNotificationItem[], more: Names = {}) => contentsAwaitingApprovalEmail(approval({ ...more, batches: [batch({ items: list })] }))],
  ['due soon', (list: ContentNotificationItem[], more: Names = {}) => approvalDueSoonEmail(approval({ ...more, batches: [batch({ items: list })] }))],
  ['overdue', (list: ContentNotificationItem[], more: Names = {}) => approvalOverdueEmail(approval({ ...more, batches: [batch({ items: list })] }))],
  ['published', (list: ContentNotificationItem[], more: Names = {}) => contentsPublishedEmail(published({ ...more, items: list }))]
] as const;
const approvalEmails = [
  ['contents to approve', contentsAwaitingApprovalEmail],
  ['due soon', approvalDueSoonEmail],
  ['overdue', approvalOverdueEmail]
] as const;

describe('the e-mails of the contents of a client (issue #260)', () => {
  it('lists every content once, with its planned date, and ends with the approval link, in the text and in the HTML', () => {
    const message = contentsAwaitingApprovalEmail(approval());

    expect(message.subject).toBe('2 conteúdos para você aprovar: Padaria Sol');
    expect(message.text).toBe([
      'Agência Aurora enviou 2 conteúdos de Padaria Sol para a sua aprovação.',
      '- Pão de queijo (20/10/2026)\n- Promoção de sexta',
      `Abra o link para ver os conteúdos e aprovar ou pedir ajuste:\n${approvalUrl}`,
      'O link vale por 7 dias, abre só os conteúdos deste e-mail e não pede que você crie uma conta. Ele é só seu: quem o abrir pode aprovar ou pedir ajuste em seu nome, então não o encaminhe.'
    ].join('\n\n'));
    expect(message.html).toContain('<li>Pão de queijo (20/10/2026)</li><li>Promoção de sexta</li>');
    expect(message.html).toContain(`<a href="${approvalUrl}">${approvalUrl}</a>`);
    expect(message.text).not.toContain('/portal/');
  });

  it('says one content in the singular, in every e-mail', () => {
    const one = [{ title: 'Pão de queijo', publishOn: '2026-10-20' }];

    expect(contentsAwaitingApprovalEmail(approval({ batches: [batch({ items: one })] })).subject).toBe('um conteúdo para você aprovar: Padaria Sol');
    expect(contentsAwaitingApprovalEmail(approval({ batches: [batch({ items: one })] })).text).toContain('enviou um conteúdo de Padaria Sol');
    expect(approvalDueSoonEmail(approval({ batches: [batch({ items: one })] })).subject).toBe('Vence amanhã: aprovar um conteúdo de Padaria Sol');
    expect(approvalOverdueEmail(approval({ batches: [batch({ items: one })] })).subject).toBe('Prazo vencido: aprovar um conteúdo de Padaria Sol');
    expect(contentsPublishedEmail(published({ items: one })).subject).toBe('um conteúdo publicado: Padaria Sol');
    expect(contentsPublishedEmail(published()).subject).toBe('2 conteúdos publicados: Padaria Sol');
    expect(contentsPublishedEmail(published()).text).toContain('Agência Aurora publicou 2 conteúdos de Padaria Sol.');
    expect(contentsPublishedEmail(published()).text).toContain(`Veja no portal:\n${portalUrl}`);
  });

  it.each(everyEmail)('escapes what comes from the content (%s), and never lets it start a tag or an attribute', (_name, compose) => {
    const hostile = '<img src=x onerror="alert(1)"> & "quote" \'single\'';
    const message = compose([{ title: hostile, publishOn: null }], { clientName: 'A <b>B</b>', agencyName: 'C & D' });

    expect(message.html).not.toContain('<img');
    expect(message.html).not.toContain('<b>');
    expect(message.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quote&quot; &#39;single&#39;');
    expect(message.html).toContain('A &lt;b&gt;B&lt;/b&gt;');
    expect(message.html).toContain('C &amp; D');
    expect(message.text).toContain(hostile);
  });

  it.each(everyEmail)('keeps the subject on one line even when a name carries a line break (%s)', (_name, compose) => {
    const message = compose(items, { clientName: 'Padaria\r\nBcc: alguem@exemplo.test', agencyName: 'Agência\nAurora' });

    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.subject).toContain('Padaria Bcc: alguem@exemplo.test');
  });

  it.each(everyEmail)('takes the invisible format marks out of the names, a bidi override (U+202E) included, so the name cannot read as another one (%s)', (_name, compose) => {
    const message = compose(items, { clientName: `Padaria${mark(0x202e)}odnas`, agencyName: `Agência${mark(0x202e)}${mark(0x200b)}Aurora` });

    expect(message.subject).toContain('Padaria odnas');
    expect(message.subject).not.toMatch(/\p{Cf}/u);
    expect(message.text).toContain('Agência Aurora');
    expect(message.text).not.toMatch(/\p{Cf}/u);
    expect(message.html).not.toMatch(/\p{Cf}/u);
  });

  it('refuses a link that is not https (loopback aside), a contentless e-mail and a missing name', () => {
    for (const [, compose] of approvalEmails) {
      expect(() => compose(approval({ approvalUrl: 'http://app.ageniza.example/aprovar#abc' }))).toThrow('HTTPS');
      expect(() => compose(approval({ approvalUrl: 'javascript:alert(1)' }))).toThrow();
      expect(compose(approval({ approvalUrl: 'http://127.0.0.1:5173/aprovar#abc' })).text).toContain('http://127.0.0.1:5173/aprovar#abc');
      expect(() => compose(approval({ batches: [] }))).toThrow('ao menos um conteúdo');
      expect(() => compose(approval({ batches: [batch({ items: [] })] }))).toThrow('ao menos um conteúdo');
      expect(() => compose(approval({ batches: [batch(), batch({ items: [] })] }))).toThrow('ao menos um conteúdo');
      expect(() => compose(approval({ clientName: '  ' }))).toThrow('nome do cliente');
      expect(() => compose(approval({ agencyName: '' }))).toThrow('nome da agência');
    }
    expect(() => contentsPublishedEmail(published({ portalUrl: 'http://app.ageniza.example/portal/1' }))).toThrow('HTTPS');
    expect(() => contentsPublishedEmail(published({ portalUrl: 'javascript:alert(1)' }))).toThrow();
    expect(contentsPublishedEmail(published({ portalUrl: 'http://127.0.0.1:5173/portal/1' })).text).toContain('http://127.0.0.1:5173/portal/1');
    expect(() => contentsPublishedEmail(published({ items: [] }))).toThrow('ao menos um conteúdo');
    expect(() => contentsPublishedEmail(published({ clientName: '  ' }))).toThrow('nome do cliente');
    expect(() => contentsPublishedEmail(published({ agencyName: '' }))).toThrow('nome da agência');
  });

  it('refuses an approval link whose token is not in the fragment, in the three e-mails: a query would carry it to the server, and no fragment carries nothing', () => {
    for (const [, compose] of approvalEmails) {
      expect(() => compose(approval({ approvalUrl: 'https://app.ageniza.example/aprovar?token=abc#abc' }))).toThrow('fragmento');
      expect(() => compose(approval({ approvalUrl: 'https://app.ageniza.example/aprovar?token=abc' }))).toThrow('fragmento');
      expect(() => compose(approval({ approvalUrl: 'https://app.ageniza.example/aprovar' }))).toThrow('fragmento');
      expect(() => compose(approval({ approvalUrl: 'https://app.ageniza.example/aprovar#' }))).toThrow('fragmento');
    }
  });

  it('formats the planned date from its text, without a time zone, and leaves out one it cannot read', () => {
    const message = contentsAwaitingApprovalEmail(approval({ batches: [batch({ items: [
      { title: 'A', publishOn: '2026-01-02' }, { title: 'B', publishOn: '2026-12-31' }, { title: 'C', publishOn: 'ontem' }, { title: 'D', publishOn: '2026-1-2' }
    ] })] }));

    expect(message.text).toContain('- A (02/01/2026)\n- B (31/12/2026)\n- C\n- D');
  });

  it.each(everyEmail)('keeps the family emoji (joined by ZWJ) and the flag of a subdivision (tag characters) in the names and the titles, and still takes the bidi override out (%s)', (_name, compose) => {
    const family = `${mark(0x1f468)}${mark(0x200d)}${mark(0x1f469)}${mark(0x200d)}${mark(0x1f467)}`;
    const scotland = [0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f].map(mark).join('');
    const message = compose(
      [{ title: `Bandeira ${scotland}`, publishOn: null }, { title: `Família ${family}${mark(0x202e)}`, publishOn: null }],
      { clientName: `Família ${family}` }
    );

    expect(message.subject).toContain(`Família ${family}`);
    expect(message.text).toContain(`- Bandeira ${scotland}\n- Família ${family}`);
    expect(message.html).toContain(`<li>Bandeira ${scotland}</li><li>Família ${family}</li>`);
    expect(message.text).not.toContain(mark(0x202e));
    expect(message.html).not.toContain(mark(0x202e));
  });
});

// 2026-11-13 is a Friday.
describe('the deadline and the note of the agency in the e-mail "contents to approve" (decision 2026-11-10)', () => {
  it('shows the deadline in Portuguese, with the weekday, and cites it in the subject', () => {
    const message = contentsAwaitingApprovalEmail(approval({ batches: [batch({ dueOn: '2026-11-13' })] }));

    expect(message.subject).toBe('2 conteúdos para você aprovar até sexta, 13/11: Padaria Sol');
    expect(message.text).toBe([
      'Agência Aurora enviou 2 conteúdos de Padaria Sol para a sua aprovação.',
      'Aprovar até sexta, 13/11',
      '- Pão de queijo (20/10/2026)\n- Promoção de sexta',
      `Abra o link para ver os conteúdos e aprovar ou pedir ajuste:\n${approvalUrl}`,
      'O link vale por 7 dias, abre só os conteúdos deste e-mail e não pede que você crie uma conta. Ele é só seu: quem o abrir pode aprovar ou pedir ajuste em seu nome, então não o encaminhe.'
    ].join('\n\n'));
    expect(message.html).toContain('<p><strong>Aprovar até sexta, 13/11</strong></p>');
    expect(message.html).not.toContain('Recado');
  });

  it('names each weekday by value, from the date as text', () => {
    const weekdays = [['2026-11-08', 'domingo, 08/11'], ['2026-11-09', 'segunda, 09/11'], ['2026-11-10', 'terça, 10/11'], ['2026-11-11', 'quarta, 11/11'],
      ['2026-11-12', 'quinta, 12/11'], ['2026-11-13', 'sexta, 13/11'], ['2026-11-14', 'sábado, 14/11'], ['2028-02-29', 'terça, 29/02']] as const;

    for (const [dueOn, expected] of weekdays) {
      expect(contentsAwaitingApprovalEmail(approval({ batches: [batch({ dueOn })] })).text).toContain(`Aprovar até ${expected}`);
    }
  });

  it('leaves out a deadline that is not a day of the calendar, and says nothing of it in the subject', () => {
    for (const dueOn of ['2026-02-31', '2026-13-01', '2026-11-13T09:00:00Z', '13/11/2026', 'amanhã', '']) {
      const message = contentsAwaitingApprovalEmail(approval({ batches: [batch({ dueOn })] }));
      expect(message.subject).toBe('2 conteúdos para você aprovar: Padaria Sol');
      expect(message.text).not.toContain('Aprovar até');
    }
  });

  it('shows the note under the deadline, signed by the agency, and keeps its line breaks in the text and in the HTML', () => {
    const message = contentsAwaitingApprovalEmail(approval({ batches: [batch({ dueOn: '2026-11-13', note: 'Oi, pessoal!\r\nSegue a pauta da semana.\r\n\r\nQualquer dúvida, é só chamar.' })] }));

    expect(message.text).toContain('Aprovar até sexta, 13/11\n\nRecado:\nOi, pessoal!\nSegue a pauta da semana.\n\nQualquer dúvida, é só chamar.\n— Agência Aurora\n\n- Pão de queijo');
    expect(message.html).toContain('<p><strong>Recado:</strong></p>\n<blockquote>Oi, pessoal!<br>Segue a pauta da semana.<br><br>Qualquer dúvida, é só chamar.<br>— Agência Aurora</blockquote>');
    expect(message.html).not.toMatch(/[\r]/);
  });

  it('shows the note even with no deadline, and the deadline even with no note', () => {
    const onlyNote = contentsAwaitingApprovalEmail(approval({ batches: [batch({ note: 'Só um recado' })] }));
    expect(onlyNote.subject).toBe('2 conteúdos para você aprovar: Padaria Sol');
    expect(onlyNote.text).toContain('Recado:\nSó um recado\n— Agência Aurora');
    expect(onlyNote.text).not.toContain('Aprovar até');
    expect(contentsAwaitingApprovalEmail(approval({ batches: [batch({ dueOn: '2026-11-13' })] })).text).not.toContain('Recado');
  });

  it('escapes the note in the HTML, and keeps it out of the subject, whatever it carries', () => {
    const hostile = '<script>alert(1)</script>\r\n<img src=x onerror="alert(2)"> & "aspas" \'simples\'\r\nBcc: alguem@exemplo.test\r\n\r\n</blockquote><p>fim';
    const message = contentsAwaitingApprovalEmail(approval({ batches: [batch({ dueOn: '2026-11-13', note: hostile })] }));

    expect(message.html).not.toContain('<script');
    expect(message.html).not.toContain('<img');
    expect(message.html).not.toContain('onerror="');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br>&lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp; &quot;aspas&quot; &#39;simples&#39;<br>Bcc: alguem@exemplo.test<br><br>&lt;/blockquote&gt;&lt;p&gt;fim<br>— Agência Aurora</blockquote>');
    // One blockquote opens and one closes: the note cannot close it and start markup of its own.
    expect(message.html.match(/<blockquote>/g)).toHaveLength(1);
    expect(message.html.match(/<\/blockquote>/g)).toHaveLength(1);
    expect(message.text).toContain('<script>alert(1)</script>\n<img src=x onerror="alert(2)"> & "aspas" \'simples\'\nBcc: alguem@exemplo.test');
    expect(message.subject).toBe('2 conteúdos para você aprovar até sexta, 13/11: Padaria Sol');
    expect(message.subject).not.toMatch(/[\r\n]/);
    for (const fragment of ['script', 'Bcc', 'alguem', 'img', 'aspas']) expect(message.subject).not.toContain(fragment);
  });

  it.each(approvalEmails)('puts no line break of the note in the subject of the e-mail (%s)', (_name, compose) => {
    const lineBreaks = [mark(0x85), mark(0x2028), mark(0x2029)].join('');
    const message = compose(approval({ batches: [batch({ dueOn: '2026-11-13', note: `a\r\nSubject: outro\rBcc: x@y.test\n${lineBreaks}z` })] }));

    expect(message.subject).not.toMatch(new RegExp(`[\\r\\n${lineBreaks}]`));
    expect(message.subject).not.toContain('outro');
    expect(message.subject).not.toContain('Bcc');
  });

  it('cleans each line of the note like a name: no control character, no bidi override, no invisible filler, and the line breaks of every kind are line breaks', () => {
    const note = [`  a${mark(0x202e)}b\tc  `, '', '', '', `${mark(0x2800)}${mark(0x3164)}`, `d${mark(0x2028)}e${mark(0x2029)}f${mark(0x85)}g${mark(0x7)}h${mark(0x34f)}i`, '   '].join('\r');
    const message = contentsAwaitingApprovalEmail(approval({ batches: [batch({ note })] }));

    expect(message.text).toContain('Recado:\na b c\n\nd\ne\nf\ng h i\n— Agência Aurora');
    expect(message.html).toContain('<blockquote>a b c<br><br>d<br>e<br>f<br>g h i<br>— Agência Aurora</blockquote>');
    expect(message.text.replaceAll('\n', '')).not.toMatch(/[\p{Cf}\p{Cc}]/u);
    expect(message.html).not.toMatch(new RegExp(`[\\p{Cf}${[0x2028, 0x2029, 0x2800, 0x3164, 0x34f].map(mark).join('')}]`, 'u'));
  });

  it('drops the blank lines at both ends of the note and keeps a single one between the paragraphs', () => {
    const message = contentsAwaitingApprovalEmail(approval({ batches: [batch({ note: '\r\n \r\n\r\nPrimeira\r\n\r\n\r\n\r\nSegunda\r\n \r\n' })] }));

    expect(message.text).toContain('Recado:\nPrimeira\n\nSegunda\n— Agência Aurora');
    expect(message.html).toContain('<blockquote>Primeira<br><br>Segunda<br>— Agência Aurora</blockquote>');
  });

  it('keeps the emoji of the note (joiner and variation selector) and the accents', () => {
    const family = `${mark(0x1f468)}${mark(0x200d)}${mark(0x1f469)}`;
    const heart = `${mark(0x2764)}${mark(0xfe0f)}`;
    const message = contentsAwaitingApprovalEmail(approval({ batches: [batch({ note: `Obrigada ${heart} ${family} — até já` })] }));

    expect(message.text).toContain(`Obrigada ${heart} ${family} — até já`);
    expect(message.html).toContain(`Obrigada ${heart} ${family} — até já`);
  });

  it('shows no note for one that is empty after the cleaning, and signs the agency by its clean name', () => {
    for (const note of ['', '   ', '\r\n\r\n', `${mark(0x200b)}${mark(0x202e)}`, mark(0x2800)]) {
      expect(contentsAwaitingApprovalEmail(approval({ batches: [batch({ note })] })).text).not.toContain('Recado');
    }
    expect(contentsAwaitingApprovalEmail(approval({ agencyName: `Agência${mark(0x202e)}Aurora`, batches: [batch({ note: 'oi' })] })).text).toContain('oi\n— Agência Aurora');
  });

  it('groups the contents by send, each with its deadline and its note, in the order they came', () => {
    const first = batch({ dueOn: '2026-11-13', note: 'Primeiro envio', items: [{ title: 'Post A', publishOn: null }, { title: 'Post B', publishOn: null }] });
    const second = batch({ dueOn: '2026-11-16', note: 'Segundo envio', items: [{ title: 'Post C', publishOn: null }] });
    const message = contentsAwaitingApprovalEmail(approval({ batches: [first, second] }));

    expect(message.subject).toBe('3 conteúdos para você aprovar até sexta, 13/11: Padaria Sol');
    expect(message.text).toBe([
      'Agência Aurora enviou 3 conteúdos de Padaria Sol para a sua aprovação.',
      'Aprovar até sexta, 13/11',
      'Recado:\nPrimeiro envio\n— Agência Aurora',
      '- Post A\n- Post B',
      'Aprovar até segunda, 16/11',
      'Recado:\nSegundo envio\n— Agência Aurora',
      '- Post C',
      `Abra o link para ver os conteúdos e aprovar ou pedir ajuste:\n${approvalUrl}`,
      'O link vale por 7 dias, abre só os conteúdos deste e-mail e não pede que você crie uma conta. Ele é só seu: quem o abrir pode aprovar ou pedir ajuste em seu nome, então não o encaminhe.'
    ].join('\n\n'));
    expect(message.html).toContain('<ul><li>Post A</li><li>Post B</li></ul>');
    expect(message.html).toContain('<ul><li>Post C</li></ul>');
  });

  it('cites the EARLIEST deadline in the subject, whatever the order of the sends', () => {
    const later = batch({ dueOn: '2026-12-02' });
    const earlier = batch({ dueOn: '2026-11-13' });

    expect(contentsAwaitingApprovalEmail(approval({ batches: [later, earlier] })).subject).toBe('4 conteúdos para você aprovar até sexta, 13/11: Padaria Sol');
    expect(contentsAwaitingApprovalEmail(approval({ batches: [earlier, later] })).subject).toBe('4 conteúdos para você aprovar até sexta, 13/11: Padaria Sol');
  });

  it('cites no deadline in the subject when a send of the e-mail has none (a content from before the rounds), but still shows the others in the body', () => {
    const legacy = batch({ items: [{ title: 'Antigo', publishOn: null }] });
    const dated = batch({ dueOn: '2026-11-13', items: [{ title: 'Novo', publishOn: null }] });
    const message = contentsAwaitingApprovalEmail(approval({ batches: [legacy, dated] }));

    expect(message.subject).toBe('2 conteúdos para você aprovar: Padaria Sol');
    expect(message.text).toContain('Aprovar até sexta, 13/11\n\n- Novo');
    expect(message.text.split('Aprovar até')).toHaveLength(2);
    expect(message.text).toContain('- Antigo');
  });
});

describe('the reminders of approval, "vence amanhã" and "venceu" (decision 2026-11-10)', () => {
  const dated = approval({ batches: [batch({ dueOn: '2026-11-13', note: 'Preciso do seu OK para publicar.' })] });

  it('says the deadline ends tomorrow, with the deadline, the note, the contents that wait and the approval link', () => {
    const message = approvalDueSoonEmail(dated);

    expect(message.subject).toBe('Vence amanhã: aprovar 2 conteúdos de Padaria Sol');
    expect(message.text).toBe([
      'Agência Aurora aguarda a sua aprovação de 2 conteúdos de Padaria Sol, e o prazo termina amanhã.',
      'Prazo: sexta, 13/11',
      'Recado:\nPreciso do seu OK para publicar.\n— Agência Aurora',
      '- Pão de queijo (20/10/2026)\n- Promoção de sexta',
      `Abra o link para ver os conteúdos e aprovar ou pedir ajuste:\n${approvalUrl}`,
      'O link vale por 7 dias, abre só os conteúdos deste e-mail e não pede que você crie uma conta. Ele é só seu: quem o abrir pode aprovar ou pedir ajuste em seu nome, então não o encaminhe.'
    ].join('\n\n'));
    expect(message.html).toContain(`<a href="${approvalUrl}">${approvalUrl}</a>`);
    expect(message.html).toContain('<p><strong>Prazo: sexta, 13/11</strong></p>');
    expect(message.html).toContain('<blockquote>Preciso do seu OK para publicar.<br>— Agência Aurora</blockquote>');
  });

  it('says the deadline has passed, with the deadline, the note, the contents that wait and the approval link', () => {
    const message = approvalOverdueEmail(dated);

    expect(message.subject).toBe('Prazo vencido: aprovar 2 conteúdos de Padaria Sol');
    expect(message.text).toBe([
      'Agência Aurora ainda aguarda a sua aprovação de 2 conteúdos de Padaria Sol, e o prazo já passou.',
      'Prazo: sexta, 13/11',
      'Recado:\nPreciso do seu OK para publicar.\n— Agência Aurora',
      '- Pão de queijo (20/10/2026)\n- Promoção de sexta',
      `Abra o link para ver os conteúdos e aprovar ou pedir ajuste:\n${approvalUrl}`,
      'O link vale por 7 dias, abre só os conteúdos deste e-mail e não pede que você crie uma conta. Ele é só seu: quem o abrir pode aprovar ou pedir ajuste em seu nome, então não o encaminhe.'
    ].join('\n\n'));
    expect(message.html).toContain(`<a href="${approvalUrl}">${approvalUrl}</a>`);
  });

  it.each([[approvalDueSoonEmail], [approvalOverdueEmail]])('escapes the note and keeps it out of the subject, as the e-mail of the send does', (compose) => {
    const message = compose(approval({ batches: [batch({ dueOn: '2026-11-13', note: '<script>alert(1)</script>\r\nBcc: x@y.test' })] }));

    expect(message.html).not.toContain('<script');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br>Bcc: x@y.test<br>— Agência Aurora');
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.subject).not.toContain('script');
    expect(message.subject).not.toContain('Bcc');
  });

  it.each([[approvalDueSoonEmail], [approvalOverdueEmail]])('works without a note and with the contents of several sends, each with its deadline', (compose) => {
    const message = compose(approval({ batches: [batch({ dueOn: '2026-11-13', items: [{ title: 'A', publishOn: null }] }), batch({ dueOn: '2026-11-14', items: [{ title: 'B', publishOn: null }] })] }));

    expect(message.text).toContain('Prazo: sexta, 13/11\n\n- A');
    expect(message.text).toContain('Prazo: sábado, 14/11\n\n- B');
    expect(message.text).not.toContain('Recado');
  });

  it.each(approvalEmails)('sells nothing of the product and speaks in the name of the agency and of the client (%s)', (_name, compose) => {
    const message = compose(dated);

    // The link points to the web app, whose address is the one place the name may be; the words are what is checked.
    expect(`${message.subject}\n${message.text}\n${message.html}`.replaceAll(approvalUrl, '')).not.toMatch(/ageniza/i);
    expect(message.text).toContain('Agência Aurora');
    expect(message.text).toContain('Padaria Sol');
  });

  it.each(approvalEmails)('tells what the link opens and for how long, and that it asks for no account (%s)', (_name, compose) => {
    const message = compose(dated);

    for (const text of [message.text, message.html]) {
      expect(text).toContain('O link vale por 7 dias');
      expect(text).toContain('abre só os conteúdos deste e-mail');
      expect(text).toContain('não pede que você crie uma conta');
      expect(text).toContain('não o encaminhe');
    }
  });
});
