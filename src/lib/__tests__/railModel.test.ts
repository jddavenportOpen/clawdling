// ═══════════════════════════════════════════════════════════════════════════
// railModel.test.ts — W6 persistent-domain-chats rail contract.
//
// JD's locked model (2026-05-31): the rail shows exactly the 8 FIXED domain
// chats (always, persistent) + only ad-hoc CEO + project agents in a Spawned
// section. Everything else is ARCHIVED (hidden, recoverable). The ONLY
// spawnable classes are CEO + project — domains are the fixed 8, not spawnable.
//
// These tests are the regression guard: they FAIL on the old model (where the
// rail rendered Pinned/Spaces/Project/Other and the picker offered Domains +
// Specialists + Launch-all) and PASS on the new one.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  classifyThread,
  buildDomainEntries,
  partitionThreads,
  domainOfCwd,
  type RailThread,
  type RailThreadMeta,
  type BrainRow,
} from '../railModel';
import { DOMAINS } from '@/config/domains';

const DOMAIN_CWD = '/state/domains/work';
const ADHOC_CWD = '/state/root';
const PROJECT_CWD = '/opt/adjutant/data/projects/demo';

function thread(p: Partial<RailThread>): RailThread {
  return {
    id: p.id ?? 't1',
    title: p.title ?? 'T',
    kind: p.kind ?? 'project-session',
    project_slug: p.project_slug ?? null,
  };
}
function meta(p: Partial<RailThreadMeta>): RailThreadMeta {
  return { cwd: p.cwd ?? null, session_id: p.session_id ?? null };
}

describe('domainOfCwd', () => {
  it('extracts a domain id from a domain cwd', () => {
    expect(domainOfCwd(DOMAIN_CWD)).toBe('work');
  });
  it('returns null for an ad-hoc / project cwd', () => {
    expect(domainOfCwd(ADHOC_CWD)).toBeNull();
    expect(domainOfCwd(PROJECT_CWD)).toBeNull();
  });
  it('returns null for an unknown domain dir', () => {
    expect(domainOfCwd('/state/domains/not-a-domain')).toBeNull();
  });
});

describe('classifyThread — the 3 visible classes + archive', () => {
  it('a domain-scoped session is class=domain (folded into the fixed entry)', () => {
    expect(
      classifyThread(thread({ kind: 'project-session' }), meta({ cwd: DOMAIN_CWD, session_id: 's1' }))
    ).toBe('domain');
  });

  it('a thread with a project_slug is class=project', () => {
    expect(
      classifyThread(thread({ project_slug: 'cockpit-v4' }), meta({ cwd: PROJECT_CWD, session_id: 's1' }))
    ).toBe('project');
  });

  it('a project-session CLI thread with a session is class=project', () => {
    expect(
      classifyThread(thread({ kind: 'project-session' }), meta({ cwd: PROJECT_CWD, session_id: 's1' }))
    ).toBe('project');
  });

  it('an ad-hoc cockpit session (no domain, no project) is class=ceo', () => {
    expect(
      classifyThread(thread({ kind: 'ad-hoc' }), meta({ cwd: ADHOC_CWD, session_id: 's1' }))
    ).toBe('ceo');
  });

  it('a legacy specialist agent chat with no session is class=archived', () => {
    expect(
      classifyThread(thread({ kind: 'agent' }), meta({ cwd: null, session_id: null }))
    ).toBe('archived');
  });

  it('an old ad-hoc message thread with no session is class=archived', () => {
    expect(
      classifyThread(thread({ kind: 'ad-hoc' }), meta({ cwd: null, session_id: null }))
    ).toBe('archived');
  });

  it('a never-spawned project-session is class=archived (no session_id)', () => {
    expect(
      classifyThread(thread({ kind: 'project-session' }), meta({ cwd: null, session_id: null }))
    ).toBe('archived');
  });
});

describe('buildDomainEntries — FIXED domains, always present', () => {
  it('renders exactly DOMAINS.length entries even with NO brains running', () => {
    const entries = buildDomainEntries(undefined);
    expect(entries).toHaveLength(DOMAINS.length);
    // all cold when nothing is live
    expect(entries.every((e) => !e.live && e.sid === null)).toBe(true);
  });

  it('entries are in DOMAINS order and cover all ids', () => {
    const entries = buildDomainEntries([]);
    expect(entries.map((e) => e.def.id)).toEqual(DOMAINS.map((d) => d.id));
  });

  it('marks a domain live when a live+persistent brain matches its id', () => {
    const brains: BrainRow[] = [
      { id: 'sid-work', thread_id: 'thr-h', live: true, persistent: true, domain: 'work' },
    ];
    const entries = buildDomainEntries(brains);
    const work = entries.find((e) => e.def.id === 'work')!;
    expect(work.live).toBe(true);
    expect(work.sid).toBe('sid-work');
    expect(work.threadId).toBe('thr-h');
    // others stay cold
    expect(entries.filter((e) => e.live)).toHaveLength(1);
  });

  it('does NOT mark live for a non-persistent (disposable) domain-cwd session', () => {
    const brains: BrainRow[] = [
      { id: 'sid', thread_id: 'thr', live: true, persistent: false, domain: 'work' },
    ];
    expect(buildDomainEntries(brains).every((e) => !e.live)).toBe(true);
  });

  it('does NOT mark live for a DEAD persistent row', () => {
    const brains: BrainRow[] = [
      { id: 'sid', thread_id: 'thr', live: false, persistent: true, domain: 'work' },
    ];
    expect(buildDomainEntries(brains).every((e) => !e.live)).toBe(true);
  });
});

describe('partitionThreads — Spawned = ONLY CEO + project; rest hidden', () => {
  const threads: RailThread[] = [
    thread({ id: 'dom', kind: 'project-session' }), // domain → folded
    thread({ id: 'proj', kind: 'project-session', project_slug: 'cockpit-v4' }), // project
    thread({ id: 'ceo', kind: 'ad-hoc' }), // ceo
    thread({ id: 'legacy-agent', kind: 'agent' }), // archived
    thread({ id: 'old-adhoc', kind: 'ad-hoc' }), // archived (no session)
  ];
  const metaMap: Record<string, RailThreadMeta> = {
    dom: meta({ cwd: DOMAIN_CWD, session_id: 's-dom' }),
    proj: meta({ cwd: PROJECT_CWD, session_id: 's-proj' }),
    ceo: meta({ cwd: ADHOC_CWD, session_id: 's-ceo' }),
    'legacy-agent': meta({ cwd: null, session_id: null }),
    'old-adhoc': meta({ cwd: null, session_id: null }),
  };

  it('puts ONLY ceo + project threads in Spawned', () => {
    const { spawned } = partitionThreads(threads, (id) => metaMap[id]);
    expect(spawned.map((t) => t.id).sort()).toEqual(['ceo', 'proj']);
  });

  it('does NOT surface the domain-scoped thread as a Spawned row (folded into fixed entry)', () => {
    const { spawned } = partitionThreads(threads, (id) => metaMap[id]);
    expect(spawned.find((t) => t.id === 'dom')).toBeUndefined();
  });

  it('hides (archives) legacy specialist + old ad-hoc threads', () => {
    const { spawned, archivedCount } = partitionThreads(threads, (id) => metaMap[id]);
    expect(spawned.find((t) => t.id === 'legacy-agent')).toBeUndefined();
    expect(spawned.find((t) => t.id === 'old-adhoc')).toBeUndefined();
    expect(archivedCount).toBe(2);
  });
});
