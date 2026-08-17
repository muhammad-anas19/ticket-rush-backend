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
 * Why a token stopped being live.
 *
 * This column exists because of a real bug found by testing the failure path (see the M1
 * walkthrough). Originally `revokedAt` alone carried two completely different meanings —
 * "spent by a normal rotation" and "killed because we suspect theft" — and the grace window
 * could not tell them apart.
 *
 * The consequence was severe: reuse detection revoked the family, and then any token in that
 * family presented within the next 30 seconds landed in the grace branch and was issued a fresh
 * pair. **A revoked session could resurrect itself.** Logout had the same hole.
 *
 * One timestamp answering two questions is the whole defect. Grace now applies only to
 * `Rotated`; anything revoked for cause is permanently dead.
 */
export enum RevocationReason {
  /** Spent by a normal refresh. Eligible for the TR-DEC-017 grace window. */
  Rotated = 'rotated',
  /** Killed by reuse detection. Never eligible for grace. */
  ReuseDetected = 'reuse_detected',
  /** Killed by an explicit logout. Never eligible for grace. */
  Logout = 'logout',
}

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
   * Set when this token stops being live. NULL means live.
   *
   * Also the grace-window clock (TR-DEC-017): a rotated token presented again is
   * legitimate-but-late if `now - revokedAt <= REFRESH_GRACE_SECONDS`.
   *
   * But the clock is only meaningful together with `revokedReason` — see that enum for the bug
   * that proved it. A timestamp alone cannot distinguish "spent normally" from "killed for
   * cause", and treating those the same lets a revoked session come back.
   */
  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt: Date | null;

  /** NULL while live. See RevocationReason — grace applies to `Rotated` only. */
  @Column({
    type: 'enum',
    enum: RevocationReason,
    name: 'revoked_reason',
    nullable: true,
  })
  revokedReason: RevocationReason | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
