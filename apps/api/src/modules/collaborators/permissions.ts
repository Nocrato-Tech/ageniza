/**
 * The two permissions that may read the assignable-roles list (issue #287; the rule is recorded in
 * `decisions.md`, 2026-10-06, pending validation). The tuple lives in its own leaf module so the
 * route registers, the guard demands and the catalog documents the very same object -- without the
 * catalog pulling in the collaborator route graph just to render documentation.
 */
export const COLLABORATOR_ROLES_READ_PERMISSIONS = ['colaborador.convidar', 'colaborador.alterar_papel'] as const;

/**
 * The two permissions that can change a membership through `PATCH` (issue #97): either one lets the
 * caller in, and the handler then demands the one of each field the body carries. Same leaf-module
 * reason as the tuple above: the guard, the route metadata and the catalog share one object.
 */
export const COLLABORATOR_UPDATE_PERMISSIONS = ['colaborador.alterar_funcao', 'colaborador.alterar_papel'] as const;
