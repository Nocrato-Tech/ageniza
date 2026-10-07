export const COLLABORATOR_PERMISSIONS = {
  changeRole: 'colaborador.alterar_papel',
  changeJobTitle: 'colaborador.alterar_funcao',
  grantAdmin: 'colaborador.atribuir_admin'
} as const;

/**
 * The permissions a membership change needs, decided from the fields present in the body and not
 * from the route (`specs/colaboradores.md` §6): the job title needs `alterar_funcao`, the role needs
 * `alterar_papel`, and a role that is `admin` needs `atribuir_admin` on top. Granting admin is
 * judged by the value, so the same rule has to hold wherever a role is handed out (invitations).
 */
export const permissionsRequiredByChange = (
  change: { readonly jobTitle?: string | null; readonly roleId?: string },
  grantsAdmin: boolean
): string[] => {
  const required: string[] = [];
  if (change.jobTitle !== undefined) required.push(COLLABORATOR_PERMISSIONS.changeJobTitle);
  if (change.roleId !== undefined) {
    required.push(COLLABORATOR_PERMISSIONS.changeRole);
    if (grantsAdmin) required.push(COLLABORATOR_PERMISSIONS.grantAdmin);
  }
  return required;
};
