import { IsUUID } from 'class-validator';

/**
 * Validated the same way an HTTP DTO is — `@UsePipes(new ValidationPipe())` on the gateway runs
 * this through the identical `class-validator` pipeline, so a malformed `eventId` is rejected
 * before `client.join()` ever runs, rather than silently creating a room for garbage input.
 */
export class SubscribeEventDto {
  @IsUUID()
  eventId: string;
}
