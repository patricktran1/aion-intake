/**
 * The persistence boundary.
 *
 * One interface, two implementations: process memory for the synthetic demo,
 * Postgres for a pilot. Everything above this line — the interview engine, the
 * composer, the routes — is written against the interface and does not know
 * which one it is talking to.
 *
 * Deliberately NOT four repositories. An IntakeRepository, PatientRepository,
 * PhotoRepository and AuditRepository would be four files to keep in sync for
 * a product whose entire data model is "a visit has an intake". The unit of
 * work here really is the intake, so the interface is shaped like that, plus a
 * separate append-only audit sink because audit has genuinely different rules
 * (write-only, never updated, never deleted with its subject).
 *
 * Two properties every implementation must provide, because the layer above
 * relies on them and cannot check:
 *
 *   1. `withIntake` is atomic. The read, the caller's work, and the write
 *      happen as one unit; a concurrent caller for the same intake either
 *      waits or fails, never interleaves. In memory this is a promise chain;
 *      in Postgres it is SELECT ... FOR UPDATE inside a transaction.
 *   2. Every lookup that takes a practice id is scoped by it. Returning a
 *      record from another practice is a data breach, not a bug.
 */

import type { Intake, IntakeBundle, Patient, Practice, Visit } from "@/lib/domain/types";

/** Who is acting. Every audited call carries one. */
export type Actor =
  | { kind: "patient"; intakeId: string }
  | { kind: "clinician"; clinicianId: string; practiceId: string }
  | { kind: "system" }
  | { kind: "anonymous" };

export interface AuditEvent {
  id: string;
  at: string;
  /** Stable verb. See AUDIT_ACTIONS. */
  action: AuditAction;
  actorKind: Actor["kind"];
  /** Clinician id, or the intake id for a patient actor. Never a name. */
  actorId: string | null;
  practiceId: string | null;
  resource: string;
  resourceId: string | null;
  requestId: string | null;
  /** Small, non-clinical facts only — counts, enums, booleans. */
  meta: Record<string, string | number | boolean>;
}

