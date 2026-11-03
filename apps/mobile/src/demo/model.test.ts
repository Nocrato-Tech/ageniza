import { describe, expect, it } from 'vitest';
import { decidePost, initialPosts } from './model';

describe('demonstration state is local and explicit', () => {
  it('changes only the selected post and requires a comment for adjustments', () => {
    const original = initialPosts();
    expect(decidePost(original, 'post-1', 'changes', '   ')).toEqual(original);
    const updated = decidePost(original, 'post-1', 'changes', ' Trocar a capa ');
    expect(updated[0]).toMatchObject({ status: 'adjusting', feedback: 'Trocar a capa' });
    expect(updated[1]).toEqual(original[1]); expect(original[0].status).toBe('awaiting_approval');
  });
  it('supports submit, request changes, resubmit and approval without approving a draft', () => {
    let posts = initialPosts();
    expect(decidePost(posts, 'post-2', 'approve')[1].status).toBe('in_production');
    posts = decidePost(posts, 'post-2', 'submit');
    posts = decidePost(posts, 'post-2', 'changes', 'Revisar legenda');
    posts = decidePost(posts, 'post-2', 'submit');
    posts = decidePost(posts, 'post-2', 'approve');
    expect(posts[1]).toMatchObject({ status: 'approved', feedback: undefined });
    expect(initialPosts()[1].status).toBe('in_production');
  });
});
