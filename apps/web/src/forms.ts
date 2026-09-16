import type { z, ZodType } from 'zod';

export type FormErrors = Readonly<Record<string, readonly string[]>>;

/** Converts Zod transport/form errors into a field-addressable, UI-neutral shape. */
export const formatFormErrors = (error: z.ZodError): FormErrors => error.issues.reduce<Record<string, string[]>>((errors, issue) => {
  const field = issue.path.join('.') || '_form';
  (errors[field] ??= []).push(issue.message);
  return errors;
}, {});

export type FormValidation<T> = { success: true; data: T } | { success: false; errors: FormErrors };

/** Validates untrusted form values before they are passed to a transport client. */
export const validateForm = <T>(schema: ZodType<T>, values: unknown): FormValidation<T> => {
  const result = schema.safeParse(values);
  return result.success ? { success: true, data: result.data } : { success: false, errors: formatFormErrors(result.error) };
};
