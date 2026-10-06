/**
 * The two permissions that may read the assignable-roles list (issue #287; the rule is recorded in
 * `decisions.md`, 2026-10-06, pending validation). The tuple lives in its own leaf module so the
 * route registers, the guard demands and the catalog documents the very same object -- without the
 * catalog pulling in the collaborator route graph just to render documentation.
 */
export const COLLABORATOR_ROLES_READ_PERMISSIONS = ['colaborador.convidar', 'colaborador.alterar_papel'] as const;