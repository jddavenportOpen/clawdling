// ═══════════════════════════════════════════════════════════════════════════
// Per-agent runtime config.
//
// Maps agents.json entries → the runtime levers a turn needs:
//   • cwd              — working dir for the turn (defaults to the state root)
//   • system_prompt    — persona text appended to the base system prompt
//   • model            — optional model override
//
// The starter roster is intentionally small (assistant / researcher / tasks).
// A future release resolves these from the active profile; today they are the
// compiled starter agents.
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentRuntime {
  cwd: string;
  systemPromptSuffix: string; // appended to base system prompt
  settingsPath?: string;
  model?: 'opus' | 'sonnet' | 'haiku';
  /**
   * Optional one-liner appended ONLY when this agent is talking inside a
   * project-scoped chat (kind='agent' && project_slug != null).
   */
  projectIntro?: string;
}

/** The working directory for engine turns — the local state root, or cwd. */
const STATE_ROOT = (process.env.ADJUTANT_STATE_ROOT || process.cwd()).replace(/\/+$/, '');

/**
 * Per-agent overrides. Key = agents.json `id` field. Add an entry here when a
 * new agent needs a bespoke persona or model; missing entries fall back to
 * `defaultRuntime()`.
 */
const AGENT_MAP: Record<string, AgentRuntime> = {
  assistant: {
    cwd: STATE_ROOT,
    systemPromptSuffix:
      'You are a general-purpose assistant. You can manage the user\'s task list, ' +
      'remember and recall durable facts they share, and search the web. Keep replies concise.',
    projectIntro:
      'When the user asks about this project, give a tight assessment and one recommended next move.',
  },
  researcher: {
    cwd: STATE_ROOT,
    systemPromptSuffix:
      'You are a research agent. Gather sources from the web and cite them inline. ' +
      'Summarize findings clearly; note when evidence is thin.',
    projectIntro:
      'Find sources that validate or refute this project\'s assumptions. Cite inline.',
  },
  tasks: {
    cwd: STATE_ROOT,
    systemPromptSuffix:
      'You are a task manager. Keep the user\'s task list tidy: create, list, and ' +
      'complete tasks. Confirm the exact task text before acting.',
  },
};

function defaultRuntime(): AgentRuntime {
  return {
    cwd: STATE_ROOT,
    systemPromptSuffix:
      'You can act on the user\'s behalf with your tools. Keep replies concise.',
  };
}

/**
 * Look up an agent's runtime. Falls back to a generic runtime if the ID is
 * unknown. Never throws.
 */
export function getAgentRuntime(agentId: string | null | undefined): AgentRuntime {
  if (!agentId) return defaultRuntime();
  return AGENT_MAP[agentId] || defaultRuntime();
}

/**
 * Resolve the cwd + system prompt for any thread kind ('agent' | 'project-session' | 'ad-hoc').
 *
 * `projectSlug` is optional and only meaningful for kind='agent'. When set,
 * the agent's `projectIntro` (if defined) is appended to the systemPrompt.
 */
export function resolveThreadRuntime(
  kind: 'agent' | 'project-session' | 'ad-hoc',
  refId: string | null,
  baseSystemPrompt: string,
  projectSlug?: string | null
): { cwd: string; systemPrompt: string } {
  if (kind === 'agent') {
    const r = getAgentRuntime(refId);
    let systemPrompt = `${baseSystemPrompt}\n\n${r.systemPromptSuffix}`;
    if (projectSlug && r.projectIntro) {
      systemPrompt += `\n\n[Project engagement] ${r.projectIntro}`;
    }
    return { cwd: r.cwd, systemPrompt };
  }
  if (kind === 'project-session' && refId) {
    return {
      cwd: `${STATE_ROOT}/projects/${refId}`,
      systemPrompt: `${baseSystemPrompt}\n\nYou are bound to project "${refId}". Its project docs (if present) are authoritative.`,
    };
  }
  // ad-hoc: the product chat surface. Tenant-neutral — it serves many different
  // users, so it must not assume the user's identity and describes the real
  // product tools instead.
  return {
    cwd: STATE_ROOT,
    systemPrompt:
      `${baseSystemPrompt}\n\nYou can ACT on the user's behalf with your tools: ` +
      `manage their task list (create, list, complete tasks), remember and recall ` +
      `durable facts and preferences they share, and search the live web. Use a tool ` +
      `whenever it fits; never claim you saved or did something unless you actually ` +
      `called the tool. You serve many different people: never assume or invent the ` +
      `user's name or identity, and only use a name they give you in this conversation.`,
  };
}
