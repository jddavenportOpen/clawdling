// ═══════════════════════════════════════════════════════════════════════════
// /agents index — render + auth-gate contract.
//
// Only /agents/[id] existed, so MobileTabBar's "Agents" tab (and the sidebar /
// command palette entries) 404'd. The first test is the regression guard: the
// index must render the roster and link each tile at its detail route.
//
// The page is an async Server Component; RTL renders the JSX it resolves to.
// next/link is stubbed to a bare anchor because there is no App Router context
// under jsdom, and next/navigation is stubbed so the redirect is assertable.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import agentRegistry from '@/config/agents.json';

const mockAuth = vi.fn();
vi.mock('@/lib/auth-timeout', () => ({
  authWithTimeout: () => mockAuth(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

import AgentsIndexPage from '../page';

type AgentConfig = { id: string; name: string; description: string };
const AGENTS = agentRegistry as AgentConfig[];

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@example.test' } });
});

describe('/agents renders an index (the route used to 404)', () => {
  it('renders the Agents heading', async () => {
    render(await AgentsIndexPage());
    expect(screen.getByRole('heading', { name: 'Agents', level: 1 })).toBeInTheDocument();
  });

  it('lists EVERY agent in src/config/agents.json', async () => {
    render(await AgentsIndexPage());

    expect(AGENTS.length).toBeGreaterThan(0);
    for (const a of AGENTS) {
      expect(screen.getByTestId(`agent-card-${a.id}`)).toBeInTheDocument();
      expect(screen.getByText(a.name)).toBeInTheDocument();
    }
    expect(screen.getByTestId('agents-list').children).toHaveLength(AGENTS.length);
  });

  it('links each tile at the agent\'s existing detail route', async () => {
    render(await AgentsIndexPage());
    for (const a of AGENTS) {
      expect(screen.getByTestId(`agent-card-${a.id}`)).toHaveAttribute(
        'href',
        `/agents/${a.id}`
      );
    }
  });

  it('shows each agent\'s description so the roster is choosable, not just a list of names', async () => {
    render(await AgentsIndexPage());
    for (const a of AGENTS) {
      expect(screen.getByText(a.description)).toBeInTheDocument();
    }
  });
});

describe('/agents auth gate', () => {
  it('redirects an unauthenticated visitor to login with a callbackUrl', async () => {
    mockAuth.mockResolvedValue(null);
    // Matches the [id] sibling: bounce to login rather than render a roster
    // whose every link would bounce anyway.
    await expect(AgentsIndexPage()).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(AgentsIndexPage()).rejects.toMatchObject({
      url: '/login?callbackUrl=/agents',
    });
  });
});
