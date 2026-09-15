import type { ZodIssue } from 'zod';

export class ConfigValidationError extends Error {
  public constructor(scope: string, issues: readonly { path: string; message: string }[]) {
    super(`${scope} configuration is invalid:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}\nConfiguration values are redacted.`);
    this.name = 'ConfigValidationError';
  }
}

export const formatZodIssues = (issues: readonly ZodIssue[]): { path: string; message: string }[] =>
  issues.map((issue) => ({ path: issue.path.join('.') || 'configuration', message: issue.message }));
