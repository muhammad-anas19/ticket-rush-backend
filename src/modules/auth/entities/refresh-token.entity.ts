import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

/**
 * One row per refresh token ever issued.
 *
 * Rotation INSERTS a new row and marks the old one used — it never updates a token value in
 * place. That distinction is the whole design: update-in-place destroys exactly the history
 * that reuse detection needs. You cannot detect "this token was already spent" if spending it
 * overwrote the record.
 */
@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * SHA-256 of the token, hex encoded. Never the token itself.
   *
   * A FAST hash is correct here, and this is a real distinction worth being able to defend:
   * the token is 32 bytes from a CSPRNG, so there is no guessable structure to slow an
   * attacker down. bcrypt would burn 250ms of CPU on every single refresh and buy nothing.
   * Slow hashes exist for LOW-ENTROPY secrets — passwords — where the attack is guessing.
   *
   * Hashed at all so that a database dump does not hand over working sessions.
   *
   * Unique so that a hash collision or a duplicated insert surfaces as a constraint violation
   * rather than two rows silently sharing an identity.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'token_hash' })
  tokenHash: string;

  /**
   * Every token descended from one login shares a family id.
   *
   * This is what makes reuse detection meaningful. Detecting a replayed token tells you a
   * credential leaked, but revoking only that token is useless — the thief already has the
   * successor. Revoking the whole FAMILY ends the compromised session chain entirely, which
   * is why the column exists.
   */
  @Index()
  @Column({ type: 'uuid', name: 'family_id' })
  familyId: string;

  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  // onDelete CASCADE: deleting a user must not leave orphaned live sessions behind.
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  /**
   * Set when this token is spent (rotated) or revoked. NULL means live.
   *
   * Doubles as the grace-window clock (TR-DEC-017): a token presented after being rotated is
   * legitimate-but-late if `now - revokedAt <= REFRESH_GRACE_SECONDS`, and theft otherwise.
   * One timestamp answers both "is this spent" and "how long ago" — no second column needed.
   */
  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
