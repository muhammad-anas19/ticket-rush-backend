import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M1 — users and refresh_tokens.
 *
 * Generated with `migration:generate` (which introspects the LIVE database and diffs it against
 * the entity definitions — not against a previous migration), then reviewed and edited by hand.
 * The review found one real problem; see the extension note below. Generated migrations get read
 * before they get run.
 */
export class CreateUsersAndRefreshTokens1786949624880 implements MigrationInterface {
  name = 'CreateUsersAndRefreshTokens1786949624880';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * ADDED BY HAND — the generated migration omitted this and would have failed on a fresh
     * database.
     *
     * TypeORM's `@PrimaryGeneratedColumn('uuid')` emits `uuid_generate_v4()`, which lives in the
     * `uuid-ossp` extension and is NOT installed by default. It happened to work here only
     * because pgAdmin or a previous tool had already enabled it on this server — which is
     * exactly the class of bug that "works on my machine" describes, and exactly why the M2
     * checkpoint insists on running the whole migration set against an empty database.
     *
     * Worth noting what this costs: `CREATE EXTENSION` requires superuser. We have it only
     * because TR-DEC-015 chose to connect as `postgres`. With the least-privilege role that was
     * considered and dropped, this line would fail outright — a concrete instance of that
     * tradeoff rather than an abstract one.
     *
     * The alternative, avoiding the extension entirely: Postgres 13+ ships `gen_random_uuid()`
     * in core. Not used here because TypeORM would then see the column default as drifted from
     * what it expects and try to "fix" it in every future generated migration.
     */
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('organiser', 'attendee')`,
    );

    await queryRunner.query(
      `CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying(255) NOT NULL,
        "password_hash" character varying(255) NOT NULL,
        "role" "public"."users_role_enum" NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
      )`,
    );

    // The constraint that actually prevents duplicate accounts. A service-level "SELECT then
    // INSERT if absent" cannot: two concurrent registrations both read "available", both insert.
    // Only the database closes that window atomically. Same insight M3 is built on.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email")`,
    );

    await queryRunner.query(
      `CREATE TABLE "refresh_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "token_hash" character varying(64) NOT NULL,
        "family_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id")
      )`,
    );

    // Every refresh looks a token up by hash — the hottest query in the auth path.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_a7838d2ba25be1342091b6695f" ON "refresh_tokens" ("token_hash")`,
    );
    // Revoking a family updates every row sharing this id. Without the index that is a
    // sequential scan of every token ever issued, on the reuse-detection path.
    await queryRunner.query(
      `CREATE INDEX "IDX_d5e27da0cd39bc3bb2811fc8ba" ON "refresh_tokens" ("family_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3ddc983c5f7bcf132fd8732c3f" ON "refresh_tokens" ("user_id")`,
    );

    // ON DELETE CASCADE: deleting a user must not leave live sessions pointing at nothing.
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"
       FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  /**
   * Note the ORDER, which the generator got right and is worth understanding rather than
   * trusting: the foreign key is dropped before the table it points at, and the enum TYPE is
   * dropped only after the table that uses it is gone. Reverse either and the rollback fails
   * with a dependency error — at which point you have a half-reverted schema.
   *
   * The extension is deliberately NOT dropped. Other things on this server may depend on it,
   * and a migration should not remove a shared resource it merely ensured was present.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_3ddc983c5f7bcf132fd8732c3f"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_d5e27da0cd39bc3bb2811fc8ba"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_a7838d2ba25be1342091b6695f"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
  }
}
