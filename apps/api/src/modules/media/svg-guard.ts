/**
 * Whether an SVG may be stored (decision 2026-11-11, "a mídia aceita PDF, áudio e SVG como logo"). An SVG is a document that can run
 * script, so the confirmation reads the whole file and refuses what carries a script, an event handler, a `foreignObject`, an
 * external reference or an address with a scheme. This is the second line: the first is that the file is only ever served as a
 * download and shown as an `<img>`, where no script runs. The reader is strict on purpose: a document that is not well formed is
 * refused, since a browser would refuse to draw it anyway.
 */

/** The largest SVG a logo is: the markup of a logo is a few kilobytes, and what is larger is a drawing that carries data. */
export const SVG_MAX_BYTES = 256 * 1024;

export type SvgVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const REJECT = (reason: string): SvgVerdict => ({ ok: false, reason });

// The elements that run or load something, by local name: an element of any namespace prefix counts (`x:script` is a script when `x`
// is bound to XHTML).
const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  'script', 'foreignobject', 'iframe', 'frame', 'frameset', 'embed', 'object', 'applet', 'audio', 'video', 'source', 'track',
  'handler', 'listener', 'html', 'head', 'body', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'canvas'
]);

// SMIL can write any attribute of its target, so one that names an address or a handler is a way around the rules on the attributes.
const ANIMATION_ELEMENTS: ReadonlySet<string> = new Set(['animate', 'set', 'animatetransform', 'animatemotion', 'discard']);

// The attributes whose value is an address: only a reference to an element of the same document (`#id`) is accepted.
const ADDRESS_ATTRIBUTES: ReadonlySet<string> = new Set([
  'href', 'src', 'action', 'formaction', 'poster', 'srcset', 'ping', 'background', 'codebase', 'cite', 'longdesc', 'usemap', 'manifest', 'data'
]);

// `xml:base` moves what a `#fragment` is relative to, so it turns a reference to the document into one to another address.
const FORBIDDEN_ATTRIBUTES: ReadonlySet<string> = new Set(['base']);

