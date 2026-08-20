import { PartialType } from '@nestjs/swagger';

import { CreateEventDto } from './create-event.dto';

/**
 * Every field optional, derived from CreateEventDto.
 *
 * `PartialType` from **@nestjs/swagger**, not `@nestjs/mapped-types`. The Swagger version is a drop-in
 * superset: it copies `@ApiProperty` metadata as well as the class-validator rules, so the generated
 * OpenAPI schema stays accurate. Using the mapped-types version leaves Swagger describing a body with
 * no properties.
 *
 * A SEPARATE class rather than reusing CreateEventDto with everything optional. Reusing one loose DTO
 * for both is the shortcut that lets an invalid partial payload through whichever endpoint has the
 * weaker requirements — create would happily accept a body with no title.
 *
 * `totalTickets` stays editable, and that is a real hazard M3 has to handle: lowering it below
 * `ticketsCommitted` would mean more tickets are committed than exist. The check belongs with the
 * atomic inventory logic, so it is deliberately not bodged in here.
 */
export class UpdateEventDto extends PartialType(CreateEventDto) {}
