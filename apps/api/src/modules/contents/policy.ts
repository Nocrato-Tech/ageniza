/** specs/conteudo.md section 2: reading is `conteudo.visualizar`, and a write asks for it as well as for its own. */
export const CONTENT_READ_PERMISSION = 'conteudo.visualizar';

/**
 * Who is in charge of a content decides who approves its subtasks (the SPEC's rule 10), so changing it is the
 * permission to approve for the agency; the database refuses the change without it (42501).
 */
export const CONTENT_OWNER_CHANGE_PERMISSION = 'conteudo.aprovar_pela_agencia';
