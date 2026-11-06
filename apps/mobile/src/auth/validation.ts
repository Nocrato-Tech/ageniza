import { AuthEmailSchema, AuthLoginPasswordSchema, AuthPasswordSchema, AuthSignUpRequestSchema } from '@ageniza/contracts';

export type AuthField = 'name' | 'email' | 'password' | 'confirm' | 'accepted' | 'link';
export type AuthErrors = Partial<Record<AuthField, string>>;
export const passwordHint = 'Use de 10 a 128 caracteres.';
export function validateCredentials(input: { email?: string; name?: string; password?: string; confirm?: string; accepted?: boolean; newAccount?: boolean; newPassword?: boolean }): AuthErrors {
  const errors: AuthErrors = {};
  if (input.newAccount && !AuthSignUpRequestSchema.shape.name.safeParse(input.name).success) errors.name = 'Informe um nome válido, com até 120 caracteres.';
  if (input.email !== undefined && !AuthEmailSchema.safeParse(input.email).success) errors.email = 'Informe um e-mail válido.';
  if (input.password !== undefined && !(input.newAccount || input.newPassword ? AuthPasswordSchema : AuthLoginPasswordSchema).safeParse(input.password).success) errors.password = input.newAccount || input.newPassword ? passwordHint : 'Informe sua senha, com até 128 caracteres.';
  if (input.confirm !== undefined && input.password !== input.confirm) errors.confirm = 'As senhas precisam ser iguais.';
  if (input.newAccount && !input.accepted) errors.accepted = 'Para continuar, leia e aceite os documentos.';
  return errors;
}
