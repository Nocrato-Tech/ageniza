import { describe, expect, it } from 'vitest';

import { canSeeRemovedLinks } from './policy.js';

const tenant = (isOwner: boolean, ...permissions: string[]) => ({ isOwner, permissions: new Set(permissions) });

describe('canSeeRemovedLinks (issue #98)', () => {
  it('lets in the Owner by ownership, with no permission at all', () => {
    expect(canSeeRemovedLinks(tenant(true))).toBe(true);
  });

  it('lets in whoever can remove or reactivate, each permission on its own', () => {
    expect(canSeeRemovedLinks(tenant(false, 'colaborador.remover'))).toBe(true);
    expect(canSeeRemovedLinks(tenant(false, 'colaborador.alterar_papel'))).toBe(true);
  });

  it('keeps out everyone else, including who only edits job titles, views, grants admin or invites', () => {
    for (const permission of ['colaborador.alterar_funcao', 'colaborador.visualizar', 'colaborador.atribuir_admin', 'colaborador.convidar']) {
      expect(canSeeRemovedLinks(tenant(false, permission)), permission).toBe(false);
    }
    expect(canSeeRemovedLinks(tenant(false))).toBe(false);
  });
});
