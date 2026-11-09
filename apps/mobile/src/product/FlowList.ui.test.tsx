// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
vi.mock('./motion', () => ({ useReducedMotion: () => false }));
import { FlowList } from './FlowList.web';

afterEach(cleanup);

it('preserves a focused item when reordered and makes departing actions inert immediately', () => {
  const first = { id: 'first' }, second = { id: 'second' };
  const renderItem = (item: { id: string }) => <input aria-label={item.id} defaultValue={item.id} />;
  const { rerender, getByLabelText } = render(<FlowList items={[first, second]} renderItem={renderItem} />);
  const input = getByLabelText('second');
  input.focus();
  rerender(<FlowList items={[second, first]} renderItem={renderItem} />);
  expect(getByLabelText('second')).toBe(input);
  expect(document.activeElement).toBe(input);
  rerender(<FlowList items={[second]} renderItem={renderItem} />);
  expect(getByLabelText('first').parentElement?.hasAttribute('inert')).toBe(true);
  expect(getByLabelText('first').parentElement?.getAttribute('aria-hidden')).toBe('true');
});
