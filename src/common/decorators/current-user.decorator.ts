import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { UserRole } from '../../modules/users/entities/user.entity';

export interface CurrentUserPayload {
  id: string;
  email: string;
  role: UserRole;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserPayload | undefined => {
    return ctx.switchToHttp().getRequest().user as CurrentUserPayload | undefined;
  },
);
