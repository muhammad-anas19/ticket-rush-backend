import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  buildPaginatedResponse,
  PaginationQueryDto,
} from '../../common/dto/pagination-query.dto';
import { PaginatedResponse } from '../../common/types/api-envelope';
import { CreateEventDto } from './dto/create-event.dto';
import { FindEventsQueryDto } from './dto/find-events-query.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { Event } from './entities/event.entity';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
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
    return saved;
  }

  /**
   * Public listing. No auth — anyone can browse events.
   */
  async findAll(query: FindEventsQueryDto): Promise<PaginatedResponse<Event>> {
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
    // "showing 1–25 of 83" possible — and is the thing keyset pagination cannot give you.
    const [data, total] = await qb.getManyAndCount();

    return buildPaginatedResponse(data, total, query as PaginationQueryDto);
  }

  async findOne(id: string): Promise<Event> {
    const event = await this.events
      .createQueryBuilder('event')
      .leftJoin('event.organiser', 'organiser')
      .addSelect(['organiser.id', 'organiser.email'])
      .where('event.id = :id', { id })
      .getOne();

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    return event;
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

    return this.events.save(event);
  }

  /** Organiser's own events, including ones that have already started. */
  async findMine(organiserId: string, query: PaginationQueryDto): Promise<PaginatedResponse<Event>> {
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
}
