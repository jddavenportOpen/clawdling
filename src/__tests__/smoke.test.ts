// Smoke test — verifies vitest + jsdom + RTL setup works at all.
// If this fails, the whole suite is broken and nothing below it can run.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

describe('vitest infrastructure', () => {
  it('runs a passing assertion', () => {
    expect(1 + 1).toBe(2);
  });

  it('renders React into jsdom', () => {
    render(React.createElement('div', { 'data-testid': 'hi' }, 'hello'));
    expect(screen.getByTestId('hi')).toHaveTextContent('hello');
  });
});
