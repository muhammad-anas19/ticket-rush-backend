import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { CreateHoldDto } from './dto/create-hold.dto';
import { HoldResponseDto } from './dto/hold-response.dto';
import { HoldsService } from './holds.service';

@ApiTags('holds')
@Controller()
@ApiBearerAuth('access-token')
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @Post('events/:eventId/holds')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Hold tickets for an event',
    description:
      'Commits inventory with a single atomic conditional UPDATE inside a transaction. Zero rows ' +
      'affected means sold out — returns 409, never a partial or ambiguous state.',
  })
  @ApiResponse({ status: 201, type: HoldResponseDto })
  @ApiResponse({ status: 409, description: 'Not enough tickets remaining' })
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CreateHoldDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const { hold, ticketsCommitted } = await this.holds.create(eventId, user.id, dto.quantity);
    return HoldResponseDto.from(hold, ticketsCommitted);
  }

  @Delete('holds/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Release a hold early',
    description:
      "Owner only. A missing hold and SOMEONE ELSE'S hold both return 404 — holds are private, so a " +
      '403 would confirm the id is real and let a caller enumerate valid ones. Contrast ' +
      'EventsService.update(), which uses 403 for exactly the opposite reason: events are already ' +
      'public. A hold that IS yours but already converted or expired returns 403 instead, because at ' +
      'that point existence and ownership are not in question — only whether the action is still valid.',
  })
  @ApiResponse({ status: 404, description: 'No such hold, or not yours' })
  @ApiResponse({ status: 403, description: 'Your hold, but no longer active' })
  async release(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: CurrentUserPayload) {
    await this.holds.release(id, user.id);
  }
}
