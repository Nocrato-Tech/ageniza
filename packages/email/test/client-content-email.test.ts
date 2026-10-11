import { describe, expect, it } from 'vitest';

import { contentsAwaitingApprovalEmail, contentsPublishedEmail, type ClientContentEmailInput } from '../src/index.js';

const portalUrl = 'https://app.ageniza.example/portal/00000000-0000-4000-8000-0000000000c1/calendario';
const input = (overrides: Partial<ClientContentEmailInput> = {}): ClientContentEmailInput => ({
  agencyName: 'Agência Aurora',
  clientName: 'Padaria Sol',
  portalUrl,
  items: [{ title: 'Pão de queijo', publishOn: '2026-10-20' }, { title: 'Promoção de sexta', publishOn: null }],
  ...overrides
});

describe('the e-mails of the contents of a client (issue #260)', () => {
  it('lists every content once, with its planned date, and ends with the link of the portal, in the text and in the HTML', () => {
    const message = contentsAwaitingApprovalEmail(input());

    expect(message.subject).toBe('2 conteúdos para você aprovar: Padaria Sol');
    expect(message.text).toBe([
      'Agência Aurora enviou 2 conteúdos de Padaria Sol para a sua aprovação.',
      '- Pão de queijo (20/10/2026)\n- Promoção de sexta',
      `Abra o portal para aprovar ou pedir ajuste:\n${portalUrl}`
    ].join('\n\n'));
    expect(message.html).toContain('<li>Pão de queijo (20/10/2026)</li><li>Promoção de sexta</li>');
    expect(message.html).toContain(`<a href="${portalUrl}">${portalUrl}</a>`);
  });

  it('says one content in the singular, in both e-mails', () => {
    const one = input({ items: [{ title: 'Pão de queijo', publishOn: '2026-10-20' }] });

    expect(contentsAwaitingApprovalEmail(one).subject).toBe('um conteúdo para você aprovar: Padaria Sol');
    expect(contentsAwaitingApprovalEmail(one).text).toContain('enviou um conteúdo de Padaria Sol');
    expect(contentsPublishedEmail(one).subject).toBe('um conteúdo publicado: Padaria Sol');
    expect(contentsPublishedEmail(input()).subject).toBe('2 conteúdos publicados: Padaria Sol');
    expect(contentsPublishedEmail(input()).text).toContain('Agência Aurora publicou 2 conteúdos de Padaria Sol.');
    expect(contentsPublishedEmail(input()).text).toContain(`Veja no portal:\n${portalUrl}`);
  });

  it.each([contentsAwaitingApprovalEmail, contentsPublishedEmail])('escapes what comes from the content, and never lets it start a tag or an attribute', (compose) => {
    const hostile = '<img src=x onerror="alert(1)"> & "quote" \'single\'';
    const message = compose(input({ items: [{ title: hostile, publishOn: null }], clientName: 'A <b>B</b>', agencyName: 'C & D' }));

    expect(message.html).not.toContain('<img');
    expect(message.html).not.toContain('<b>');
    expect(message.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quote&quot; &#39;single&#39;');
    expect(message.html).toContain('A &lt;b&gt;B&lt;/b&gt;');
    expect(message.html).toContain('C &amp; D');
    expect(message.text).toContain(hostile);
  });

  it.each([contentsAwaitingApprovalEmail, contentsPublishedEmail])('keeps the subject on one line even when a name carries a line break', (compose) => {
    const message = compose(input({ clientName: 'Padaria\r\nBcc: alguem@exemplo.test', agencyName: 'Agência\nAurora' }));

    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.subject).toContain('Padaria Bcc: alguem@exemplo.test');
  });

  it.each([contentsAwaitingApprovalEmail, contentsPublishedEmail])('takes the invisible format marks out of the names, a bidi override (U+202E) included, so the name cannot read as another one', (compose) => {
    const message = compose(input({ clientName: 'Padaria\u202Eodnas', agencyName: 'Agência\u202E\u200BAurora' }));

    expect(message.subject).toContain('Padaria odnas');
    expect(message.subject).not.toMatch(/\p{Cf}/u);
    expect(message.text).toContain('Agência Aurora');
    expect(message.text).not.toMatch(/\p{Cf}/u);
    expect(message.html).not.toMatch(/\p{Cf}/u);
  });

  it('refuses a link that is not https (loopback aside), a contentless e-mail and a missing name', () => {
    expect(() => contentsAwaitingApprovalEmail(input({ portalUrl: 'http://app.ageniza.example/portal/1' }))).toThrow('HTTPS');
    expect(() => contentsAwaitingApprovalEmail(input({ portalUrl: 'javascript:alert(1)' }))).toThrow();
    expect(contentsAwaitingApprovalEmail(input({ portalUrl: 'http://127.0.0.1:5173/portal/1' })).text).toContain('http://127.0.0.1:5173/portal/1');
    expect(() => contentsPublishedEmail(input({ items: [] }))).toThrow('ao menos um conteúdo');
    expect(() => contentsPublishedEmail(input({ clientName: '  ' }))).toThrow('nome do cliente');
    expect(() => contentsPublishedEmail(input({ agencyName: '' }))).toThrow('nome da agência');
  });

  it('formats the planned date from its text, without a time zone, and leaves out one it cannot read', () => {
    const message = contentsAwaitingApprovalEmail(input({ items: [
      { title: 'A', publishOn: '2026-01-02' }, { title: 'B', publishOn: '2026-12-31' }, { title: 'C', publishOn: 'ontem' }, { title: 'D', publishOn: '2026-1-2' }
    ] }));

    expect(message.text).toContain('- A (02/01/2026)\n- B (31/12/2026)\n- C\n- D');
  });
  it.each([contentsAwaitingApprovalEmail, contentsPublishedEmail])('keeps the family emoji (joined by ZWJ) and the flag of a subdivision (tag characters) in the names and the titles, and still takes the bidi override out', (compose) => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const message = compose(input({
      clientName: `Família ${family}`,
      items: [{ title: `Bandeira ${scotland}`, publishOn: null }, { title: `Família ${family}\u202E`, publishOn: null }]
    }));

    expect(message.subject).toContain(`Família ${family}`);
    expect(message.text).toContain(`- Bandeira ${scotland}\n- Família ${family}`);
    expect(message.html).toContain(`<li>Bandeira ${scotland}</li><li>Família ${family}</li>`);
    expect(message.text).not.toContain('\u202E');
    expect(message.html).not.toContain('\u202E');
  });
});
