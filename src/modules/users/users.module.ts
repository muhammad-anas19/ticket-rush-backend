import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from './entities/user.entity';
import { UsersService } from './users.service';

/**
 * No controller in M1. The build spec's scope discipline is explicit: no profile pages, no
 * admin dashboard, no user management. Registration and login are the entire user surface, and
 * both live in AuthModule.
 *
 * `exports` is the module boundary. AuthModule can use UsersService because it is listed here;
 * nothing can reach the User repository directly, which is what stops "everything reachable
 * from everywhere" from setting in around module six.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
