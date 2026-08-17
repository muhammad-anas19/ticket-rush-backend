import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `refresh_tokens.revoked_reason`.
 *
 * **This migration fixes a security bug, not a modelling preference.**
 *
 * `revoked_at` alone carried two different meanings — "spent by a normal rotation" and "killed
 * because we suspect theft" — and the TR-DEC-017 grace window could not distinguish them. So
 * reuse detection would revoke the family, and then any token in that family presented within
 * the next 30 seconds hit the grace branch and was issued a fresh pair. **A revoked session
 * could resurrect itself.** Logout had the identical hole.
 *
 * Found by testing the failure path rather than the happy path: the reuse attempt correctly
 * returned 401, and then the *current* token still worked.
 */
export class AddRevokedReason1786950279388 implements MigrationInterface {
  name = 'AddRevokedReason1786950279388';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."refresh_tokens_revoked_reason_enum" AS ENUM('rotated', 'reuse_detected', 'logout')`,
    );

    /**
     * NULLABLE, with no default — which is why this is instant even on a large table.
     *
     * Adding a nullable column is a catalogue change: Postgres records the new column and
     * rewrites nothing. `ADD COLUMN ... NOT NULL` on a populated table is the expensive
     * sibling — it fails outright without a default, and pre-Postgres 11 rewrote the entire
     * table under an ACCESS EXCLUSIVE lock, which is the classic migration outage.
     *
     * **Deliberately not backfilled.** Rows already carrying `revoked_at` keep
     * `revoked_reason = NULL`, and the new logic treats "revoked with an unknown reason" as
     * revoked-for-cause — permanently dead, not grace-eligible. That is fail-closed, which is
     * the correct direction for ambiguous data. Backfilling them to `'rotated'` would be
     * *less* safe: it would make every historically revoked token eligible for the grace window,
     * which is the exact bug this migration exists to close.
     */
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD "revoked_reason" "public"."refresh_tokens_revoked_reason_enum"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Column before type: the type cannot be dropped while a column still depends on it.
    await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP COLUMN "revoked_reason"`);
    await queryRunner.query(`DROP TYPE "public"."refresh_tokens_revoked_reason_enum"`);
  }
}
