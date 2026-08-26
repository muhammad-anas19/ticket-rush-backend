import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CacheService } from '../../cache/cache.service';
import { buildPaginatedResponse, PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaginatedResponse } from '../../common/types/api-envelope';
import { RealtimeService } from '../../realtime/realtime.service';
import { CreateEventDto } from './dto/create-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { FindEventsQueryDto } from './dto/find-events-query.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { Event } from './entities/event.entity';

// 60s: short enough that a stale title/venue is imperceptible to a human re-reading a page inside
// a minute, long enough to absorb real read traffic on a hot event page without hammering
// Postgres per request. See concepts/04-redis.md Q3.
const EVENTS_CACHE_TTL_SECONDS = 60;
const EVENTS_LIST_CACHE_NAMESPACE = 'events-list';

/**
 * Everything about an event EXCEPT live availability — the only shape ever written to Redis for
 * this module.
 *
 * `ticketsCommitted` / `ticketsRemaining` / `isSoldOut` are deliberately absent. Caching them is
 * the one mistake this module exists to avoid (see the M2 gate correction and TR-DEC-014): a
 * stale title is cosmetic, a stale availability number is what an oversell is built on. Dates are
 * stored as ISO strings, not `Date` objects, so a value read straight back out of Redis via
 * `JSON.parse` is shaped identically to one just computed fresh — no "cached path returns a string,
 * live path returns a Date" class of bug.
 */
interface CachedEventStatic {
  id: string;
  title: string;
  description: string | null;
  venue: string;
  startsAt: string;
  priceCents: number;
  totalTickets: number;
  organiser?: { id: string; email: string };
  createdAt: string;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    private readonly cache: CacheService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(dto: CreateEventDto, organiserId: string): Promise<Event> {
    const event = this.events.create({
      ...dto,
      // From the verified token, NEVER the request body. The DTO does not even declare the field, and
      // `forbidNonWhitelisted` rejects any attempt to supply it — so creating an event owned by someone
      // else is impossible rather than merely discouraged.
      organiserId,
      startsAt: new Date(dto.startsAt),
      ticketsCommitted: 0,
    });

    const saved = await this.events.save(event);
    this.logger.log(`Event ${saved.id} created by organiser ${organiserId}`);

    // No detail key to invalidate — this id has never been cached. Every cached LISTING is now
    // potentially missing a row, though, so every existing list-cache key must stop being served.
    await this.cache.bumpVersion(EVENTS_LIST_CACHE_NAMESPACE);

    return saved;
  }

  /**
   * Public listing. No auth — anyone can browse events.
   *
   * Cache-aside on the STATIC shape of the page (which events, in what order, with what
   * title/venue/price) plus the total count. Availability is never part of what's cached — after
   * every cache hit or miss, one extra query reads `tickets_committed` fresh for exactly the ids
   * on this page and merges it in before the response leaves this method.
   */
  async findAll(query: FindEventsQueryDto): Promise<PaginatedResponse<EventResponseDto>> {
    const version = await this.cache.getVersion(EVENTS_LIST_CACHE_NAMESPACE);
    const cacheKey = `cache:events:list:v${version}:${this.buildListCacheKey(query)}`;

    const { events: staticEvents, total } = await this.cache.getOrSet(
      cacheKey,
      EVENTS_CACHE_TTL_SECONDS,
      () => this.fetchEventsListFromDb(query),
    );

    const committedById = await this.getLiveCommittedCounts(staticEvents.map((e) => e.id));
    const data = staticEvents.map((event) => this.mergeLiveAvailability(event, committedById));

    return buildPaginatedResponse(data, total, query as PaginationQueryDto);
  }

  /**
   * Cache-aside on one event's static shape. Same rule as `findAll`: a fresh, single-row query for
   * `tickets_committed` runs on every call, cached or not, and is what the response is actually
   * built from.
   */
  async findOne(id: string): Promise<EventResponseDto> {
    const cacheKey = `cache:event:${id}`;

    const staticEvent = await this.cache.getOrSet(cacheKey, EVENTS_CACHE_TTL_SECONDS, () =>
      this.fetchEventStaticFromDb(id),
    );

    const committedById = await this.getLiveCommittedCounts([id]);
    if (!committedById.has(id)) {
      // The cached (or just-fetched) static record says this id existed; the live table
      // disagrees. Never reachable today — there is no delete endpoint — but a cache-aside path
      // must not assert existence on stale information alone if that ever changes.
      throw new NotFoundException('Event not found');
    }

    return this.mergeLiveAvailability(staticEvent, committedById);
  }

