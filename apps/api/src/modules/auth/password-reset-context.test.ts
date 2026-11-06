import { describe, expect, it } from 'vitest';
import { currentPasswordResetMobileWeb, runWithPasswordResetMobileWeb } from './audit-context.js';

describe('password reset destination context', () => {
  it('isolates concurrent callbacks and clears the context after completion', async () => {
    const values = await Promise.all([true, false].map((mobile) => runWithPasswordResetMobileWeb(mobile, async () => {
      await new Promise((resolve) => setTimeout(resolve, mobile ? 5 : 1));
      return currentPasswordResetMobileWeb();
    })));
    expect(values).toEqual([true, false]);
    expect(currentPasswordResetMobileWeb()).toBe(false);
  });
});
