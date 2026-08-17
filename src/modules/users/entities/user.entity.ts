import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Two roles, and that is the whole model (TR-DEC-003).
 *
 * A normalised roles/permissions schema was deliberately skipped: P1 already built and graded
 * that, so rebuilding it here would re-derive covered ground at the cost of a session Redis
 * and concurrency need more.
 *
 * The role is SELF-SELECTED at registration, which is only safe because organiser is a
 * different capability rather than a higher privilege — an organiser can create their own
 * events and gains no access whatsoever to another user's data. In a system where the elevated
 * role could read other people's records, self-selection would be straightforward privilege
 * escalation.
 */
export enum UserRole {
  Organiser = 'organiser',
  Attendee = 'attendee',
}

@Entity('users')
export class User {
  // UUID, not auto-increment. Sequential integers leak how many records exist ("user #4"
  // implies four users) and make IDOR probing trivial — you can walk 1, 2, 3. A UUID is not
  // authorisation, but it removes enumeration as a free attack.
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Unique at the DATABASE level, not just checked in the service.
  //
  // "SELECT then INSERT if absent" cannot prevent duplicates under concurrency: two requests
  // both read "no such email", both insert, and now you have two accounts on one address.
  // That is a TOCTOU race, and only a constraint closes it atomically. The service still
  // checks first — for a friendly error message — but the constraint is what makes it correct.
  //
  // Same insight M3 is built on: read-then-write is a race in every form it takes.
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email: string;

  /**
   * bcrypt hash (TR-DEC-016). Never the plaintext, obviously — but also never logged, never
   * serialised, and never returned by any endpoint.
   *
   * @Exclude() plus the global ClassSerializerInterceptor removes it from every response BY
   * CONSTRUCTION. The alternative — `delete user.passwordHash` in each service method — works
   * right up until someone adds a method and forgets, at which point you have leaked every
   * hash in the table through an endpoint nobody reviewed for it.
   */
  @Exclude()
  @Column({ type: 'varchar', length: 255, name: 'password_hash' })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  // TIMESTAMPTZ, always. A bare TIMESTAMP stores a wall-clock reading with no zone, so the
  // same row means different instants depending on who reads it — and this app sells tickets
  // to events that start at a specific moment.
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
