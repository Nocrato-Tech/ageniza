import { describe, expect, it } from 'vitest';

import { COLLABORATOR_PERMISSIONS, permissionsRequiredByChange } from './policy.js';

const roleId = '66666666-6666-4666-8666-666666666666';

describe('permissionsRequiredByChange (issue #97)', () => {
  it('asks only for what the body carries', () => {
    expect(permissionsRequiredByChange({ jobTitle: 'Editor' }, false)).toEqual([COLLABORATOR_PERMISSIONS.changeJobTitle]);
    expect(permissionsRequiredByChange({ jobTitle: null }, false)).toEqual([COLLABORATOR_PERMISSIONS.changeJobTitle]);
    expect(permissionsRequiredByChange({ roleId }, false)).toEqual([COLLABORATOR_PERMISSIONS.changeRole]);
    expect(permissionsRequiredByChange({ jobTitle: 'Editor', roleId }, false)).toEqual([
      COLLABORATOR_PERMISSIONS.changeJobTitle,
      COLLABORATOR_PERMISSIONS.changeRole
    ]);
  });

  it('adds the admin grant only when a role is being handed out and that role is admin', () => {
    expect(permissionsRequiredByChange({ roleId }, true)).toEqual([COLLABORATOR_PERMISSIONS.changeRole, COLLABORATOR_PERMISSIONS.grantAdmin]);
    expect(permissionsRequiredByChange({ jobTitle: 'Editor', roleId }, true)).toContain(COLLABORATOR_PERMISSIONS.grantAdmin);
    expect(permissionsRequiredByChange({ jobTitle: 'Editor' }, true)).toEqual([COLLABORATOR_PERMISSIONS.changeJobTitle]);
  });

  it('names the permissions the catalog defines', () => {
    expect(COLLABORATOR_PERMISSIONS).toEqual({
      changeRole: 'colaborador.alterar_papel',
      changeJobTitle: 'colaborador.alterar_funcao',
      grantAdmin: 'colaborador.atribuir_admin'
    });
  });
});
