import { z } from 'zod';

/**
 * `GET /auth/providers`: which sign-in providers are on. A flag and nothing else: the client id and the secret stay on
 * the server, and the web only needs to know whether to draw "Entrar com o Google".
 */
export const AuthProvidersResponseSchema = z.object({ google: z.boolean() }).strict();

/**
 * `GET /auth/google/start`. `reauth` asks Google to authenticate the person again (the 5-minute proof a Google-only
 * account gives where a password is asked) and lands on the screen that asked for it.
 */
export const GOOGLE_INTENTS = ['login', 'reauth'] as const;
export const AuthGoogleStartQuerySchema = z.object({
  intent: z.enum(GOOGLE_INTENTS).optional()
}).strict();

/**
 * `GET /auth/callback/google`: what Google appends to the registered callback. Only these reach the sign-in, bounded;
 * the rest Google sends (`scope`, `authuser`, `prompt`, `hd`) is dropped.
 */
export const AuthGoogleCallbackQuerySchema = z.object({
  code: z.string().max(2_048).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(1_024).optional(),
  iss: z.string().max(512).optional()
});

export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponseSchema>;
export type AuthGoogleStartQuery = z.infer<typeof AuthGoogleStartQuerySchema>;
export type AuthGoogleCallbackQuery = z.infer<typeof AuthGoogleCallbackQuerySchema>;
