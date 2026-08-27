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

const EVENTS_CACHE_TTL_SECONDS = 60;
const EVENTS_LIST_CACHE_NAMESPACE = 'events-list';

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
      organiserId,
      startsAt: new Date(dto.startsAt),
      ticketsCommitted: 0,
    });

    const saved = await this.events.save(event);
    this.logger.log(`Event ${saved.id} created by organiser ${organiserId}`);

    await this.cache.bumpVersion(EVENTS_LIST_CACHE_NAMESPACE);

    return saved;
  }

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

  async findOne(id: string): Promise<EventResponseDto> {
    const cacheKey = `cache:event:${id}`;

    const staticEvent = await this.cache.getOrSet(cacheKey, EVENTS_CACHE_TTL_SECONDS, () =>
      this.fetchEventStaticFromDb(id),
    );

    const committedById = await this.getLiveCommittedCounts([id]);
    if (!committedById.has(id)) {
      throw new NotFoundException('Event not found');
    }

    return this.mergeLiveAvailability(staticEvent, committedById);
  }

  async update(id: string, dto: UpdateEventDto, userId: string): Promise<Event> {
    const event = await this.events.findOne({ where: { id } });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.organiserId !== userId) {
      this.logger.warn(
        `Ownership check failed: user ${userId} attempted to update event ${id} owned by ${event.organiserId}`,
      );
      throw new ForbiddenException('You can only modify your own events');
    }

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

    await this.cache.invalidate(`cache:event:${id}`);
    await this.cache.bumpVersion(EVENTS_LIST_CACHE_NAMESPACE);

    if (dto.totalTickets !== undefined) {
      this.realtime.broadcastAvailability({
        eventId: saved.id,
        ticketsRemaining: saved.ticketsRemaining,
        isSoldOut: saved.isSoldOut,
      });
    }

    return saved;
  }

  async findMine(
    organiserId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResponse<Event>> {
    const [data, total] = await this.events.findAndCount({
      where: { organiserId },
      order: { startsAt: 'DESC', id: 'ASC' },
      skip: query.skip,
      take: query.limit,
    });

    return buildPaginatedResponse(data, total, query);
  }

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

    qb.leftJoin('event.organiser', 'organiser').addSelect(['organiser.id', 'organiser.email']);

    if (query.upcomingOnly) {
      qb.andWhere('event.startsAt > now()');
    }

    if (query.search) {
      qb.andWhere('(event.title ILIKE :search OR event.venue ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }

    qb.orderBy(`event.${query.sortBy}`, query.sortOrder);
    qb.addOrderBy('event.id', 'ASC');

    qb.skip(query.skip).take(query.limit);

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
