// ═══════════════════════════════════════════════════════════════════════════
// first-run.ts — seed a welcome thread on a brand-new (empty) install.
//
// On the very first visit to /chat with zero threads, we seed one assistant
// message that explains what the engine can do (the 5 acting tools) and how to
// make the install yours (edit the profile). This turns a fresh boot from an
// empty shell into a usable first-run.
//
// Idempotent by construction: it only seeds when the user has NO threads, and
// seeding creates one, so it never fires twice. Best-effort — any failure is
// swallowed so a store hiccup can never block the cockpit from rendering.
// ═══════════════════════════════════════════════════════════════════════════

import { getThreadsForUser, createThread, addMessage } from '@/lib/chat';

const WELCOME_TITLE = 'Welcome to Clawdling';

const WELCOME_BODY = `Welcome to **Clawdling** — your self-hosted AI OS, running on your own machine with your own Anthropic key.

This is a real assistant, not just a chatbox. Beyond chatting (and web search, when enabled), it can **act** through five built-in tools:

- **create_task** — add something to your task list ("remind me to…", "add to my list").
- **list_tasks** — show what's open, done, or all of your tasks.
- **complete_task** — mark a task done.
- **remember** — save a durable fact or preference so it persists across conversations.
- **recall** — search back through what you've told it before.

Try it: say *"remind me to email the team on Friday"*, then *"what's on my list?"*.

**Make it yours.** The cockpit ships three starter domains — Work, Personal, and Notes. To rename them, change their colors, add your own, or rewrite the agent that drives each one, edit the profile:

- \`profiles/starter/domains.yaml\` — the domain list.
- \`profiles/starter/agents/*.md\` — the prompt behind each domain.

Then restart (\`make run\`). See \`profiles/starter/README.md\` for the details.

**A note on cost:** every model call meters against *your* Anthropic key — there's no free or infinite output here. You're in control of your usage and your bill.

Ask me anything to get started.`;

/**
 * If `userId` has no threads yet, seed a single welcome thread. No-op otherwise.
 * Never throws — logs and returns on any error.
 */
export async function ensureWelcomeThread(userId: string, email?: string | null): Promise<void> {
  try {
    const threads = await getThreadsForUser(userId);
    if (threads.length > 0) return; // already onboarded (or has any history)

    const thread = await createThread(userId, 'ad-hoc', null, WELCOME_TITLE, {
      email: email ?? null,
    });
    await addMessage(thread.id, 'assistant', WELCOME_BODY);
  } catch (err) {
    // First-run seeding is best-effort; the cockpit must still render.
    console.warn('[first-run] welcome-thread seed skipped:', err);
  }
}
