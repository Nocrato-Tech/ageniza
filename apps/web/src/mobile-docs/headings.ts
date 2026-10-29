/** The minimal shape of the markdown tree this file touches; it avoids a dependency on the parser's types. */
export interface MarkdownNode {
  type: string;
  value?: string;
  depth?: number;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, string> };
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces turned into hyphens. Letters keep their accents. */
export const headingSlug = (text: string): string =>
  text.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-');

const textOf = (node: MarkdownNode): string => node.value ?? node.children?.map(textOf).join('') ?? '';

/**
 * Gives every heading the id GitHub would give it (a repeated heading gets `-1`, `-2`, ...), so the links written
 * for GitHub, such as `comecar.md#3-o-que-falta-no-backend-para-o-app`, find their target on this page too.
 */
export function remarkHeadingIds() {
  return (tree: MarkdownNode): void => {
    const seen = new Map<string, number>();
    const visit = (node: MarkdownNode): void => {
      if (node.type === 'heading') {
        const base = headingSlug(textOf(node));
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: count === 0 ? base : `${base}-${count}` } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
