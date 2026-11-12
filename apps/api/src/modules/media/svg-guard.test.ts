import { describe, expect, it } from 'vitest';

import { inspectSvg, SVG_MAX_BYTES } from './svg-guard.js';
import { SAFE_SVG, textBytes } from './test-support/files.js';

// Decision 2026-11-11 "a mídia aceita PDF, áudio e SVG como logo": an SVG with a script, an event handler, a foreignObject, an
// external reference or an address with a scheme is refused at the confirmation. Each case below is one way of writing one.

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const wrap = (inner: string, rootAttributes = ''): string => `<svg ${NS} viewBox="0 0 10 10"${rootAttributes}>${inner}</svg>`;
const verdict = (svg: string) => inspectSvg(textBytes(svg));
const refusal = (svg: string): string | undefined => {
  const result = verdict(svg);
  return result.ok ? undefined : result.reason;
};

describe('an SVG that is accepted', () => {
  it.each([
    ['the plain file', SAFE_SVG],
    ['a shape', wrap('<rect width="5" height="5" fill="#fff"/>')],
    ['references to the document, with xlink and without', wrap('<defs><circle id="c" r="1"/></defs><use xlink:href="#c"/><use href="#c"/>')],
    ['a gradient and a filter by fragment', wrap('<defs><filter id="f"/></defs><rect filter="url(#f)" fill="url( &quot;#f&quot; )"/>')],
    ['a style by attribute', wrap('<rect style="fill:#fff;stroke:none"/>')],
    ['a style element', wrap('<style>.a{fill:#fff}</style><rect class="a"/>')],
    ['a style element in CDATA', wrap('<style><![CDATA[ .a > b { fill: url(#g); } ]]></style>')],
    ['comments, title and description', `<!-- made by a tool --><svg ${NS}><title>Logo</title><desc>O logo</desc><!-- end --></svg>`],
    ['the declaration of the document and the standard doctype', '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['elements of an editor in other namespaces', `<svg ${NS} xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"><sodipodi:namedview id="base" inkscape:zoom="1"/><metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata></svg>`],
    ['text, with the entities XML defines', wrap('<text>Padaria &amp; Cia &lt;3 &#233;</text>')],
    ['a self-closing root', `<svg ${NS}/>`],
    ['a UTF-8 byte order mark', `\u{FEFF}${SAFE_SVG}`],
    ['an attribute that only looks like a handler', wrap('<rect opacity="1" offset="0" order="1" orient="auto"/>')],
    ['a text that mentions the words', wrap('<text>javascript: data: onload</text>')]
  ])('%s', (_label, svg) => {
    expect(verdict(svg)).toEqual({ ok: true });
  });
});

describe('an SVG with a script', () => {
  it.each([
    ['a script element', wrap('<script>alert(1)</script>'), 'element'],
    ['a script element in capitals', wrap('<SCRIPT>alert(1)</SCRIPT>'), 'element'],
    ['a script element with a prefix bound to XHTML', wrap('<x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script>'), 'element'],
    ['a self-closing script', wrap('<script href="#x"/>'), 'element'],
    ['an event handler on the root', wrap('', ' onload="alert(1)"'), 'attribute'],
    ['an event handler on a shape', wrap('<rect onclick="alert(1)"/>'), 'attribute'],
    ['an event handler in capitals', wrap('<rect ONMOUSEOVER="alert(1)"/>'), 'attribute'],
    ['an event handler with a prefix', wrap('<rect xlink:onload="alert(1)"/>'), 'attribute'],
    ['a handler element of the events module', wrap('<handler type="application/ecmascript">alert(1)</handler>'), 'element'],
    ['a listener element', wrap('<listener event="load" handler="#h"/>'), 'element'],
    ['a script written in a style element as markup', wrap('<style><svg onload="alert(1)"/></style>'), 'style'],
    ['a script hidden in a style that is closed and then reopened', wrap('<style>.a{}</style><script>alert(1)</script>'), 'element'],
    ['an animation that writes a handler', wrap('<rect><set attributeName="onclick" to="alert(1)"/></rect>'), 'attribute'],
    ['an animation that writes an address', wrap('<a><animate attributeName="xlink:href" values="javascript:alert(1)"/></a>'), 'attribute'],
    ['an animation that writes the plain address attribute', wrap('<a><set attributeName="href" to="https://evil.example"/></a>'), 'attribute']
  ])('%s', (_label, svg, reason) => {
    expect(refusal(svg)).toBe(reason);
  });
});

describe('an SVG with an active element', () => {
  it.each(['foreignObject', 'foreignobject', 'iframe', 'embed', 'object', 'applet', 'video', 'audio', 'canvas', 'html', 'body', 'form', 'input', 'link', 'meta', 'base'])('refuses <%s>', (name) => {
    expect(refusal(wrap(`<${name}/>`))).toBe('element');
    expect(refusal(wrap(`<${name}></${name}>`))).toBe('element');
  });

  it('refuses a foreignObject that carries HTML', () => {
    expect(refusal(wrap('<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject>'))).toBe('element');
  });

  it('refuses a foreignObject with a prefix', () => {
    expect(refusal(wrap('<svg:foreignObject xmlns:svg="http://www.w3.org/2000/svg"/>'))).toBe('element');
  });
});

describe('an SVG that reaches outside the document', () => {
  it.each([
    ['an external href', wrap('<a href="https://evil.example/x"><rect/></a>')],
    ['an external xlink:href', wrap('<a xlink:href="https://evil.example/x"><rect/></a>')],
    ['an image from another site', wrap('<image href="https://evil.example/pixel.png"/>')],
    ['an image with a protocol-relative address', wrap('<image href="//evil.example/pixel.png"/>')],
    ['an image with a relative path', wrap('<image href="../secret.png"/>')],
    ['an image that carries its data', wrap('<image href="data:image/png;base64,AAAA"/>')],
    ['a use of another file', wrap('<use href="http://evil.example/x.svg#a"/>')],
    ['a use of a relative file', wrap('<use xlink:href="other.svg#a"/>')],
    ['a javascript address', wrap('<a href="javascript:alert(1)"><rect/></a>')],
    ['a javascript address in capitals', wrap('<a href="JaVaScRiPt:alert(1)"><rect/></a>')],
    ['a javascript address with a character reference', wrap('<a href="java&#115;cript:alert(1)"><rect/></a>')],
    ['a javascript address with a hex reference', wrap('<a href="&#x6A;avascript:alert(1)"><rect/></a>')],
    ['a javascript address with a tab and a line break inside', wrap('<a href="java&#9;scr&#10;ipt:alert(1)"><rect/></a>')],
    ['a javascript address with a leading space', wrap('<a href=" javascript:alert(1)"><rect/></a>')],
    ['a vbscript address', wrap('<a href="vbscript:msgbox(1)"><rect/></a>')],
    ['a data address in an attribute that is not an address', wrap('<rect fill="data:text/html,<script>"/>')],
    ['a base that moves the fragments', wrap('<use href="#a"/>', ' xml:base="https://evil.example/"')],
    ['a url() to another site in a presentation attribute', wrap('<rect fill="url(https://evil.example/p.svg#a)"/>')],
    ['a url() with a data address', wrap('<rect filter="url(data:image/svg+xml;base64,AAAA)"/>')],
    ['a url() with quotes', wrap('<rect fill="url(\'https://evil.example/p\')"/>')],
    ['a url() in a style attribute', wrap('<rect style="fill:url(https://evil.example/p)"/>')],
    ['a style with an import', wrap('<style>@import url(https://evil.example/x.css);</style>')],
    ['a style with a background from another site', wrap('<style>.a{background:url(https://evil.example/x.png)}</style>')],
    ['a style with an escape that spells url', wrap('<style>.a{background:\\75rl(https://evil.example/x.png)}</style>')],
    ['a style attribute with an escape', wrap('<rect style="fill:\\75rl(javascript:alert(1))"/>')],
    ['a style with an expression', wrap('<style>.a{width:expression(alert(1))}</style>')],
    ['a style with a binding', wrap('<style>.a{-moz-binding:url(x.xml#y)}</style>')],
    ['a style with image-set', wrap('<style>.a{background:image-set("https://evil.example/x.png" 1x)}</style>')],
    ['a style in CDATA with an external url', wrap('<style><![CDATA[.a{background:url(https://evil.example/x.png)}]]></style>')],
    ['a stylesheet instruction', `<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/x.css" type="text/css"?><svg ${NS}/>`]
  ])('refuses %s', (_label, svg) => {
    expect(verdict(svg).ok).toBe(false);
  });
});

describe('an SVG with an entity or a doctype that is not the standard one', () => {
  it.each([
    ['an internal subset with an entity', `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa">]><svg ${NS}><text>&a;</text></svg>`],
    ['the expansion of an entity into a script', `<!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg ${NS}>&x;</svg>`],
    ['an external entity', `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg ${NS}><text>&xxe;</text></svg>`],
    ['a doctype that is not svg', `<!DOCTYPE html><svg ${NS}/>`],
    ['a doctype after the root', `<svg ${NS}/><!DOCTYPE svg>`],
    ['a second doctype', `<!DOCTYPE svg><!DOCTYPE svg><svg ${NS}/>`],
    ['an entity the document does not define', wrap('<text>&nbsp;</text>')],
    ['a reference to NUL', wrap('<text>&#0;</text>')],
    ['a reference past the last code point', wrap('<text>&#x110000;</text>')],
    ['a reference to a surrogate', wrap('<text>&#xD800;</text>')]
  ])('refuses %s', (_label, svg) => {
    expect(verdict(svg).ok).toBe(false);
  });
});

describe('an SVG that is not a well-formed document with an svg root', () => {
  it.each([
    ['an html page', '<html><body><script>alert(1)</script></body></html>', 'element'],
    ['a document of another root', '<note><to>x</to></note>', 'root'],
    ['a root with a prefix', '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>', 'root'],
    ['plain text', 'not an svg', 'malformed'],
    ['text before the root', `hello ${SAFE_SVG}`, 'malformed'],
    ['text after the root', `${SAFE_SVG} tail`, 'malformed'],
    ['a second root', `<svg ${NS}/><svg ${NS}/>`, 'malformed'],
    ['a tag that is never closed', `<svg ${NS}><rect`, 'malformed'],
    ['a root that is never closed', `<svg ${NS}><g>`, 'malformed'],
    ['a closing tag with no opening', `<svg ${NS}></g></svg></svg>`, 'malformed'],
    ['a comment that is never closed', `<svg ${NS}><!-- </svg>`, 'malformed'],
    ['a CDATA that is never closed', `<svg ${NS}><![CDATA[ </svg>`, 'malformed'],
    ['a CDATA outside the root', `<![CDATA[x]]><svg ${NS}/>`, 'malformed'],
    ['an attribute with no quotes', `<svg ${NS}><rect width=5/></svg>`, 'malformed'],
    ['an attribute with no value', `<svg ${NS}><rect hidden/></svg>`, 'malformed'],
    ['the same attribute twice', `<svg ${NS}><rect width="1" width="2"/></svg>`, 'malformed'],
    ['a less-than in an attribute value', `<svg ${NS}><rect width="1<2"/></svg>`, 'malformed'],
    ['attributes with no space between them', `<svg ${NS}><rect width="1"height="2"/></svg>`, 'malformed'],
    ['a closing tag with attributes', `<svg ${NS}></svg onload="x">`, 'malformed'],
    ['a less-than that opens nothing', `<svg ${NS}>< g/></svg>`, 'malformed'],
    ['a tag name that starts with a digit', `<svg ${NS}><1g/></svg>`, 'malformed'],
    ['a declaration that is not at the start', ` <?xml version="1.0"?><svg ${NS}/>`, 'instruction']
  ])('refuses %s', (_label, svg, reason) => {
    expect(refusal(svg)).toBe(reason);
  });
});

describe('an SVG whose bytes are not UTF-8 text of a sane size', () => {
  it('refuses nothing, and a file that is too large', () => {
    expect(inspectSvg(new Uint8Array(0))).toEqual({ ok: false, reason: 'size' });
    expect(inspectSvg(new Uint8Array(SVG_MAX_BYTES + 1).fill(0x20))).toEqual({ ok: false, reason: 'size' });
  });

  it('accepts one of exactly the largest size', () => {
    const filler = ' '.repeat(SVG_MAX_BYTES - SAFE_SVG.length);
    expect(inspectSvg(textBytes(`${SAFE_SVG}${filler}`))).toEqual({ ok: true });
  });

  it('refuses UTF-16, invalid UTF-8 and a NUL', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from('<svg/>').flatMap((character) => [character.charCodeAt(0), 0])]);
    expect(inspectSvg(utf16)).toEqual({ ok: false, reason: 'encoding' });
    expect(inspectSvg(Uint8Array.of(0x3c, 0x73, 0x76, 0x67, 0xc3, 0x28, 0x2f, 0x3e))).toEqual({ ok: false, reason: 'encoding' });
    expect(inspectSvg(textBytes(`<svg ${NS}><text>a\u0000b</text></svg>`))).toEqual({ ok: false, reason: 'encoding' });
  });

  it('reads a large file of hostile shape in a bounded time', () => {
    const hostile = [
      wrap(`<style>${'url( '.repeat(40_000)}</style>`),
      wrap(`<rect fill="${'url(  '.repeat(40_000)}"/>`),
      wrap('<g>'.repeat(40_000)),
      wrap(`<text>${'&amp;'.repeat(40_000)}</text>`),
      `<svg ${NS}>${'<!-- -->'.repeat(30_000)}</svg>`
    ];
    const started = performance.now();
    for (const svg of hostile) inspectSvg(textBytes(svg));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
