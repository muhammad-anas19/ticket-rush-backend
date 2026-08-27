import { IsUUID } from 'class-validator';

export class SubscribeEventDto {
  @IsUUID()
  eventId: string;
}
