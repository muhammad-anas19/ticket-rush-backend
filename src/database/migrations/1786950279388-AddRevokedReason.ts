import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRevokedReason1786950279388 implements MigrationInterface {
  name = 'AddRevokedReason1786950279388';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."refresh_tokens_revoked_reason_enum" AS ENUM('rotated', 'reuse_detected', 'logout')`,
    );

    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD "revoked_reason" "public"."refresh_tokens_revoked_reason_enum"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP COLUMN "revoked_reason"`);
    await queryRunner.query(`DROP TYPE "public"."refresh_tokens_revoked_reason_enum"`);
  }
}
