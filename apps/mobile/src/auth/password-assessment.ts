import { AuthPasswordSchema } from '@ageniza/contracts';

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export function assessConfirmation(password: string, confirmation: string) {
  if (!confirmation) return 'empty';
  if (password === confirmation) return 'match';
  return password.startsWith(confirmation) ? 'incomplete' : 'different';
}

export function assessPassword(password: string) {
  const minimum = AuthPasswordSchema.minLength!;
  const maximum = AuthPasswordSchema.maxLength!;
  const sample = password.slice(0, maximum).toLocaleLowerCase('pt-BR');
  const variety = new Set(sample).size;
  const predictable = variety < 5 || /^(.{1,4})\1+$/u.test(sample) || /senha|password|qwerty|123456|abcdef|letmein|admin/.test(sample);
  // Local guidance only: this is not an entropy calculation or a breach check.
  const score: PasswordScore = !password ? 0 : predictable || password.length < minimum ? 1 : sample.length >= 20 && variety >= 8 ? 4 : sample.length >= 14 && variety >= 6 ? 3 : 2;
  return {
    valid: AuthPasswordSchema.safeParse(password).success,
    minimum,
    maximum,
    missing: Math.max(0, minimum - password.length),
    excess: Math.max(0, password.length - maximum),
    score,
    predictable,
  };
}
