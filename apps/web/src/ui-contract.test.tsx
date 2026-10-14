// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ButtonLink, ClientStrip, type ClientStripItem } from '@ageniza/ui';

afterEach(cleanup);

/**
 * `packages/ui` leaves its tests out of its own typecheck, so the contracts that live in a type are proven here, in the app
 * that consumes them: each `@ts-expect-error` is an error the `pnpm typecheck` gate reports as unused if the type stops
 * asking. The wrong forms are never rendered, only compiled.
 */
describe('the types of @ageniza/ui that ask for an address', () => {
  it('asks a plain ButtonLink for an href: an anchor without one is not a link', () => {
    // @ts-expect-error `href` is required when `as` is not given
    const withoutAddress = () => <ButtonLink>Sem endereço</ButtonLink>;

    expect(typeof withoutAddress).toBe('function');
  });

  it('asks the router Link given in `as` for its own `to`', () => {
    // @ts-expect-error `to` is required by the Link given in `as`
    const withoutDestination = () => <ButtonLink as={Link}>Sem destino</ButtonLink>;

    expect(typeof withoutDestination).toBe('function');
  });

  it('asks a client of the ClientStrip for its href', () => {
    // @ts-expect-error `href` is required on every client of the strip
    const withoutAddress: ClientStripItem = { id: 'c1', name: 'Padaria Central' };

    expect(withoutAddress.name).toBe('Padaria Central');
    expect(typeof ClientStrip).toBe('function');
  });

  it('accepts the address each form asks for', () => {
    render(<MemoryRouter><ButtonLink href="/x">Âncora</ButtonLink><ButtonLink as={Link} to="/y">Roteador</ButtonLink></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Âncora' }).getAttribute('href')).toBe('/x');
    expect(screen.getByRole('link', { name: 'Roteador' }).getAttribute('href')).toBe('/y');
  });
});
