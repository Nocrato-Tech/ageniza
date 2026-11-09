import { expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeProductError } from './feedback-errors';
it('explains that invalid media can be a list or cover issue and gives a recovery path', () => {
  const message = describeProductError(new ApiError(400, 'CONTENT_MEDIA_INVALID', 'Database refusal secret detail'));
  expect(message).toContain('mídias e a capa');
  expect(message).toContain('mesma pasta');
  expect(message).toContain('limite');
  expect(message).not.toContain('secret');
});
it('explains the comment restriction for cancelled content', () => {
  expect(describeProductError(new ApiError(409, 'CONTENT_NOT_OPEN', 'internal'))).toContain('cancelado');
});
