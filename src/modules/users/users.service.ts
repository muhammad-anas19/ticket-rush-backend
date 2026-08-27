import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';

import { User, UserRole } from './entities/user.entity';

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    typeof (error as QueryFailedError & { code?: unknown }).code === 'string' &&
    (error as QueryFailedError & { code: string }).code === PG_UNIQUE_VIOLATION
  );
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  private static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  async create(email: string, passwordHash: string, role: UserRole): Promise<User> {
    const user = this.users.create({
      email: UsersService.normaliseEmail(email),
      passwordHash,
      role,
    });

    try {
      return await this.users.save(user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('An account with that email already exists');
      }
      throw error;
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({ where: { email: UsersService.normaliseEmail(email) } });
  }

  async findById(id: string): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }
}
