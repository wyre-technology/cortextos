/**
 * Pre-migration backfill for migration 015.
 *
 * REQUIRED before deploying migration 015. If 015 runs without this script,
 * its safety check (`legacy_count > 0` → RAISE EXCEPTION) aborts the
 * deploy and rolls back the column drop.
 *
 * What it does:
 *   Selects every active org_invitations row that still has a NULL
 *   token_hash (rows created pre-migration 011, not yet expired or
 *   used up) and hashes their plaintext token in-place. Uses the same
 *   hash function as the runtime InvitationService (imported from
 *   src/org/invitation-token-hash.ts) — drift between the two would
 *   produce a silent miss at user-click time.
 *
 *   Loses nothing: the user's email already had the plaintext.
 *
 * Why a script and not a SQL migration:
 *   The hashing function (sha256-hex) requires either pgcrypto's `digest()`
 *   or app-side compute. pgcrypto is not currently enabled by any other
 *   migration in this codebase; introducing it as a hard dep on the
 *   migration path mixes blast radii. App-side compute keeps migration
 *   015 itself self-contained: just a safety check + DROP COLUMN.
 *
 * Idempotent: re-running is a no-op once all NULL token_hash rows have
 * been backfilled.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run backfill:invitation-tokens [-- --dry-run]
 */
import postgres from 'postgres';
import { hashInvitationToken } from '../src/org/invitation-token-hash.js';

const DRY_RUN = process.argv.includes('--dry-run');

interface PendingRow {
  id: string;
  token: string;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[backfill] DATABASE_URL is required.');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });

  try {
    // Same WHERE predicate as migration 015's safety check. Backfill exactly
    // the rows that would otherwise abort the migration; expired / used-up
    // rows pass through untouched and get dropped with the column.
    const rows = await sql<PendingRow[]>`
      SELECT id, token
      FROM org_invitations
      WHERE token_hash IS NULL
        AND token IS NOT NULL
        AND expires_at > NOW()
        AND (max_uses IS NULL OR use_count < max_uses)
    `;

    if (rows.length === 0) {
      console.log('[backfill] No active invitations need backfilling.');
      return;
    }

    console.log(`[backfill] ${rows.length} active row(s) need token_hash populated.`);

    if (DRY_RUN) {
      console.log('[backfill] --dry-run set; skipping UPDATEs.');
      for (const row of rows) {
        console.log(`  would update id=${row.id} (${row.token.length}-char plaintext)`);
      }
      return;
    }

    let updated = 0;
    for (const row of rows) {
      const tokenHash = hashInvitationToken(row.token);
      // Per-row update so a single bad row doesn't roll back the whole batch.
      // The set is small (active legacy invitations, max ~30 days old).
      const result = await sql`
        UPDATE org_invitations
        SET token_hash = ${tokenHash}
        WHERE id = ${row.id}
          AND token_hash IS NULL
      `;
      if (result.count === 1) {
        updated += 1;
      }
    }

    console.log(`[backfill] updated ${updated} of ${rows.length} row(s).`);

    // Re-verify: any active row still NULL after the update is a bug
    // (concurrent insert with NULL token_hash, which the post-#61 service
    // shouldn't produce). Surface it before the migration's safety check
    // does, so the operator sees this script's name in the failure context.
    const stillNull = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM org_invitations
      WHERE token_hash IS NULL
        AND token IS NOT NULL
        AND expires_at > NOW()
        AND (max_uses IS NULL OR use_count < max_uses)
    `;
    if (stillNull[0].count > 0) {
      console.error(
        `[backfill] post-update verification: ${stillNull[0].count} active row(s) ` +
          'still have NULL token_hash. This is unexpected — investigate before ' +
          'running migration 015. The migration\'s safety check would also abort.',
      );
      process.exit(1);
    }
    console.log('[backfill] verification clean. Migration 015 is safe to run.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
