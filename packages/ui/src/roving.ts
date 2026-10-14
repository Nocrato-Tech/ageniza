/**
 * Which item a key moves to in a group that keeps a single tab stop (tabs, radio group), or `null`
 * when the key is not a movement. Disabled items are skipped and the ends wrap around.
 */
export function rovingTarget(key: string, current: number, enabled: readonly boolean[], vertical: boolean): number | null {
  const count = enabled.length;
  const step = (direction: 1 | -1): number | null => {
    for (let offset = 1; offset < count; offset += 1) {
      const index = (((current + direction * offset) % count) + count) % count;
      if (enabled[index]) return index;
    }
    return null;
  };
  const edge = (index: number): number | null => (index === -1 ? null : index);
  switch (key) {
    case 'ArrowRight': return step(1);
    case 'ArrowLeft': return step(-1);
    case 'ArrowDown': return vertical ? step(1) : null;
    case 'ArrowUp': return vertical ? step(-1) : null;
    case 'Home': return edge(enabled.indexOf(true));
    case 'End': return edge(enabled.lastIndexOf(true));
    default: return null;
  }
}