  /**
   * Update — and the ownership check is the point of this method.
   *
   * `@Roles(Organiser)` on the route lets in EVERY organiser. It answers "are you the kind of user who
   * may edit events", which is answerable from the token alone and therefore belongs in a guard. It
   * does NOT answer "is this event yours".
   *
   * Role and ownership are independent axes, and checking only the role is exactly how IDOR ships.
   *
   * The check lives here rather than in a guard because it needs the ROW. A guard runs before the
   * handler with nothing loaded, so doing it there means querying the event in the guard and again in
   * the service — two round trips for one operation — or stashing the entity on the request object and
   * coupling the two through mutable state.
   */
  async update(id: string, dto: UpdateEventDto, userId: string): Promise<Event> {
    const event = await this.events.findOne({ where: { id } });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.organiserId !== userId) {
      /**
       * 403, not 404 — and the choice is per-resource rather than global.
       *
       * 404 would hide the event's EXISTENCE, which is the right call when existence is confidential:
       * a 403 on `GET /orders/:id` confirms that order exists and lets an attacker probe for valid ids.
       *
       * Events are PUBLIC. There is a public listing and a public detail endpoint, so the id is already
       * known to everyone and hiding it here buys nothing while costing clarity. 403 is the honest
       * answer: this exists, it is not yours.
       *
       * Orders and holds will return 404 for exactly the opposite reason.
       */
      this.logger.warn(
        `Ownership check failed: user ${userId} attempted to update event ${id} owned by ${event.organiserId}`,
      );
      throw new ForbiddenException('You can only modify your own events');
    }

    // Guard against shrinking capacity below what is already committed. Without it an organiser could
    // set totalTickets to 5 with 20 already held, making ticketsRemaining negative and every subsequent
    // availability check nonsense. The full fix belongs with M3's atomic inventory logic; this is the
    // minimum that keeps the invariant true today.
    if (dto.totalTickets !== undefined && dto.totalTickets < event.ticketsCommitted) {
      throw new ForbiddenException(
        `Cannot reduce capacity to ${dto.totalTickets}: ${event.ticketsCommitted} tickets are already committed`,
      );
    }

    Object.assign(event, {
      ...dto,
      ...(dto.startsAt ? { startsAt: new Date(dto.startsAt) } : {}),
    });

    const saved = await this.events.save(event);

    // Explicit invalidation, not an update-in-place — see concepts/04-redis.md Q2 for why deleting
    // is the safe choice under concurrent writers and updating the cached value isn't. The detail
    // key AND every list-cache key are stale: this event's title/venue/price could appear on any
    // cached listing page.
    await this.cache.invalidate(`cache:event:${id}`);
    await this.cache.bumpVersion(EVENTS_LIST_CACHE_NAMESPACE);

    // Only `totalTickets` changing moves `ticketsRemaining` — a title/venue/price edit leaves
    // availability untouched, so broadcasting on every update would just be noise nobody watching
    // the live count needs to see.
    if (dto.totalTickets !== undefined) {
      this.realtime.broadcastAvailability({
        eventId: saved.id,
        ticketsRemaining: saved.ticketsRemaining,
        isSoldOut: saved.isSoldOut,
      });
    }

