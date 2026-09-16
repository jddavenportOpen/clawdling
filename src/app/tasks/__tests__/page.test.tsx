// ═══════════════════════════════════════════════════════════════════════════
// /tasks page — render + complete contract.
//
// This route shipped as `redirect('/backlog')` and /backlog does not exist in
// this repo, so Tasks 404'd from the mobile tab bar, the sidebar and the
// command palette. The first test below is the regression guard for exactly
// that: the page must RENDER a list, not bounce.
//
// SWR is mocked (the repo's existing pattern, see ThreadSidebarRail.test.tsx)
// so the render is deterministic; the PATCH path drives the real fetch call
// through a spy, so the wire shape the route expects stays pinned.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

interface Task {
  id: string;
  title: string;
  status: string;
  due: string | null;
  created_at: string | null;
  completed_at: string | null;
}

interface SwrState {
  data?: { tasks: Task[]; stats: { total: number; open: number; done: number } };
  error?: unknown;
  isLoading: boolean;
  mutate: () => Promise<unknown>;
}

// Mutable so each test can drive the hook's return value.
let swrState: SwrState = { isLoading: true, mutate: vi.fn() };
vi.mock('swr', () => ({
  default: () => swrState,
}));

import TasksPage from '../page';

function task(p: Partial<Task>): Task {
  return {
    id: p.id ?? 't1',
    title: p.title ?? 'a task',
    status: p.status ?? 'open',
    due: p.due ?? null,
    created_at: p.created_at ?? '2026-09-16T00:00:00Z',
    completed_at: p.completed_at ?? null,
  };
}

function loaded(tasks: Task[]): SwrState {
  const open = tasks.filter((t) => t.status !== 'done').length;
  return {
    data: { tasks, stats: { total: tasks.length, open, done: tasks.length - open } },
    isLoading: false,
    mutate: vi.fn().mockResolvedValue(undefined),
  };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  swrState = { isLoading: true, mutate: vi.fn() };
});

describe('/tasks renders a real page (it used to redirect to a route that does not exist)', () => {
  it('renders the Tasks heading instead of bouncing', () => {
    swrState = loaded([]);
    render(<TasksPage />);
    expect(screen.getByRole('heading', { name: 'Tasks', level: 1 })).toBeInTheDocument();
  });

  it('shows a loading state while the list is in flight', () => {
    render(<TasksPage />);
    expect(screen.getByText(/loading tasks/i)).toBeInTheDocument();
  });

  it('lists open and done tasks in their own sections', () => {
    swrState = loaded([
      task({ id: 'a', title: 'ship the route', status: 'open' }),
      task({ id: 'b', title: 'old chore', status: 'done', completed_at: '2026-09-15T00:00:00Z' }),
    ]);
    render(<TasksPage />);

    const openList = screen.getByTestId('tasks-open-list');
    const doneList = screen.getByTestId('tasks-done-list');
    expect(openList).toHaveTextContent('ship the route');
    expect(openList).not.toHaveTextContent('old chore');
    expect(doneList).toHaveTextContent('old chore');
  });

  it('renders a due date when the task carries one', () => {
    swrState = loaded([task({ id: 'a', title: 'renew tags', due: 'friday' })]);
    render(<TasksPage />);
    expect(screen.getByText(/due friday/i)).toBeInTheDocument();
  });

  it('shows an empty state rather than a blank panel', () => {
    swrState = loaded([]);
    render(<TasksPage />);
    expect(screen.getByText(/nothing open/i)).toBeInTheDocument();
    expect(screen.getByText(/no completed tasks yet/i)).toBeInTheDocument();
  });

  it('surfaces the API error message when the list fails to load', () => {
    swrState = {
      error: new Error('Could not read tasks: relation does not exist'),
      isLoading: false,
      mutate: vi.fn(),
    };
    render(<TasksPage />);
    expect(screen.getByTestId('tasks-error')).toHaveTextContent(
      /relation does not exist/
    );
  });
});

describe('/tasks completing a task', () => {
  it('PATCHes { id, status: "done" } and revalidates', async () => {
    swrState = loaded([task({ id: 'task-7', title: 'send the invoice' })]);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okJson({ task: { id: 'task-7', status: 'done' } }));

    render(<TasksPage />);
    fireEvent.click(screen.getByTestId('task-toggle-task-7'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tasks');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'task-7', status: 'done' });

    await waitFor(() => expect(swrState.mutate).toHaveBeenCalled());
  });

  it('reopens a done task (status: "open")', async () => {
    swrState = loaded([
      task({ id: 'task-8', title: 'already handled', status: 'done', completed_at: 'x' }),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okJson({ task: { id: 'task-8', status: 'open' } }));

    render(<TasksPage />);
    fireEvent.click(screen.getByTestId('task-toggle-task-8'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ id: 'task-8', status: 'open' });
  });

  it('labels the control for screen readers by what it will do', () => {
    swrState = loaded([
      task({ id: 'o', title: 'open one', status: 'open' }),
      task({ id: 'd', title: 'done one', status: 'done' }),
    ]);
    render(<TasksPage />);
    expect(screen.getByLabelText('Complete "open one"')).toBeInTheDocument();
    expect(screen.getByLabelText('Reopen "done one"')).toBeInTheDocument();
  });

  it('surfaces a failed write instead of silently dropping it', async () => {
    swrState = loaded([task({ id: 'task-9', title: 'will fail' })]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'No matching task.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    render(<TasksPage />);
    fireEvent.click(screen.getByTestId('task-toggle-task-9'));

    const alert = await screen.findByTestId('tasks-write-error');
    expect(alert).toHaveTextContent('No matching task.');
    expect(swrState.mutate).not.toHaveBeenCalled();
  });
});
