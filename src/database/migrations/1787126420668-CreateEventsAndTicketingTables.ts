import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * M2 — the five domain tables: events, ticket_holds, orders, tickets, processed_events.
 *
 * Generated with `migration:generate`, then REVIEWED. Reading a generated migration before running it
 * is a standing convention here — the M1 one was missing a `CREATE EXTENSION` and would have failed on
 * a fresh database.
 *
 * What was checked this time:
 *
 *  - **`uuid_generate_v4()` is available.** Enabled by the M1 migration, so no extension line needed.
 *  - **Index column order matches real queries.** `idx_events_organiser_starts_at` exists as a separate
 *    index from `idx_events_starts_at` because the leftmost-prefix rule means one cannot serve the
 *    other: an index on `(starts_at)` is useless for filtering by `organiser_id`.
 *  - **Two PARTIAL unique indexes** on `orders` — `WHERE hold_id IS NOT NULL` and
 *    `WHERE stripe_session_id IS NOT NULL`. A plain unique index would allow only ONE row with a NULL
 *    in those columns; partial indexes let many orders have no hold or no session yet while still
 *    guaranteeing that a given hold or session maps to at most one order. That guarantee is what stops
 *    a double charge.
 *  - **`processed_events` has no surrogate id.** The Stripe event id IS the primary key, so the database
 *    itself enforces exactly-once processing — a unique violation is the mechanism, not an application
 *    `if` that two concurrent webhooks could both pass.
 *  - **FK delete behaviour is deliberate per relation**, not uniform: CASCADE where the child is
 *    meaningless without the parent (holds), RESTRICT where the child is a financial record that must
 *    outlive it (orders, tickets), SET NULL where history should survive (orders.hold_id).
 *  - **`down()` ordering** — FKs before tables, enum types after the tables using them. Reverse either
 *    and the rollback fails partway, leaving a half-reverted schema.
 *
 * Note every column here is created on EMPTY tables, so `NOT NULL` is free. Adding a NOT NULL column to
 * a populated table is the expensive case: it fails outright without a default, and pre-Postgres 11
 * rewrote the whole table under an ACCESS EXCLUSIVE lock.
 */

