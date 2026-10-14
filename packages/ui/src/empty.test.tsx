// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ArrowRight, Plus } from 'lucide-react';
import { forwardRef, type AnchorHTMLAttributes } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button, ButtonLink, EmptyState, Mascot } from './index.js';

afterEach(cleanup);

describe('Mascot', () => {
  it('serves the friendly owl as WebP with a 2x source and the box of its pose', () => {
    const { container } = render(<Mascot variant="friendly" />);
    const image = container.querySelector('img')!;

    expect(image.getAttribute('src')).toBe('/brand/mascote-amigavel.webp');
    expect(image.getAttribute('srcset')).toBe('/brand/mascote-amigavel.webp 1x, /brand/mascote-amigavel@2x.webp 2x');
    expect(image.getAttribute('width')).toBe('169');
    expect(image.getAttribute('height')).toBe('240');
  });

  it('serves the serious owl with its own files and width', () => {
    const { container } = render(<Mascot variant="serious" />);
    const image = container.querySelector('img')!;

    expect(image.getAttribute('src')).toBe('/brand/mascote-serio.webp');
    expect(image.getAttribute('srcset')).toBe('/brand/mascote-serio.webp 1x, /brand/mascote-serio@2x.webp 2x');
    expect(image.getAttribute('width')).toBe('191');
    expect(image.getAttribute('height')).toBe('240');
  });

  it('scales the width with the height it is given', () => {
    const { container } = render(<Mascot variant="serious" height={120} />);

    expect(container.querySelector('img')?.getAttribute('width')).toBe('96');
    expect(container.querySelector('img')?.getAttribute('height')).toBe('120');
  });

  it('is decorative unless it is given a description', () => {
    const { container, rerender } = render(<Mascot variant="friendly" />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');

    rerender(<Mascot variant="friendly" alt="Coruja acenando" />);
    expect(screen.getByRole('img', { name: 'Coruja acenando' })).toBeTruthy();
  });

  it('keeps the class of the screen next to its own', () => {
    const { container } = render(<Mascot variant="friendly" className="screen__owl" />);

    expect(container.querySelector('img')?.className).toBe('ui-mascot screen__owl');
  });
});

describe('EmptyState', () => {
  it('says what is missing under the heading of the screen, with what comes next and the way forward', () => {
    render(<EmptyState title="Cadastre o primeiro cliente" description="Leva uns 2 minutos." action={<Button>Cadastrar cliente</Button>} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Cadastre o primeiro cliente' })).toBeTruthy();
    expect(screen.getByText('Leva uns 2 minutos.').className).toBe('ui-empty-state__description');
    expect(screen.getByRole('button', { name: 'Cadastrar cliente' })).toBeTruthy();
  });

  it('nests its heading where the screen says', () => {
    render(<EmptyState title="Nada por aqui" headingLevel={3} />);

    expect(screen.getByRole('heading', { level: 3, name: 'Nada por aqui' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('shows no owl by default: a search with no results is text and a button', () => {
    const { container } = render(<EmptyState title="Nenhum cliente encontrado" action={<Button variant="secondary">Limpar filtros</Button>} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.ui-empty-state--mascot')).toBeNull();
    expect(screen.getByRole('button', { name: 'Limpar filtros' })).toBeTruthy();
  });

  it('shows the friendly owl once, decorative, beside the text when asked', () => {
    const { container } = render(<EmptyState mascot title="Cadastre o primeiro cliente" action={<Button>Cadastrar</Button>} />);
    const images = container.querySelectorAll('img');

    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute('alt')).toBe('');
    expect(images[0]!.getAttribute('src')).toBe('/brand/mascote-amigavel.webp');
    expect(images[0]!.getAttribute('height')).toBe('200');
    expect(container.querySelector('.ui-empty-state--mascot')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('leaves out the description and the action it was not given', () => {
    const { container } = render(<EmptyState title="Sem conteúdo" />);

    expect(container.querySelector('.ui-empty-state__description')).toBeNull();
    expect(container.querySelector('.ui-empty-state__action')).toBeNull();
  });

  it('keeps the props of a div', () => {
    render(<EmptyState title="Sem conteúdo" className="clients__empty" data-testid="empty" />);

    expect(screen.getByTestId('empty').className).toBe('ui-empty-state clients__empty');
  });
});

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };
const RouterLink = forwardRef<HTMLAnchorElement, LinkProps>(function RouterLink({ to, ...props }, ref) {
  return <a ref={ref} href={`/app${to}`} data-router="yes" {...props} />;
});

describe('ButtonLink', () => {
  it('is a real link that looks like the primary button of medium size', () => {
    render(<ButtonLink href="/clientes">Ver clientes</ButtonLink>);
    const link = screen.getByRole('link', { name: 'Ver clientes' });

    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/clientes');
    expect(link.className).toBe('ui-button ui-button--primary ui-button--md');
    expect(link.querySelector('.ui-button__label')?.textContent).toBe('Ver clientes');
  });

  it.each(['primary', 'secondary', 'ghost', 'destructive'] as const)('wears the %s variant', (variant) => {
    render(<ButtonLink href="/x" variant={variant} size="lg">Ir</ButtonLink>);

    expect(screen.getByRole('link', { name: 'Ir' }).className).toBe(`ui-button ui-button--${variant} ui-button--lg`);
  });

  it('puts decorative icons before and after the label, which stays the whole name', () => {
    render(<ButtonLink href="/x" leadingIcon={<Plus />} trailingIcon={<ArrowRight />}>Novo cliente</ButtonLink>);
    const link = screen.getByRole('link', { name: 'Novo cliente' });
    const slots = link.querySelectorAll('.ui-icon');

    expect(slots).toHaveLength(2);
    expect(link.firstElementChild).toBe(slots[0]);
    expect(link.lastElementChild).toBe(slots[1]);
    slots.forEach((slot) => expect(slot.getAttribute('aria-hidden')).toBe('true'));
  });

  it("draws through the component it is given, with that component's own props", () => {
    render(<ButtonLink as={RouterLink} to="/clientes" size="lg">Ver clientes</ButtonLink>);
    const link = screen.getByRole('link', { name: 'Ver clientes' });

    expect(link.getAttribute('href')).toBe('/app/clientes');
    expect(link.getAttribute('data-router')).toBe('yes');
    expect(link.className).toBe('ui-button ui-button--primary ui-button--lg');
  });

  it('takes the keyboard focus and acts on click', () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(<ButtonLink href="/x" onClick={onClick}>Ir</ButtonLink>);
    const link = screen.getByRole('link', { name: 'Ir' });

    link.focus();
    fireEvent.click(link);

    expect(document.activeElement).toBe(link);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps the extra class, and a target and a rel for a link that leaves the app', () => {
    render(<ButtonLink href="https://example.test" target="_blank" rel="noreferrer" className="shell__cta">Abrir</ButtonLink>);
    const link = screen.getByRole('link', { name: 'Abrir' });

    expect(link.className).toBe('ui-button ui-button--primary ui-button--md shell__cta');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  describe('disabled', () => {
    it('stays on the page as a dimmed link that goes nowhere and cannot be tabbed to', () => {
      const onClick = vi.fn();
      render(<ButtonLink href="/x" disabled onClick={onClick}>Ir</ButtonLink>);
      const link = screen.getByRole('link', { name: 'Ir' });

      expect(link.getAttribute('aria-disabled')).toBe('true');
      expect(link.getAttribute('href')).toBeNull();
      expect(link.getAttribute('tabindex')).toBeNull();
      expect(link.tagName).toBe('SPAN');
      expect(link.className).toBe('ui-button ui-button--primary ui-button--md ui-button--link-disabled');

      fireEvent.click(link);
      expect(onClick).not.toHaveBeenCalled();
    });

    it('does not hand the router the address it was given', () => {
      render(<ButtonLink as={RouterLink} to="/clientes" disabled>Ver clientes</ButtonLink>);
      const link = screen.getByRole('link', { name: 'Ver clientes' });

      expect(link.getAttribute('data-router')).toBeNull();
      expect(link.getAttribute('href')).toBeNull();
      expect(link.getAttribute('to')).toBeNull();
    });

    it('is not disabled by default', () => {
      render(<ButtonLink href="/x">Ir</ButtonLink>);

      expect(screen.getByRole('link', { name: 'Ir' }).getAttribute('aria-disabled')).toBeNull();
    });
  });
});
