// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RoleTag, type RoleTagTone } from './role-tag.js';

afterEach(cleanup);

describe('RoleTag', () => {
  it.each<[RoleTagTone, string]>([
    ['indigo', 'Admin'],
    ['violet', 'Gestor de conta'],
    ['teal', 'Produção'],
    ['sky', 'Vendas']
  ])('says the %s role by its name, with its colour and a shield', (tone, name) => {
    render(<RoleTag name={name} tone={tone} />);
    const tag = screen.getByText(name);

    expect(tag.classList.contains(`ui-role-tag--${tone}`)).toBe(true);
    expect(tag.querySelector('svg.lucide-shield-check')).not.toBeNull();
    expect(tag.querySelector('svg.lucide-crown')).toBeNull();
  });

  it('stays grey for a role with no colour of its own', () => {
    render(<RoleTag name="Financeiro" />);

    expect(screen.getByText('Financeiro').className).toBe('ui-pill ui-pill--neutral ui-role-tag');
  });

  it('says "Dona da agência" with a crown, in indigo, whatever the role and tone passed, for the owner', () => {
    render(<RoleTag name="Admin" tone="sky" isOwner />);
    const tag = screen.getByText('Dona da agência');

    expect(screen.queryByText('Admin')).toBeNull();
    expect(tag.classList.contains('ui-role-tag--indigo')).toBe(true);
    expect(tag.classList.contains('ui-role-tag--sky')).toBe(false);
    expect(tag.querySelector('svg.lucide-crown')).not.toBeNull();
  });

  it('is named by the words it shows, not by the colour', () => {
    const { container } = render(<RoleTag name="Vendas" tone="sky" />);

    expect(container.textContent).toBe('Vendas');
    expect(container.querySelector('[aria-label]')).toBeNull();
  });
});
