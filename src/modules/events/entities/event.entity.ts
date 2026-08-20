import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

@Entity('events')
// Composite index for the default listing: upcoming events, soonest first.
//
// Column ORDER is a design decision driven by the actual query, not alphabet or instinct. This serves
// `WHERE starts_at > now() ORDER BY starts_at` and, by the leftmost-prefix rule, anything filtering on
// `starts_at` alone. It does NOT serve a query filtering only on `organiser_id` — that gets its own
// index below, because you can only skip index columns from the RIGHT, never the left.
@Index('idx_events_starts_at', ['startsAt'])
// "My events" for an organiser. Separate index because `organiser_id` is not the leftmost column of the
// one above, so that index is useless for this query.
@Index('idx_events_organiser_starts_at', ['organiserId', 'startsAt'])
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'organiser_id' })
  organiserId: string;

  /**
   * The owner. This FK is what makes the ownership check possible — and ownership is a completely
   * separate axis from role (TR-DEC-003).
   *
   * `@Roles(Organiser)` on `PATCH /events/:id` lets in EVERY organiser, including one editing someone
   * else's event. Conflating the two is exactly how IDOR bugs ship. The role check lives in a guard
   * (it needs only the token); the ownership check lives in the service (it needs this row).
   *
   * RESTRICT, not CASCADE: deleting an organiser must not silently delete events that people hold
   * tickets for. It should fail loudly and force a decision.
   */
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organiser_id' })
  organiser: User;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 200 })
  venue: string;

  /**
   * TIMESTAMPTZ, always.
   *
   * The name is misleading: this does NOT store a timezone. It stores a UTC instant, converting from
   * the client's zone on write and to the reader's zone on read. Both types are 8 bytes — there is no
   * room for a zone.
   *
   * Plain TIMESTAMP would store the digits verbatim, so a Karachi organiser's "20:00" and a London
   * attendee's "20:00" would be the same stored value and two different real instants — and the
   * attendee arrives four hours late with nothing in the database able to explain why.
   */
  @Column({ type: 'timestamptz', name: 'starts_at' })
  startsAt: Date;

  /**
   * Money as an INTEGER in minor units. Never a float.
   *
   * A float cannot represent 0.1 — in binary it is 0.0001100110011… forever, truncated at 53 bits. So
   * `0.1 + 0.2 === 0.30000000000000004`, and `WHERE amount = 19.99` returns nothing because the stored
   * value is 19.989999999999998. Errors accumulate across thousands of rows until the books disagree.
   *
   * NUMERIC(10,2) would also be exact and is a defensible choice. Integer cents wins here because
   * **Stripe's entire API is denominated in minor units**, so this removes a conversion boundary from
   * the money path — the last place you want one.
   *
   * The cost: every read and write site must remember the unit. The frontend converts once, in one
   * place, with a test.
   *
   * (Worth knowing for later: "cents" is not universal. JPY has no minor unit, so ¥500 is 500, not
   * 50000. Any helper hardcoding /100 breaks on a second currency. Single-currency here — knowingly.)
   */
  @Column({ type: 'integer', name: 'price_cents' })
  priceCents: number;

  @Column({ type: 'integer', name: 'total_tickets' })
  totalTickets: number;

  /**
   * THE most important column in this project. Read the name carefully.
   *
   * `tickets_committed`, not `tickets_sold` (TR-DEC-014). A hold is a RESERVATION, not a sale: this
   * counter goes UP when someone holds and DOWN when the hold expires unpaid. Calling that "sold"
   * invites the question "so what happens when a hold expires — tickets get un-sold?" and you have to
   * explain that the column doesn't mean what it says. "Committed" means spoken for, held or paid,
   * which is exactly what the availability check needs.
   *
   * ─── Why this lives in Postgres and not Redis ───────────────────────────────
   *
   * This column is not a display value. It is the thing that DECIDES whether a sale happens, so it
   * must be mutated in the same transaction as the hold row it authorises.
   *
   * Redis cannot participate in a Postgres transaction. Put the counter there and you get one of two
   * failures: DECR succeeds but the hold insert fails, and a ticket vanishes forever with nobody
   * holding it; or the insert commits and the DECR is lost, and you oversell. There is no ordering of
   * two systems that fixes that without distributed transactions.
   *
   * So: Postgres is the ledger, Redis (M4) is the whiteboard in the lobby. The whiteboard may be
   * seconds stale and nobody is harmed. The ledger may never be a whiteboard. TR-DEC-007 states it as
   * a rule — Redis is authoritative for nothing, and everything in it is rebuildable from here.
   *
   * ─── Why a counter at all, rather than COUNT(*) ─────────────────────────────
   *
   * Counting active holds plus paid orders can never drift, which is genuinely attractive. But it
   * cannot make a DECISION: two transactions can both count "1 left" simultaneously and both proceed.
   * Counting tells you what WAS true. M3's atomic conditional UPDATE on this column is what makes
   * "check and commit" a single indivisible act. COUNT(*) remains useful — as a reconciliation query
   * to detect drift, never to authorise a sale.
   *
   * M3 owns every write to this column, through exactly one method.
   */
  @Column({ type: 'integer', name: 'tickets_committed', default: 0 })
  ticketsCommitted: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /**
   * Derived, not stored — a getter rather than a column.
   *
   * Storing this would create two sources of truth that drift the moment one write path forgets to
   * update it. It is a pure function of two columns already present, so computing it is free and
   * cannot be wrong.
   *
   * NOTE this is the value we deliberately DO NOT cache in M4. A stale event title is a cosmetic
   * problem; a stale availability count is a correctness problem, because someone acts on it.
   */
  get ticketsRemaining(): number {
    return this.totalTickets - this.ticketsCommitted;
  }

  get isSoldOut(): boolean {
    return this.ticketsRemaining <= 0;
  }
}