export const AUDIT_ACTIONS = [
  "intake.created",
  "intake.opened",
  "intake.verified",
  "intake.verification_failed",
  "intake.started",
  "intake.answered",
  "intake.fact_edited",
  "intake.submitted",
  "intake.deleted",
  "intake.token_revoked",
  "intake.token_expired",
  "brief.opened",
  "hpi.edited",
  "note.generated",
  "note.copied",
  "hpi.copied",
  "review.updated",
  "photo.uploaded",
  "photo.accessed",
  "photo.deleted",
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "authz.denied",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What a patient token grants, and whether it still grants it. */
export interface PatientAccess {
  intakeId: string;
  practiceId: string;
  visitId: string;
  /** ISO timestamp after which the token is dead. */
  expiresAt: string;
  revokedAt: string | null;
  /** True once the patient has passed the second factor for this token. */
  verifiedAt: string | null;
  failedVerifications: number;
}

export type AccessResult =
  | { ok: true; access: PatientAccess }
  | { ok: false; reason: "not_found" | "expired" | "revoked" | "locked" };

export interface ClinicianAccount {
  id: string;
  practiceId: string;
  email: string;
  displayName: string;
  credential: string;
  disabledAt: string | null;
}

/** A photo whose bytes and metadata have already been validated by the route. */
export interface PhotoInput {
  /** The validated data URL — the byte source for both adapters. */
  dataUrl: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  kind: string;
  caption: string;
  advisories: string[];
  /** Set so a retried upload cannot create a second photo. */
  idempotencyKey?: string | null;
}

export type PhotoResult =
  | { ok: true; bundle: IntakeBundle }
  /** The intake was frozen, or already at the photo cap. */
  | { ok: false; reason: "frozen" | "limit"; bundle: IntakeBundle };

export interface Store {
  readonly kind: "memory" | "sql";

  /** Called once at startup. Migrations, connection checks, nothing clever. */
  init(): Promise<void>;
  close(): Promise<void>;
  /** Cheap liveness probe for pilot:check and health reporting. */
  ping(): Promise<boolean>;

  // --- Reads -------------------------------------------------------------
  getIntake(id: string): Promise<Intake | null>;
  bundleById(id: string): Promise<IntakeBundle | null>;
  /**
   * @param practiceId When given, a bundle belonging to any other practice
   *   must come back as null. This is the tenant boundary.
   */
  bundleForClinician(id: string, practiceId: string): Promise<IntakeBundle | null>;
  listBundles(practiceId: string | null): Promise<IntakeBundle[]>;

  // --- Patient access ----------------------------------------------------
  /** Resolves a raw token to what it grants, applying expiry and revocation. */
  resolveToken(rawToken: string): Promise<AccessResult>;
  bundleForToken(rawToken: string): Promise<IntakeBundle | null>;
  markVerified(intakeId: string): Promise<void>;
  recordVerificationFailure(intakeId: string): Promise<number>;
  revokeToken(intakeId: string): Promise<void>;

  // --- Atomic write ------------------------------------------------------
  /**
   * Runs `mutate` against the current intake under an exclusive claim on that
   * intake, then persists whatever it returns. Returning null commits nothing.
   *
   * Two concurrent calls for the same intake are serialised. Calls for
   * different intakes never block each other.
   */
  withIntake<T>(
    id: string,
    mutate: (intake: Intake) => Promise<{ intake: Intake | null; result: T }>,
  ): Promise<T>;

  // --- Photos ------------------------------------------------------------
  /**
   * Persists an already-validated photo and returns the refreshed bundle.
   *
   * The two adapters store photos in genuinely different places — the demo
   * keeps the data URL in the intake document, the pilot writes the bytes to
   * object storage and the metadata to the photos table — so this is a real
   * polymorphic method rather than a shared implementation. Both perform the
   * freeze and count checks atomically, and both are idempotent under a retry
   * carrying the same `idempotencyKey`.
   */
  attachPhoto(intakeId: string, practiceId: string, input: PhotoInput): Promise<PhotoResult>;
  removePhoto(intakeId: string, photoId: string): Promise<IntakeBundle>;

  // --- Deletion ----------------------------------------------------------
  /**
   * Removes an intake and everything hanging off it in one transaction:
   * messages, facts, photo rows, the patient token, the clinician scratchpad.
   * Audit events survive by design — they record that a deletion happened.
   *
   * @returns what was removed, for the audit entry and for the caller to
   *   reconcile object storage against.
   */
  deleteIntake(id: string): Promise<{ deleted: boolean; photoKeys: string[] }>;

  // --- Deletion outbox ---------------------------------------------------
  /**
   * Object keys whose rows are already gone and whose bytes are still owed a
   * deletion. Populated in the same transaction that removes the rows, so the
   * intent survives a crash; drained by the sweeper until the object is gone.
   */
  pendingObjectDeletions(limit: number): Promise<Array<{ objectKey: string; attempts: number }>>;
  /** Removes an entry once its object is confirmed gone. */
  resolveObjectDeletion(objectKey: string): Promise<void>;
  /** Records a failed attempt so a poison key is visible rather than silent. */
  failObjectDeletion(objectKey: string): Promise<void>;

  /** Records past their retention window, for the deletion job to act on. */
  intakesPastRetention(now: Date): Promise<Array<{ id: string; practiceId: string }>>;
  photosPastRetention(now: Date): Promise<Array<{ intakeId: string; photoId: string; objectKey: string }>>;

  // --- Audit -------------------------------------------------------------
  appendAudit(event: Omit<AuditEvent, "id" | "at"> & { at?: string }): Promise<void>;
  readAudit(filter: { practiceId?: string; intakeId?: string; limit?: number }): Promise<AuditEvent[]>;

  // --- Clinician accounts ------------------------------------------------
  clinicianByEmail(email: string): Promise<(ClinicianAccount & { passwordHash: string }) | null>;
  clinicianById(id: string): Promise<ClinicianAccount | null>;

  // --- Reference data ----------------------------------------------------
  getPractice(id: string): Promise<Practice | null>;
  getVisit(id: string): Promise<Visit | null>;
  getPatient(id: string): Promise<Patient | null>;
}
