import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { UserRole } from '../users/entities/user.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { FindEventsQueryDto } from './dto/find-events-query.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventsService } from './events.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'List events',
    description:
      'Public. Offset-paginated, upcoming-only by default. Sortable columns are validated against an ' +
      'allow-list because ORDER BY cannot be parameterised.',
  })
  async findAll(@Query() query: FindEventsQueryDto) {
    const result = await this.events.findAll(query);
    return { ...result, data: result.data.map(EventResponseDto.from) };
  }

  /**
   * Declared BEFORE `:id`, and the order matters.
   *
   * Nest matches routes in declaration order, so if `@Get(':id')` came first it would match `/events/mine`
   * with `id = 'mine'`, and ParseUUIDPipe would reject it as a malformed UUID — a 400 on a route that
   * exists. This class of bug is entirely invisible until someone adds the literal route second.
   */
  @Get('mine')
  @Roles(UserRole.Organiser)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'My events (organiser only)',
    description: 'Includes past events, unlike the public listing.',
  })
  @ApiResponse({ status: 403, description: 'Caller is an attendee, not an organiser' })
  async findMine(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: PaginationQueryDto,
  ) {
    const result = await this.events.findMine(user.id, query);
    return { ...result, data: result.data.map(EventResponseDto.from) };
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Event detail', description: 'Public. Includes live availability.' })
  @ApiResponse({ status: 404, description: 'No such event' })
  // ParseUUIDPipe rejects a malformed id with 400 before the service runs. Without it, Postgres receives
  // a non-UUID for a uuid column and raises a driver error that surfaces as a 500 — an input problem
  // reported as a server fault.
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return EventResponseDto.from(await this.events.findOne(id));
  }

  @Post()
  @Roles(UserRole.Organiser)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create an event (organiser only)',
    description:
      'The organiser is taken from the verified token, never the body. This is the first route in the ' +
      'project that exercises RolesGuard’s deny branch.',
  })
  @ApiResponse({ status: 201, type: EventResponseDto })
  @ApiResponse({ status: 403, description: 'Caller is an attendee' })
  async create(@Body() dto: CreateEventDto, @CurrentUser() user: CurrentUserPayload) {
    return EventResponseDto.from(await this.events.create(dto, user.id));
  }

  @Patch(':id')
  @Roles(UserRole.Organiser)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Update an event (organiser, owner only)',
    description:
      'TWO checks, on independent axes. RolesGuard confirms the caller is an organiser — from the token, ' +
      'no database needed. The service then confirms this specific event is theirs, which needs the row ' +
      'and so cannot live in a guard. Passing the role check is not permission to edit; conflating the ' +
      'two is how IDOR bugs ship.',
  })
  @ApiResponse({ status: 200, type: EventResponseDto })
  @ApiResponse({ status: 403, description: 'Not an organiser, or not the owner of this event' })
  @ApiResponse({ status: 404, description: 'No such event' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEventDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return EventResponseDto.from(await this.events.update(id, dto, user.id));
  }
}
