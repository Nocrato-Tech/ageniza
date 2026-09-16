import { z } from 'zod';

import { ConfigValidationError, formatZodIssues } from './errors.js';

export type RuntimeEnvironment = 'local' | 'test' | 'production';

const runtimeEnvironmentSchema = z.string({ required_error: 'is required; use local, test, or production' }).trim().transform((value, context): RuntimeEnvironment => {
  if (value === 'local' || value === 'development') return 'local';
  if (value === 'test' || value === 'ci') return 'test';
  if (value === 'production') return 'production';

  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: value === 'staging' || value === 'develop'
      ? 'is not a supported runtime; staging is not modeled and develop is a Git branch'
      : 'must be local, test, or production'
  });
  return z.NEVER;
});

/** Parses the intentionally small set of supported deployment runtimes. */
export const loadRuntimeEnvironment = (value: unknown, variableName = 'APP_ENV'): RuntimeEnvironment => {
  const result = runtimeEnvironmentSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigValidationError('Runtime', formatZodIssues(result.error.issues).map((issue) => ({
      ...issue,
      path: issue.path === 'configuration' ? variableName : `${variableName}.${issue.path}`
    })));
  }
  return result.data;
};

export const isLoopbackUrl = (value: string): boolean => {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
};

export const assertRuntimeUrlSafety = (environment: RuntimeEnvironment, variableName: string, value: string, options: { requireHttpsInProduction?: boolean; allowDockerHostGateway?: boolean } = {}): void => {
  const url = new URL(value);
  const dockerHostGateway = url.hostname.toLowerCase() === 'host.docker.internal';
  const allowedLocalHost = isLoopbackUrl(value) || (options.allowDockerHostGateway === true && dockerHostGateway);
  if ((environment === 'local' || environment === 'test') && !allowedLocalHost) {
    throw new ConfigValidationError('Runtime', [{ path: variableName, message: `must point to a loopback resource when runtime is ${environment}; received [REDACTED]` }]);
  }
  if (environment === 'production' && isLoopbackUrl(value)) {
    throw new ConfigValidationError('Runtime', [{ path: variableName, message: 'must not point to a loopback resource in production; received [REDACTED]' }]);
  }
  if (environment === 'production' && options.requireHttpsInProduction && url.protocol !== 'https:') {
    throw new ConfigValidationError('Runtime', [{ path: variableName, message: 'must use HTTPS in production; received [REDACTED]' }]);
  }
};