export class CreateEventsAndTicketingTables1787126420668 implements MigrationInterface {
    name = 'CreateEventsAndTicketingTables1787126420668'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "organiser_id" uuid NOT NULL, "title" character varying(200) NOT NULL, "description" text, "venue" character varying(200) NOT NULL, "starts_at" TIMESTAMP WITH TIME ZONE NOT NULL, "price_cents" integer NOT NULL, "total_tickets" integer NOT NULL, "tickets_committed" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_40731c7151fe4be3116e45ddf73" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cb951fb6dfdc6eba1b67d8f06c" ON "events" ("organiser_id") `);
        await queryRunner.query(`CREATE INDEX "idx_events_organiser_starts_at" ON "events" ("organiser_id", "starts_at") `);
        await queryRunner.query(`CREATE INDEX "idx_events_starts_at" ON "events" ("starts_at") `);
        await queryRunner.query(`CREATE TYPE "public"."ticket_holds_status_enum" AS ENUM('active', 'converted', 'expired')`);
        await queryRunner.query(`CREATE TABLE "ticket_holds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "event_id" uuid NOT NULL, "user_id" uuid NOT NULL, "quantity" integer NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "status" "public"."ticket_holds_status_enum" NOT NULL DEFAULT 'active', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_efdd1b02855c77637222da92395" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_ticket_holds_expires_at" ON "ticket_holds" ("expires_at") `);
        await queryRunner.query(`CREATE INDEX "idx_ticket_holds_user" ON "ticket_holds" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "idx_ticket_holds_event_status" ON "ticket_holds" ("event_id", "status") `);
        await queryRunner.query(`CREATE TYPE "public"."orders_status_enum" AS ENUM('pending', 'paid', 'failed', 'refunded')`);
        await queryRunner.query(`CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "event_id" uuid NOT NULL, "user_id" uuid NOT NULL, "hold_id" uuid, "quantity" integer NOT NULL, "amount_cents" integer NOT NULL, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'pending', "stripe_session_id" character varying(255), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_orders_hold_unique" ON "orders" ("hold_id") WHERE hold_id IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_orders_stripe_session_unique" ON "orders" ("stripe_session_id") WHERE stripe_session_id IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_orders_event" ON "orders" ("event_id") `);
        await queryRunner.query(`CREATE INDEX "idx_orders_user_created" ON "orders" ("user_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "tickets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "event_id" uuid NOT NULL, "user_id" uuid NOT NULL, "code" character varying(32) NOT NULL, "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_343bc942ae261cf7a1377f48fd0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c6e20a830c0f8b571abd331b77" ON "tickets" ("code") `);
        await queryRunner.query(`CREATE INDEX "idx_tickets_order" ON "tickets" ("order_id") `);
        await queryRunner.query(`CREATE INDEX "idx_tickets_user" ON "tickets" ("user_id") `);
        await queryRunner.query(`CREATE TABLE "processed_events" ("stripe_event_id" character varying(255) NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_2ac85b74c18040889ed32d34cd6" PRIMARY KEY ("stripe_event_id"))`);
        await queryRunner.query(`ALTER TABLE "events" ADD CONSTRAINT "FK_cb951fb6dfdc6eba1b67d8f06cb" FOREIGN KEY ("organiser_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ticket_holds" ADD CONSTRAINT "FK_f7c68cb1bf846d09a94f2250807" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ticket_holds" ADD CONSTRAINT "FK_6fd2a46772a4ccb6c516634d5f0" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_642ca308ac51fea8327e593b8ab" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_a922b820eeef29ac1c6800e826a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_e40c132bed155451184edcdf385" FOREIGN KEY ("hold_id") REFERENCES "ticket_holds"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tickets" ADD CONSTRAINT "FK_bd5636236f799b19f132abf8d70" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tickets" ADD CONSTRAINT "FK_bd5387c23fb40ae7e3526ad75ea" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tickets" ADD CONSTRAINT "FK_2e445270177206a97921e461710" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tickets" DROP CONSTRAINT "FK_2e445270177206a97921e461710"`);
        await queryRunner.query(`ALTER TABLE "tickets" DROP CONSTRAINT "FK_bd5387c23fb40ae7e3526ad75ea"`);
        await queryRunner.query(`ALTER TABLE "tickets" DROP CONSTRAINT "FK_bd5636236f799b19f132abf8d70"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_e40c132bed155451184edcdf385"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_a922b820eeef29ac1c6800e826a"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_642ca308ac51fea8327e593b8ab"`);
        await queryRunner.query(`ALTER TABLE "ticket_holds" DROP CONSTRAINT "FK_6fd2a46772a4ccb6c516634d5f0"`);
        await queryRunner.query(`ALTER TABLE "ticket_holds" DROP CONSTRAINT "FK_f7c68cb1bf846d09a94f2250807"`);
        await queryRunner.query(`ALTER TABLE "events" DROP CONSTRAINT "FK_cb951fb6dfdc6eba1b67d8f06cb"`);
        await queryRunner.query(`DROP TABLE "processed_events"`);
        await queryRunner.query(`DROP INDEX "public"."idx_tickets_user"`);
        await queryRunner.query(`DROP INDEX "public"."idx_tickets_order"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c6e20a830c0f8b571abd331b77"`);
        await queryRunner.query(`DROP TABLE "tickets"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_user_created"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_event"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_stripe_session_unique"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_hold_unique"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP TYPE "public"."orders_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_ticket_holds_event_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_ticket_holds_user"`);
        await queryRunner.query(`DROP INDEX "public"."idx_ticket_holds_expires_at"`);
        await queryRunner.query(`DROP TABLE "ticket_holds"`);
        await queryRunner.query(`DROP TYPE "public"."ticket_holds_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_events_starts_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_events_organiser_starts_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cb951fb6dfdc6eba1b67d8f06c"`);
        await queryRunner.query(`DROP TABLE "events"`);
    }

}
