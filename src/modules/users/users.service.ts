import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';

import { User, UserRole } from './entities/user.entity';

/** Postgres error code for a unique constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * TypeORM types `QueryFailedError.driverError` loosely, so the Postgres error code needs a
 * narrowing type guard rather than an `any` cast. The code is the only reliable way to tell a
 * duplicate-key violation from any other database failure — matching on the message text would
 * break the moment Postgres reworded it or the locale changed.
 */
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

  /**
   * Emails are normalised to lowercase before storage and lookup.
   *
   * Done in application code rather than with a `citext` column or a functional index, so the
   * rule is visible and portable. The important part is that it happens on BOTH paths — store
   * and find. Normalising on write only would let `Foo@x.com` register twice, because the
   * unique constraint compares bytes and the two differ.
   *
   * (The alternative worth knowing: an index on `LOWER(email)`. A plain index on `email` is not
   * used by `WHERE LOWER(email) = $1` — the expression defeats it — which is Q74.)
   */
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
      // Catching the constraint violation rather than pre-checking with a SELECT.
      //
      // A pre-check cannot prevent the duplicate — two concurrent registrations both read
      // "available", both insert, and one must fail at the database anyway. So the constraint
      // is the real guard and this is just translating its error into a 409. Checking first
      // would add a query and still need this catch.
      if (isUniqueViolation(error)) {
        // Note this DOES leak that the address is registered. Unavoidable for registration —
        // the user has to be told why it failed. Login is the endpoint where enumeration must
        // be prevented, and it is handled there.
        throw new ConflictException('An account with that email already exists');
      }
      throw error;
    }
  }

  /** Returns null rather than throwing — callers decide whether absence is an error. */
  async findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({ where: { email: UsersService.normaliseEmail(email) } });
  }

  async findById(id: string): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  async findByIdOrFail(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }
}
