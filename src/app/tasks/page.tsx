// ═══════════════════════════════════════════════════════════════════════════
// /tasks — collapsed into /backlog (DONNA Phase 0).
//
// Open loops, tasks, and the EA backlog were merged into ONE unified backlog on
// the v6 spine (`spine.backlog_items`). This route is kept as a permanent
// redirect so old links / bookmarks / the command palette still resolve, but
// there is exactly ONE canonical surface now: /backlog.
// ═══════════════════════════════════════════════════════════════════════════

import { redirect } from 'next/navigation';

export default function TasksRedirect() {
  redirect('/backlog');
}