const SCHEME = /^(?:javascript|vbscript|livescript|mocha|data):/i;
const URL_FUNCTION = /url\(\s*(['"]?)\s*([^)'"]*)/gi;
// An escape (`\75rl(`) is how a threat is written so that this list does not read it.
const CSS_THREAT = /@import|expression\s*\(|-moz-binding|behavior\s*:|image-set\s*\(|(?<![\w-])src\s*\(|\\/i;

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]*));/g;

/**
 * Character and entity references written out, so `java&#115;cript:` and `&#x6A;avascript:` read as what a browser reads.
 * `undefined` for a text that is not well formed XML: an `&` that opens no reference, an entity the document does not define (the
 * five of XML are the only ones, since a doctype with entities is refused) and a character no document holds.
 */
const decodeReferences = (value: string): string | undefined => {
  if (value.replace(REFERENCE, '').includes('&')) return undefined;
  let valid = true;
  const decoded = value.replace(REFERENCE, (_match, decimal?: string, hexadecimal?: string, name?: string) => {
    if (name !== undefined) {
      if (!Object.hasOwn(NAMED_ENTITIES, name)) {
        valid = false;
        return '';
      }
      return NAMED_ENTITIES[name]!;
    }
    const codePoint = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hexadecimal!, 16);
    if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      valid = false;
      return '';
    }
    return String.fromCodePoint(codePoint);
  });
  return valid ? decoded : undefined;
};

// A browser drops the tabs, line breaks and spaces inside the scheme of an address (`java\nscript:`), and the controls with them.
// eslint-disable-next-line no-control-regex -- the control characters are what this removes
const compact = (value: string): string => value.replace(/[\s\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '');

/** Whether the text of a style (an attribute or the content of `<style>`) loads anything or hides what it loads behind an escape. */
const styleIsSafe = (css: string): boolean => !CSS_THREAT.test(css) && referencesStayInTheDocument(css);

/** Every `url(...)` of the text points at an element of the same document. */
const referencesStayInTheDocument = (value: string): boolean => {
  for (const match of value.matchAll(URL_FUNCTION)) {
    if (!(match[2] ?? '').trim().startsWith('#')) return false;
  }
  return true;
};

const localName = (qualified: string): string => qualified.slice(qualified.lastIndexOf(':') + 1).toLowerCase();

interface Attribute {
  readonly name: string;
  readonly value: string;
}

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: readonly Attribute[];
  readonly end: number;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHARACTER = /[A-Za-z0-9_.:-]/;
const WHITESPACE = /[ \t\r\n]/;

/** Reads the tag that opens at `start` (a `<`), or `undefined` when it is not well formed. */
const readTag = (text: string, start: number): Tag | undefined => {
  let position = start + 1;
  const closing = text[position] === '/';
  if (closing) position += 1;
  if (!NAME_START.test(text[position] ?? '')) return undefined;
  const nameStart = position;
  while (NAME_CHARACTER.test(text[position] ?? '')) position += 1;
  const name = text.slice(nameStart, position);
  const attributes: Attribute[] = [];
  const seen = new Set<string>();

  for (;;) {
    const before = position;
    while (WHITESPACE.test(text[position] ?? '')) position += 1;
    const next = text[position];
    if (next === undefined) return undefined;
    if (next === '>') return { name, closing, selfClosing: false, attributes, end: position + 1 };
    if (next === '/') return text[position + 1] === '>' && !closing ? { name, closing, selfClosing: true, attributes, end: position + 2 } : undefined;
    if (closing || position === before || !NAME_START.test(next)) return undefined;

    const attributeStart = position;
    while (NAME_CHARACTER.test(text[position] ?? '')) position += 1;
    const attributeName = text.slice(attributeStart, position);
    if (seen.has(attributeName)) return undefined;
    seen.add(attributeName);
    while (WHITESPACE.test(text[position] ?? '')) position += 1;
    if (text[position] !== '=') return undefined;
    position += 1;
    while (WHITESPACE.test(text[position] ?? '')) position += 1;
    const quote = text[position];
    if (quote !== '"' && quote !== "'") return undefined;
    const close = text.indexOf(quote, position + 1);
    if (close === -1) return undefined;
    const value = text.slice(position + 1, close);
    if (value.includes('<')) return undefined;
    attributes.push({ name: attributeName, value });
    position = close + 1;
  }
};

const attributeIsSafe = (element: string, attribute: Attribute): boolean => {
  const name = localName(attribute.name);
  if (name.startsWith('on') || FORBIDDEN_ATTRIBUTES.has(name)) return false;
  const value = decodeReferences(attribute.value);
  if (value === undefined) return false;
  const flat = compact(value);

  if (ADDRESS_ATTRIBUTES.has(name) && flat !== '' && !flat.startsWith('#')) return false;
  if (SCHEME.test(flat)) return false;
  if (name === 'style' && !styleIsSafe(value)) return false;
  if (!referencesStayInTheDocument(value)) return false;
  if (ANIMATION_ELEMENTS.has(element) && name === 'attributename') {
    const target = localName(flat);
    if (ADDRESS_ATTRIBUTES.has(target) || target.startsWith('on')) return false;
  }
  return true;
};

const DOCTYPE_START = /^<!DOCTYPE\s+svg(?=[\s>])/i;

/** The end of a `<!DOCTYPE` with no internal subset (`[`): the entities of a subset are how a small file becomes a large one. */
const doctypeEnd = (text: string, start: number): number | undefined => {
  if (!DOCTYPE_START.test(text.slice(start, start + 20))) return undefined;
  let quote: string | undefined;
  for (let position = start + 2; position < text.length; position += 1) {
    const character = text[position]!;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      return undefined;
    } else if (character === '>') {
      return position + 1;
    }
  }
  return undefined;
};

/**
 * The text of a `<style>` up to its closing tag: plain text with no `<`, or one CDATA section. In XML anything else in a style is an
 * element (a `<svg onload>` inside it is one), so a style with markup in it is refused instead of read as text.
 */
const readStyleContent = (text: string, from: number): { readonly css: string; readonly end: number } | undefined => {
  const open = text.indexOf('<', from);
  if (open === -1) return undefined;
  if (text.startsWith('<![CDATA[', open) && text.slice(from, open).trim() === '') {
    const cdataEnd = text.indexOf(']]>', open + 9);
    if (cdataEnd === -1) return undefined;
    const close = text.indexOf('<', cdataEnd + 3);
    if (close === -1 || text.slice(cdataEnd + 3, close).trim() !== '' || !text.startsWith('</', close)) return undefined;
    return { css: text.slice(open + 9, cdataEnd), end: close };
  }
  if (!text.startsWith('</', open)) return undefined;
  const css = decodeReferences(text.slice(from, open));
  return css === undefined ? undefined : { css, end: open };
};

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Reads the bytes of an SVG and says whether it is accepted. Accepted: UTF-8 text, an `svg` root, no script or active element, no
 * event handler, no address that leaves the document (a `#fragment` stays), no scheme, no `@import`, no entity.
 */
export const inspectSvg = (bytes: Uint8Array): SvgVerdict => {
  if (bytes.length === 0 || bytes.length > SVG_MAX_BYTES) return REJECT('size');
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return REJECT('encoding');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) return REJECT('encoding');

  let position = 0;
  let sawRoot = false;
  const open: string[] = [];
  let sawDeclaration = false;
  let sawDoctype = false;
  for (;;) {
    const depth = open.length;
    const start = text.indexOf('<', position);
    if (start === -1) {
      // Text after the root is the one thing a document may not have beyond whitespace.
      return sawRoot && depth === 0 && text.slice(position).trim() === '' ? { ok: true } : REJECT('malformed');
    }
    const between = text.slice(position, start);
    if (depth === 0 ? between.trim() !== '' : decodeReferences(between) === undefined || between.includes(']]>')) return REJECT('malformed');

    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      if (end === -1) return REJECT('malformed');
      position = end + 3;
    } else if (text.startsWith('<![CDATA[', start)) {
      if (depth === 0) return REJECT('malformed');
      const end = text.indexOf(']]>', start + 9);
      if (end === -1) return REJECT('malformed');
      position = end + 3;
    } else if (text.startsWith('<?', start)) {
      const end = text.indexOf('?>', start + 2);
      if (end === -1) return REJECT('malformed');
      // Only the declaration of the document, at its start: any other instruction (`xml-stylesheet`) reaches for a file.
      if (start !== 0 || sawDeclaration || !/^<\?xml\s/i.test(text.slice(start, start + 6))) return REJECT('instruction');
      sawDeclaration = true;
      position = end + 2;
    } else if (text.startsWith('<!', start)) {
      if (sawRoot || sawDoctype) return REJECT('doctype');
      const end = doctypeEnd(text, start);
      if (end === undefined) return REJECT('doctype');
      sawDoctype = true;
      position = end;
    } else {
      const tag = readTag(text, start);
      if (tag === undefined) return REJECT('malformed');
      const element = localName(tag.name);
      if (FORBIDDEN_ELEMENTS.has(element)) return REJECT('element');

      if (!tag.closing) {
        if (!sawRoot) {
          if (element !== 'svg' || tag.name.includes(':')) return REJECT('root');
          sawRoot = true;
        } else if (depth === 0) {
          return REJECT('malformed');
        }
        if (!tag.attributes.every((attribute) => attributeIsSafe(element, attribute))) return REJECT('attribute');
        if (!tag.selfClosing) open.push(tag.name);
      } else if (open.pop() !== tag.name) {
        return REJECT('malformed');
      }

      position = tag.end;
      if (!tag.closing && !tag.selfClosing && element === 'style') {
        const style = readStyleContent(text, position);
        if (style === undefined || !styleIsSafe(style.css)) return REJECT('style');
        position = style.end;
      }
    }
  }
};
