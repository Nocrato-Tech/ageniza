export type SelectionRect = { x: number; y: number; width: number; height: number };
export type SelectionPoint = { x: number; y: number };

export function sameRect(a: SelectionRect | undefined, b: SelectionRect) {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function usableRect(rect: SelectionRect | null): rect is SelectionRect {
  return !!rect && Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

export function liquidRect(lead: SelectionPoint, trail: SelectionPoint, size: Pick<SelectionRect, 'width' | 'height'>): SelectionRect {
  const width = size.width + Math.min(Math.abs(lead.x - trail.x), size.width * 0.65);
  const height = size.height + Math.min(Math.abs(lead.y - trail.y), size.height * 0.35);
  return { x: (lead.x + trail.x - width) / 2, y: (lead.y + trail.y - height) / 2, width, height };
}
