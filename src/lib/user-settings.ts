// ═══════════════════════════════════════════════════════════════════════════
// user-settings.ts — per-user BYOK key, model/effort prefs, budget + usage.
// SERVER ONLY (imports crypto + the Supabase server client). See docs/SPEC-BYOK.md.
// ═══════════════════════════════════════════════════════════════════════════

import { getServerClient } from '@/lib/supabase';
import { encryptSecret, decryptSecret, maskKey } from '@/lib/crypto-key';

/** BYOK is active only in hosted multi-user mode. Self-host single-user uses the
 *  env ANTHROPIC_API_KEY and skips onboarding/keys/budget entirely. */
export function byokEnabled(): boolean {
  return process.env.ADJUTANT_BYOK === '1';
}

const DEFAULT_BUDGET_USD = Number(process.env.ADJUTANT_DEFAULT_BUDGET_USD) || 20;

// Rough per-model $/1M (input, output). Estimation only, for the budget gate.
const PRICING: Record<string, [number, number]> = {
  'claude-sonnet-4-6': [3, 15],
  'claude-opus-4-8': [5, 25],
  'claude-haiku-4-5': [1, 5],
};
function estCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const [pin, pout] = PRICING[model] || PRICING['claude-sonnet-4-6'];
  return (tokensIn / 1e6) * pin + (tokensOut / 1e6) * pout;
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface UserSettingsView {
  byok: boolean;          // true = user supplies their own key; false = runs on our key
  hasKey: boolean;
  keyPreview: string | null;
  model: string | null;
  effort: string | null;
  budgetUsd: number | null;
  periodCostUsd: number;
}

type Row = {
  key_ciphertext?: string | null; key_preview?: string | null;
  model?: string | null; effort?: string | null; budget_usd?: number | null;
};

export async function getUserSettings(userId: string): Promise<UserSettingsView> {
  const { data } = await getServerClient()
    .from('user_settings').select('*').eq('user_id', userId).maybeSingle();
  const row = (data as Row) || {};
  const { costUsd } = await getPeriodUsage(userId);
  return {
    byok: byokEnabled(),
    hasKey: !!row.key_ciphertext,
    keyPreview: row.key_preview ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    budgetUsd: row.budget_usd ?? DEFAULT_BUDGET_USD,
    periodCostUsd: costUsd,
  };
}

/** Decrypt and return the user's plaintext key (server-only call path). */
export async function getUserApiKey(userId: string): Promise<string | null> {
  const { data } = await getServerClient()
    .from('user_settings').select('key_ciphertext').eq('user_id', userId).maybeSingle();
  const ct = (data as Row)?.key_ciphertext;
  if (!ct) return null;
  try { return decryptSecret(ct); } catch { return null; }
}

export async function setUserApiKey(userId: string, apiKey: string): Promise<string> {
  const preview = maskKey(apiKey);
  await getServerClient().from('user_settings').upsert(
    { user_id: userId, key_ciphertext: encryptSecret(apiKey), key_preview: preview, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  return preview;
}

export async function clearUserApiKey(userId: string): Promise<void> {
  await getServerClient().from('user_settings')
    .update({ key_ciphertext: null, key_preview: null }).eq('user_id', userId);
}

export async function updateUserSettings(
  userId: string, patch: { model?: string | null; effort?: string | null; budgetUsd?: number | null }
): Promise<void> {
  const row: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
  if (patch.model !== undefined) row.model = patch.model;
  if (patch.effort !== undefined) row.effort = patch.effort;
  if (patch.budgetUsd !== undefined) row.budget_usd = patch.budgetUsd;
  await getServerClient().from('user_settings').upsert(row, { onConflict: 'user_id' });
}

export async function getPeriodUsage(userId: string): Promise<{ costUsd: number }> {
  const { data } = await getServerClient()
    .from('user_usage').select('est_cost_usd')
    .eq('user_id', userId).eq('period', currentPeriod()).maybeSingle();
  return { costUsd: Number((data as { est_cost_usd?: number } | null)?.est_cost_usd ?? 0) };
}

export async function isOverBudget(userId: string, budgetUsd: number | null): Promise<boolean> {
  const cap = budgetUsd ?? DEFAULT_BUDGET_USD;
  if (cap == null) return false;
  const { costUsd } = await getPeriodUsage(userId);
  return costUsd >= cap;
}

/** Best-effort meter after a turn. Never throws to the caller. */
export async function recordUsage(
  userId: string, model: string, tokensIn: number, tokensOut: number
): Promise<void> {
  try {
    const p = currentPeriod();
    const client = getServerClient();
    const { data } = await client.from('user_usage').select('*')
      .eq('user_id', userId).eq('period', p).maybeSingle();
    const cur = (data as { tokens_in?: number; tokens_out?: number; est_cost_usd?: number } | null) || {};
    await client.from('user_usage').upsert(
      {
        user_id: userId, period: p,
        tokens_in: Number(cur.tokens_in ?? 0) + tokensIn,
        tokens_out: Number(cur.tokens_out ?? 0) + tokensOut,
        est_cost_usd: Number(cur.est_cost_usd ?? 0) + estCostUsd(model, tokensIn, tokensOut),
      },
      { onConflict: 'user_id,period' }
    );
  } catch {
    /* metering must never block a reply */
  }
}
