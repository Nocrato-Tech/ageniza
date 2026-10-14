// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Logo, BrandSymbol } from './index.js';

afterEach(cleanup);

describe('Logo', () => {
  it('is named "Ageniza" for assistive technology', () => {
    render(<Logo />);

    expect(screen.getByRole('img', { name: 'Ageniza' }).getAttribute('alt')).toBe('Ageniza');
  });

  it.each([
    ['on-light', '/brand/logo-para-fundo-claro.svg'],
    ['on-dark', '/brand/logo-para-fundo-escuro.svg'],
    ['mono-ink', '/brand/logo-mono-ink.svg'],
    ['mono-white', '/brand/logo-mono-branco.svg']
  ] as const)('serves the %s production file', (variant, src) => {
    render(<Logo variant={variant} />);

    expect(screen.getByRole('img', { name: 'Ageniza' }).getAttribute('src')).toBe(src);
  });

  it('defaults to the logo for light backgrounds and keeps the exported proportion', () => {
    render(<Logo height={50} />);
    const image = screen.getByRole('img', { name: 'Ageniza' });

    expect(image.getAttribute('src')).toBe('/brand/logo-para-fundo-claro.svg');
    expect(image.getAttribute('height')).toBe('50');
    expect(image.getAttribute('width')).toBe('247');
  });

  it('passes className and native attributes through', () => {
    render(<Logo className="extra" data-testid="logo" />);

    expect(screen.getByTestId('logo').className).toBe('ui-logo extra');
  });
});

describe('BrandSymbol', () => {
  it('is decorative, with an empty alt, when no label is given', () => {
    const { container } = render(<BrandSymbol />);
    const image = container.querySelector('img')!;

    expect(image.getAttribute('alt')).toBe('');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('takes an accessible name from label', () => {
    render(<BrandSymbol label="Ageniza" />);

    expect(screen.getByRole('img', { name: 'Ageniza' })).toBeTruthy();
  });

  it.each([
    ['color', '/brand/simbolo-colorido.svg'],
    ['ink', '/brand/simbolo-ink.svg'],
    ['white', '/brand/simbolo-branco.svg']
  ] as const)('serves the %s production file', (variant, src) => {
    const { container } = render(<BrandSymbol variant={variant} />);

    expect(container.querySelector('img')!.getAttribute('src')).toBe(src);
  });

  it('is a square of the given size, ink by default', () => {
    const { container } = render(<BrandSymbol size={24} />);
    const image = container.querySelector('img')!;

    expect(image.getAttribute('src')).toBe('/brand/simbolo-ink.svg');
    expect(image.getAttribute('width')).toBe('24');
    expect(image.getAttribute('height')).toBe('24');
  });
});