    return saved;
  }

  /**
   * Organiser's own events, including ones that have already started.
   *
   * Deliberately NOT cached. This is a low-traffic, single-viewer (the owning organiser) page —
   * caching exists to protect the database from many readers hitting the same hot key, and there
   * is no "many readers" here to protect against. Adding cache-aside would be the pattern applied
   * because it exists, not because this endpoint needs it.
   */
  async findMine(
    organiserId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResponse<Event>> {
    // Uses idx_events_organiser_starts_at. Note that index exists BECAUSE of this query — the composite
    // on (starts_at) alone is useless here, since organiser_id is not its leftmost column and you can
    // only skip index columns from the right.
    const [data, total] = await this.events.findAndCount({
      where: { organiserId },
      order: { startsAt: 'DESC', id: 'ASC' },
      skip: query.skip,
      take: query.limit,
    });

    return buildPaginatedResponse(data, total, query);
  }

  /**
   * One string per distinct combination of page/filter/sort. Deliberately a plain readable string,
   * not a hash — at this cardinality (bounded page size, a handful of sort columns) key length is a
   * non-issue, and being able to read a cache key back in `redis-cli KEYS` and know exactly which
   * request produced it is worth more than the few bytes a hash would save.
   */
  private buildListCacheKey(query: FindEventsQueryDto): string {
    return [
      `page=${query.page}`,
      `limit=${query.limit}`,
      `search=${query.search ?? ''}`,
      `sortBy=${query.sortBy}`,
      `sortOrder=${query.sortOrder}`,
      `upcomingOnly=${query.upcomingOnly}`,
    ].join('&');
  }

  private async fetchEventsListFromDb(
    query: FindEventsQueryDto,
  ): Promise<{ events: CachedEventStatic[]; total: number }> {
    const qb = this.events.createQueryBuilder('event');

    /**
     * A JOIN, not 25 follow-up queries.
     *
     * Without this, showing each event's organiser email means one query for the list and then one per
     * row — the N+1 problem. 26 round trips instead of 1, and it degrades LINEARLY with page size, so
     * the endpoint is fine with 5 rows and unusable with 100.
     *
     * `leftJoin` + explicit `addSelect` rather than `leftJoinAndSelect`: we want one column, not a
     * hydrated User entity per row. Selecting `organiser.email` alone keeps the payload small and
     * cannot accidentally expose a field that gets added to User later.
     *
     * Deliberately NOT `eager: true` on the relation. Eager is invisible at the call site, loads the
     * relation even for queries that do not need it, and — as P1 found the hard way — does NOT apply to
     * `save()`, which produced entities returned with the relation missing or stale.
     */
    qb.leftJoin('event.organiser', 'organiser').addSelect(['organiser.id', 'organiser.email']);

    if (query.upcomingOnly) {
      // Uses idx_events_starts_at. `now()` is evaluated by Postgres, not Node — so it cannot drift with
      // the API server's clock, and it stays correct across multiple API instances.
      qb.andWhere('event.startsAt > now()');
    }

    if (query.search) {
      /**
       * ILIKE for case-insensitive matching, with the term PARAMETERISED.
       *
       * Note this cannot use a plain B-tree index: a leading `%` means the pattern has no fixed prefix,
       * so there is nothing for a sorted structure to seek to. A real search feature needs a trigram
       * index (`pg_trgm` + GIN) or full-text search. For tens of events a sequential scan is genuinely
       * the right plan, and adding an index that the planner would ignore is pure write cost.
       *
       * Documented rather than fixed, because the fix would be premature.
       */
      qb.andWhere('(event.title ILIKE :search OR event.venue ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }

    // Safe because `sortBy` was validated against an explicit allow-list in the DTO. ORDER BY cannot be
    // parameterised, so interpolating an unvalidated string here would be a genuine injection vector.
    qb.orderBy(`event.${query.sortBy}`, query.sortOrder);
    // A stable tiebreaker. Without it, rows sharing a sort value can appear in a different order on each
    // request, so the same row shows up on two pages or on none — a paging bug that looks like flaky
    // data. Cheap insurance even with offset pagination.
    qb.addOrderBy('event.id', 'ASC');

    qb.skip(query.skip).take(query.limit);

    // findAndCount-equivalent: one query for the page, one for the total. The count is what makes
    // "showing 1–25 of 83" possible — and is the thing keyset pagination cannot give you. `total`
    // includes every matching row regardless of committed/remaining, so it is safe to cache alongside
    // the static rows: it does not describe availability, only how many events match the filter.
    const [data, total] = await qb.getManyAndCount();

    return { events: data.map((event) => this.toStaticShape(event)), total };
  }

  private async fetchEventStaticFromDb(id: string): Promise<CachedEventStatic> {
    const event = await this.events
      .createQueryBuilder('event')
      .leftJoin('event.organiser', 'organiser')
      .addSelect(['organiser.id', 'organiser.email'])
      .where('event.id = :id', { id })
      .getOne();

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    return this.toStaticShape(event);
  }

  private toStaticShape(event: Event): CachedEventStatic {
    return {
      id: event.id,
      title: event.title,
      description: event.description,
      venue: event.venue,
      startsAt: event.startsAt.toISOString(),
      priceCents: event.priceCents,
      totalTickets: event.totalTickets,
      organiser: event.organiser
        ? { id: event.organiser.id, email: event.organiser.email }
        : undefined,
      createdAt: event.createdAt.toISOString(),
    };
  }

  /**
   * One query for however many ids are on the page — never one query per row. `tickets_committed`
   * is read through `Repository.query`, a plain SELECT, so (unlike the M3 write paths) there is no
   * tuple-shape trap here: a SELECT always returns `Row[]` directly.
   */
  private async getLiveCommittedCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }

    const rows: Array<{ id: string; tickets_committed: number }> = await this.events.query(
      `SELECT id, tickets_committed FROM events WHERE id = ANY($1)`,
      [ids],
    );

    return new Map(rows.map((row) => [row.id, row.tickets_committed]));
  }

  private mergeLiveAvailability(
    staticEvent: CachedEventStatic,
    committedById: Map<string, number>,
  ): EventResponseDto {
    const ticketsCommitted = committedById.get(staticEvent.id) ?? 0;
    const ticketsRemaining = staticEvent.totalTickets - ticketsCommitted;

    return {
      id: staticEvent.id,
      title: staticEvent.title,
      description: staticEvent.description,
      venue: staticEvent.venue,
      startsAt: new Date(staticEvent.startsAt),
      priceCents: staticEvent.priceCents,
      totalTickets: staticEvent.totalTickets,
      ticketsCommitted,
      ticketsRemaining,
      isSoldOut: ticketsRemaining <= 0,
      organiser: staticEvent.organiser,
      createdAt: new Date(staticEvent.createdAt),
    };
  }
}
