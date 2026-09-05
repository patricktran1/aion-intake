/**
 * Pilot adapter — Postgres.
 *
 * Where the demo adapter relies on being one process, this one relies on the
 * database. Three properties move down here because they have to survive a
 * second instance:
 *
 *   Atomicity   `withIntake` opens a transaction and takes a row lock. Two
 *               requests for the same intake serialise in the database, so a
 *               second web instance changes nothing.
 *   Tenancy     Every clinician-facing query carries practice_id in its WHERE
 *               clause. Not checked after fetching — never fetched at all.
 *   Liveness    Tokens carry expiry and revocation, evaluated in SQL at
 *               resolution time so a token cannot outlive its row's intent.
 *
 * The intake's conversational state is one JSONB document. See the comment in
 * 0001_initial.sql for why, and for what stays out of the schema.
 */

import type { Intake, IntakeBundle, Patient, Practice, Visit } from "@/lib/domain/types";
import { intakeSchema } from "@/lib/domain/types";
import type { Driver, Queryable } from "@/lib/db/driver";
import { hashToken } from "@/lib/patient/token";
import { photoKey, type ObjectStore } from "@/lib/objects";
import { MAX_PHOTOS } from "@/lib/photos";
import { randomBytes } from "node:crypto";
import { MAX_VERIFICATION_ATTEMPTS } from "@/lib/patient/token";
import { AppError } from "@/lib/errors";
import type {
  AccessResult,
  AuditEvent,
  ClinicianAccount,
  PhotoInput,
  PhotoResult,
  Store,
} from "./types";

interface IntakeRow {
  id: string;
  practice_id: string;
  visit_id: string;
  status: string;
  pathway: string;
  urgent_flag: boolean;
  version: number;
  document: unknown;
}

const iso = (v: unknown): string | null => {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
};

/**
 * Rebuilds the domain object from the row. The promoted columns win over the
 * document: they are what the database enforces constraints on, so if the two
 * ever disagree the column is the truth.
 */
function toIntake(row: IntakeRow): Intake {
  const doc = (typeof row.document === "string" ? JSON.parse(row.document) : row.document) as Record<
    string,
    unknown
  >;
  return intakeSchema.parse({
    ...doc,
    id: row.id,
    visitId: row.visit_id,
    status: row.status,
    pathway: row.pathway,
    urgentFlag: row.urgent_flag,
  });
}

/** The document holds everything the columns do not. */
function toDocument(intake: Intake): string {
  return JSON.stringify(intake);
}

/** The bytes behind a `data:...;base64,...` URL. */
function dataUrlToBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  return Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, "base64");
}

export class SqlStore implements Store {
  readonly kind = "sql" as const;
  /**
   * Readable so the shared rate limiter can borrow the same connection pool
   * rather than opening a second one for a handful of writes an hour.
   */
  readonly driver: Driver;
  private readonly pepper: string;
  /**
   * The object store is injected because photo bytes and photo metadata live in
   * two different places that must be kept consistent, and the store is the one
   * component positioned to keep them so. Optional so that maintenance uses of
   * the store (migrations, retention) can construct it without one.
   */
  private readonly objects: ObjectStore | null;
  /**
   * The factor new tokens are issued with. Comes from configuration, so
   * AION_PATIENT_SECOND_FACTOR actually decides something: it used to be read
   * only to print a line in `pilot:check`, which made it a security knob that
   * changed nothing — the worst kind, because an operator sets it and believes
   * the factor changed.
   */
  private readonly defaultSecondFactor: string;

  constructor(
    driver: Driver,
    opts: { pepper: string; objects?: ObjectStore | null; defaultSecondFactor?: string },
  ) {
    this.driver = driver;
    this.pepper = opts.pepper;
    this.objects = opts.objects ?? null;
    this.defaultSecondFactor = opts.defaultSecondFactor ?? "dob";
  }

  async init(): Promise<void> {
    await this.ping();
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async ping(): Promise<boolean> {
    try {
      await this.driver.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  // --- Reads ---------------------------------------------------------------

  async getIntake(id: string): Promise<Intake | null> {
    const { rows } = await this.driver.query<IntakeRow>(
      "SELECT * FROM intakes WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return rows[0] ? toIntake(rows[0]) : null;
  }

  private async assemble(q: Queryable, row: IntakeRow): Promise<IntakeBundle | null> {
    const { rows: vr } = await q.query<Record<string, unknown>>(
      `SELECT v.id, v.practice_id, v.patient_id, v.scheduled_for, v.reason_booked, v.location,
              p.first_name, p.last_name, p.date_of_birth,
              pr.name AS practice_name
         FROM visits v
         JOIN patients p ON p.id = v.patient_id
         JOIN practices pr ON pr.id = v.practice_id
        WHERE v.id = $1`,
      [row.visit_id],
    );
    const r = vr[0];
    if (!r) return null;

    const visit: Visit = {
      id: String(r.id),
      practiceId: String(r.practice_id),
      patientId: String(r.patient_id),
      scheduledFor: iso(r.scheduled_for) ?? "",
      reasonBooked: String(r.reason_booked ?? ""),
      location: String(r.location ?? ""),
    };
    const patient: Patient = {
      id: String(r.patient_id),
      firstName: String(r.first_name),
      lastName: String(r.last_name),
      dateOfBirth: (iso(r.date_of_birth) ?? "").slice(0, 10),
    };
    // Clinician name on the brief comes from the signed-in clinician at render
    // time; the practice row carries only the practice's own identity.
    const practice: Practice = {
      id: String(r.practice_id),
      name: String(r.practice_name),
      clinicianName: "",
      clinicianCredential: "",
    };
    const photos = await this.loadPhotos(q, row.id);
    const intake = toIntake(row);
    return { intake: { ...intake, photos }, visit, patient, practice };
  }

  private async loadPhotos(q: Queryable, intakeId: string): Promise<Intake["photos"]> {
    const { rows } = await q.query<Record<string, unknown>>(
      `SELECT id, object_key, mime, bytes, width, height, kind, caption, advisories, uploaded_at
         FROM photos WHERE intake_id = $1 AND deleted_at IS NULL ORDER BY uploaded_at`,
      [intakeId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as Intake["photos"][number]["kind"],
      mime: String(r.mime),
      bytes: Number(r.bytes),
      width: Number(r.width),
      height: Number(r.height),
      // The bytes are never inlined into a record. The client is handed a
      // route it must be authorized on, and the object key never leaves here.
      dataUrl: `/api/intake/photo/${String(r.id)}`,
      caption: String(r.caption ?? ""),
      advisories: (typeof r.advisories === "string"
        ? JSON.parse(r.advisories)
        : (r.advisories ?? [])) as string[],
      at: iso(r.uploaded_at) ?? new Date().toISOString(),
    }));
  }

  async bundleById(id: string): Promise<IntakeBundle | null> {
    const { rows } = await this.driver.query<IntakeRow>(
      "SELECT * FROM intakes WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return rows[0] ? this.assemble(this.driver, rows[0]) : null;
  }

  async bundleForClinician(id: string, practiceId: string): Promise<IntakeBundle | null> {
    // The tenant boundary. practice_id is in the WHERE clause, so another
    // practice's intake is not fetched and then rejected — it is never read.
    const { rows } = await this.driver.query<IntakeRow>(
      "SELECT * FROM intakes WHERE id = $1 AND practice_id = $2 AND deleted_at IS NULL",
      [id, practiceId],
    );
    return rows[0] ? this.assemble(this.driver, rows[0]) : null;
  }

  async listBundles(practiceId: string | null): Promise<IntakeBundle[]> {
    // A clinician list with no practice is not a thing that should exist. The
    // null case is for maintenance scripts, which pass it explicitly.
    const { rows } = practiceId
      ? await this.driver.query<IntakeRow>(
          `SELECT * FROM intakes WHERE practice_id = $1 AND deleted_at IS NULL
            ORDER BY CASE status WHEN 'ready_for_review' THEN 0 WHEN 'in_progress' THEN 1
                                 WHEN 'not_started' THEN 2 ELSE 3 END, last_activity_at DESC`,
          [practiceId],
        )
      : await this.driver.query<IntakeRow>(
          "SELECT * FROM intakes WHERE deleted_at IS NULL ORDER BY last_activity_at DESC",
        );
    const out: IntakeBundle[] = [];
    for (const row of rows) {
      const b = await this.assemble(this.driver, row);
      if (b) out.push(b);
    }
    return out;
  }

  // --- Patient access ------------------------------------------------------

  async resolveToken(rawToken: string): Promise<AccessResult> {
    const hash = hashToken(rawToken, this.pepper);
    const { rows } = await this.driver.query<Record<string, unknown>>(
      `SELECT t.intake_id, t.practice_id, t.expires_at, t.revoked_at, t.verified_at,
              t.failed_verifications, t.second_factor_kind, t.second_factor_hash,
              t.second_factor_expires_at, i.visit_id
         FROM patient_tokens t
         JOIN intakes i ON i.id = t.intake_id AND i.deleted_at IS NULL
        WHERE t.token_hash = $1`,
      [hash],
    );
    const r = rows[0];
    if (!r) return { ok: false, reason: "not_found" };
    if (r.revoked_at) return { ok: false, reason: "revoked" };

    const expiresAt = iso(r.expires_at) ?? "";
    if (new Date(expiresAt).getTime() <= Date.now()) return { ok: false, reason: "expired" };
    if (Number(r.failed_verifications) >= MAX_VERIFICATION_ATTEMPTS) return { ok: false, reason: "locked" };

    return {
      ok: true,
      access: {
        intakeId: String(r.intake_id),
        practiceId: String(r.practice_id),
        visitId: String(r.visit_id),
        expiresAt,
        revokedAt: null,
        verifiedAt: iso(r.verified_at),
        failedVerifications: Number(r.failed_verifications),
        secondFactorKind: String(r.second_factor_kind ?? "dob"),
        secondFactorHash: r.second_factor_hash ? String(r.second_factor_hash) : null,
        secondFactorExpiresAt: iso(r.second_factor_expires_at),
      },
    };
  }

  async bundleForToken(rawToken: string): Promise<IntakeBundle | null> {
    const resolved = await this.resolveToken(rawToken);
    if (!resolved.ok) return null;
    return this.bundleById(resolved.access.intakeId);
  }

  async markVerified(intakeId: string): Promise<void> {
    await this.driver.query(
      "UPDATE patient_tokens SET verified_at = now(), failed_verifications = 0 WHERE intake_id = $1",
      [intakeId],
    );
  }

  async claimVerificationAttempt(intakeId: string): Promise<{ allowed: boolean; attempts: number }> {
    // One statement: the limit is in the WHERE clause, so concurrent claims
    // serialise on the row and the (n+1)th finds nothing to update.
    const { rows } = await this.driver.query<{ failed_verifications: number }>(
      `UPDATE patient_tokens SET failed_verifications = failed_verifications + 1
        WHERE intake_id = $1 AND failed_verifications < $2
        RETURNING failed_verifications`,
      [intakeId, MAX_VERIFICATION_ATTEMPTS],
    );
    if (!rows[0]) return { allowed: false, attempts: MAX_VERIFICATION_ATTEMPTS };
    return { allowed: true, attempts: Number(rows[0].failed_verifications) };
  }

  async recordVerificationFailure(intakeId: string): Promise<number> {
    // Incremented in the database rather than read-modify-written, so parallel
    // guesses each cost an attempt instead of racing to the same number.
    const { rows } = await this.driver.query<{ failed_verifications: number }>(
      `UPDATE patient_tokens SET failed_verifications = failed_verifications + 1
        WHERE intake_id = $1 RETURNING failed_verifications`,
      [intakeId],
    );
    return rows[0] ? Number(rows[0].failed_verifications) : 0;
  }

  async revokeToken(intakeId: string): Promise<void> {
    await this.driver.query(
      "UPDATE patient_tokens SET revoked_at = now() WHERE intake_id = $1 AND revoked_at IS NULL",
      [intakeId],
    );
  }

  async setSecondFactor(
    intakeId: string,
    kind: string,
    hash: string | null,
    expiresAt: string | null,
  ): Promise<void> {
    await this.driver.query(
      `UPDATE patient_tokens
          SET second_factor_kind = $2, second_factor_hash = $3, second_factor_expires_at = $4,
              -- A new factor means the old proof no longer stands, and the
              -- attempt budget resets so a patient is not locked out by
              -- failures against a factor that is no longer in force.
              verified_at = NULL, failed_verifications = 0
        WHERE intake_id = $1`,
      [intakeId, kind, hash, expiresAt],
    );
  }

  /** Issues a fresh token, replacing any existing one for this intake. */
  async issueToken(
    intakeId: string,
    practiceId: string,
    rawToken: string,
    expiresAt: string,
    secondFactorKind: string = this.defaultSecondFactor,
  ): Promise<void> {
    await this.driver.query(
      `INSERT INTO patient_tokens (intake_id, practice_id, token_hash, expires_at, second_factor_kind)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (intake_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at,
             second_factor_kind = EXCLUDED.second_factor_kind,
             second_factor_hash = NULL, second_factor_expires_at = NULL,
             revoked_at = NULL, verified_at = NULL, failed_verifications = 0`,
      [intakeId, practiceId, hashToken(rawToken, this.pepper), expiresAt, secondFactorKind],
    );
  }

  // --- Atomic write --------------------------------------------------------

  async withIntake<T>(
    id: string,
    mutate: (intake: Intake) => Promise<{ intake: Intake | null; result: T }>,
  ): Promise<T> {
    return this.driver.transaction(async (tx) => {
      // FOR UPDATE is the whole mechanism: a second transaction touching this
      // intake blocks here until the first commits, so the read-modify-write
      // cannot interleave no matter how many instances are running.
      const { rows } = await tx.query<IntakeRow>(
        "SELECT * FROM intakes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [id],
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", `intake ${id}`);

      // Photos come from the photos TABLE, not from the document. The document
      // carries an empty array in pilot mode, so handing the caller a bare
      // `toIntake(row)` silently dropped every photograph — and any caller that
      // rendered the result showed a record with no photos at all. That is what
      // happened to the clinician brief and to the patient's own review screen:
      // the first answer after an upload made the photographs disappear from
      // the page while the rows and bytes sat there untouched.
      //
      // Loading them here rather than asking every caller to remember is the
      // only version of this that stays true.
      const current = { ...toIntake(rows[0]), photos: await this.loadPhotos(tx, id) };
      const { intake, result } = await mutate(current);
      if (!intake) return result;

      const updated = await tx.query(
        `UPDATE intakes
            SET status = $2, pathway = $3, urgent_flag = $4, document = $5,
                started_at = $6, submitted_at = $7,
                last_activity_at = now(), version = version + 1
          WHERE id = $1 AND version = $8`,
        [
          id,
          intake.status,
          intake.pathway,
          intake.urgentFlag,
          // Never write photos into the document: the table is authoritative,
          // and a second copy is a second thing to keep in step. It would also
          // survive a photo's deletion.
          toDocument({ ...intake, photos: [] }),
          intake.startedAt ?? null,
          intake.submittedAt ?? null,
          rows[0].version,
        ],
      );
      // Belt and braces: the row lock already prevents this, but the version
      // check turns any future path that skips the lock into a loud failure
      // rather than a silent overwrite.
      if (updated.rowCount === 0) throw new AppError("STORE_CONFLICT", `intake ${id} changed underneath the write`);
      return result;
    });
  }

  // --- Deletion ------------------------------------------------------------

  async deleteIntake(id: string): Promise<{ deleted: boolean; photoKeys: string[] }> {
    const outcome = await this.driver.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "SELECT id FROM intakes WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!rows[0]) return { deleted: false, photoKeys: [] };

      const { rows: keys } = await tx.query<{ object_key: string; practice_id: string }>(
        "SELECT object_key, practice_id FROM photos WHERE intake_id = $1",
        [id],
      );

      // The intent to delete the bytes is recorded in the SAME transaction that
      // removes the rows. Without this, a crash between the row delete and the
      // object delete strands a photograph that nothing references and nothing
      // can ever find — a retention failure that reports itself as success.
      for (const k of keys) {
        await tx.query(
          `INSERT INTO pending_object_deletions (object_key, practice_id, reason)
           VALUES ($1, $2, 'intake_deleted') ON CONFLICT (object_key) DO NOTHING`,
          [k.object_key, k.practice_id],
        );
      }

      // ON DELETE CASCADE removes photos and the patient token. Audit events
      // are not children of the intake and deliberately survive: they are the
      // record that the deletion happened.
      const { rows: visitRows } = await tx.query<{ visit_id: string }>(
        "SELECT visit_id FROM intakes WHERE id = $1",
        [id],
      );
      await tx.query("DELETE FROM intakes WHERE id = $1", [id]);

      // And the identity the intake was about. Deleting the intake alone left
      // the patient's name and exact date of birth in `patients`, and the
      // appointment time and reason booked in `visits` — so "the record was
      // deleted" meant the clinical content was gone while the fact that a
      // named person had a dermatology appointment for a stated reason
      // remained, indefinitely. This product holds one visit per intake and no
      // longitudinal record, so a visit with no intake has nothing left to be,
      // and a patient with no visits has no reason to exist here.
      const visitId = visitRows[0]?.visit_id;
      if (visitId) {
        const { rows: patientRows } = await tx.query<{ patient_id: string }>(
          "DELETE FROM visits WHERE id = $1 RETURNING patient_id",
          [visitId],
        );
        const patientId = patientRows[0]?.patient_id;
        if (patientId) {
          // Only when nothing else references them: a patient with a second
          // appointment inside the retention window is still a live record.
          await tx.query(
            `DELETE FROM patients
              WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM visits WHERE patient_id = $1)`,
            [patientId],
          );
        }
      }
      return { deleted: true, photoKeys: keys.map((k) => k.object_key) };
    });

    // Attempt the bytes immediately, outside the transaction. This is the fast
    // path, not the guarantee — whatever fails here stays in the outbox for the
    // sweeper. Callers get `photoKeys` for their audit entry; they no longer
    // have to delete anything, and a caller that still does is harmless because
    // object deletion is idempotent.
    for (const key of outcome.photoKeys) await this.sweepOne(key);
    return outcome;
  }

  /**
   * Retention's photo deletion: the row and the intent in one transaction, then
   * a best-effort sweep. Retention used to delete the object first and the row
   * second, which meant one failing object aborted the whole run and left the
   * rest of the batch undeleted. Now a failure is one stuck entry, not a stuck
   * job, and re-running converges.
   */
  async retirePhoto(photoId: string): Promise<{ objectKey: string } | null> {
    const objectKey = await this.driver.transaction(async (tx) => {
      const { rows } = await tx.query<{ object_key: string; practice_id: string }>(
        "DELETE FROM photos WHERE id = $1 RETURNING object_key, practice_id",
        [photoId],
      );
      if (!rows[0]) return null;
      await tx.query(
        `INSERT INTO pending_object_deletions (object_key, practice_id, reason)
         VALUES ($1, $2, 'retention') ON CONFLICT (object_key) DO NOTHING`,
        [rows[0].object_key, rows[0].practice_id],
      );
      return rows[0].object_key;
    });
    if (!objectKey) return null;
    await this.sweepOne(objectKey);
    return { objectKey };
  }

  /**
   * @param now the submitted-intake cutoff.
   * @param abandonedBefore the cutoff for intakes that were never submitted.
   *   Without it these were never selected at all: the clause required
   *   submitted_at IS NOT NULL, so a patient who opened their link, typed a
   *   symptom and closed the tab left a record with no retention clock on it —
   *   it stayed forever, which is the one outcome a retention policy exists to
   *   rule out. An abandoned intake holds less than a completed one and is not
   *   nothing.
   */
  async intakesPastRetention(
    now: Date,
    abandonedBefore?: Date,
  ): Promise<Array<{ id: string; practiceId: string }>> {
    const { rows } = await this.driver.query<{ id: string; practice_id: string }>(
      `SELECT id, practice_id FROM intakes
        WHERE deleted_at IS NULL
          AND (
            (submitted_at IS NOT NULL AND submitted_at < $1)
            OR (submitted_at IS NULL AND $2::timestamptz IS NOT NULL AND last_activity_at < $2)
          )`,
      [now.toISOString(), abandonedBefore ? abandonedBefore.toISOString() : null],
    );
    return rows.map((r) => ({ id: r.id, practiceId: r.practice_id }));
  }

  async photosPastRetention(now: Date): Promise<Array<{ intakeId: string; photoId: string; objectKey: string }>> {
    const { rows } = await this.driver.query<{ intake_id: string; id: string; object_key: string }>(
      "SELECT intake_id, id, object_key FROM photos WHERE deleted_at IS NULL AND uploaded_at < $1",
      [now.toISOString()],
    );
    return rows.map((r) => ({ intakeId: r.intake_id, photoId: r.id, objectKey: r.object_key }));
  }

  // --- Photos --------------------------------------------------------------

  /**
   * Persists a validated photo: bytes to the object store, metadata to the
   * photos table, both under a lock on the intake row so the freeze and count
   * checks cannot race an upload.
   *
   * The bytes are written AFTER the transaction commits, and this is the whole
   * point. The row and the object cannot be written atomically, so one of them
   * has to go first, and the two failures are not equally bad:
   *
   *   row first  -> a crash leaves a row pointing at nothing. Visible as a
   *                 broken photo, cleaned by retention. Recoverable.
   *   object first -> a crash leaves a photograph nothing references and
   *                 nothing will ever find. Not recoverable.
   *
   * This method's comment claimed the first ordering and implemented the
   * second: `objects.put` ran INSIDE the transaction, before the final read
   * and the commit. A rollback at any point after it — a failed re-read, a
   * deadlock, a lost connection — undid the row and left the object. The put
   * now happens after commit, and a failed put deletes the row it belongs to
   * so the outcome is "no row, no object" rather than half a photograph.
   */
  async attachPhoto(intakeId: string, practiceId: string, input: PhotoInput): Promise<PhotoResult> {
    if (!this.objects) throw new AppError("INTERNAL", "object store not configured");
    const objects = this.objects;
    let pending: { photoId: string; objectKey: string } | null = null;

    const outcome: PhotoResult = await this.driver.transaction(async (tx): Promise<PhotoResult> => {
      const { rows } = await tx.query<IntakeRow>(
        "SELECT * FROM intakes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [intakeId],
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", `intake ${intakeId}`);
      if (rows[0].practice_id !== practiceId) throw new AppError("ACCESS_DENIED", "intake belongs to another practice");

      const refreshed = async (): Promise<IntakeBundle> => {
        const b = await this.assemble(tx, rows[0]);
        if (!b) throw new AppError("INTERNAL", "intake has no bundle");
        return b;
      };

      const status = rows[0].status;
      if (status === "ready_for_review" || status === "reviewed") {
        return { ok: false, reason: "frozen", bundle: await refreshed() };
      }

      const { rows: countRows } = await tx.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM photos WHERE intake_id = $1 AND deleted_at IS NULL",
        [intakeId],
      );
      if (Number(countRows[0]?.n ?? 0) >= MAX_PHOTOS) {
        return { ok: false, reason: "limit", bundle: await refreshed() };
      }

      const key = photoKey(practiceId, intakeId, input.mime);
      const id = `pho_${randomBytes(8).toString("hex")}`;
      const { rows: inserted } = await tx.query<{ id: string; object_key: string }>(
        `INSERT INTO photos (id, intake_id, practice_id, object_key, mime, bytes, width, height,
                             kind, caption, advisories, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         ON CONFLICT DO NOTHING
         RETURNING id, object_key`,
        [id, intakeId, practiceId, key, input.mime, input.bytes, input.width, input.height,
          input.kind, input.caption, JSON.stringify(input.advisories), input.idempotencyKey ?? null],
      );

      // On an idempotent retry the insert did nothing; find the row that
      // already exists so the object is re-put under the right key.
      let objectKey = inserted[0]?.object_key;
      let photoId = inserted[0]?.id;
      let isRetry = false;
      if (!objectKey && input.idempotencyKey) {
        const { rows: existing } = await tx.query<{ id: string; object_key: string }>(
          "SELECT id, object_key FROM photos WHERE intake_id = $1 AND idempotency_key = $2",
          [intakeId, input.idempotencyKey],
        );
        objectKey = existing[0]?.object_key;
        photoId = existing[0]?.id;
        isRetry = Boolean(objectKey);
      }
      if (!objectKey || !photoId) {
        throw new AppError("INTERNAL", "photo insert conflicted without an idempotency key");
      }

      // A retry converges on the FIRST upload: its bytes are already stored and
      // its metadata is what the row says. Re-putting would overwrite the bytes
      // while the row kept the first attempt's dimensions and advisories, so the
      // record would describe one image and the store would hold another.
      pending = isRetry ? null : { photoId, objectKey };
      return { ok: true as const, bundle: await refreshed() };
    });

    if (pending) {
      const { photoId, objectKey } = pending;
      try {
        await objects.put(objectKey, dataUrlToBytes(input.dataUrl), input.mime);
      } catch (err) {
        // The row committed and the bytes did not. Take the row back out —
        // through the outbox path, so if the object partially landed it is
        // still owed a deletion — and report the failure rather than handing
        // back a bundle containing a photograph that does not exist.
        await this.retirePhoto(photoId).catch(() => {});
        throw err instanceof AppError ? err : new AppError("OBJECT_STORE_UNAVAILABLE", "photo bytes not stored");
      }

      // The window between that COMMIT and this put belongs to nobody, and
      // moving the put out of the transaction is what created it. A deletion
      // landing inside it takes the intake lock, sees the committed row,
      // enqueues the key, and sweeps an object that has not been written yet —
      // which reports "confirmed absent", clears the outbox entry, and then
      // these bytes land. Row gone, nothing owed, a photograph on disk that
      // retention cannot find (it walks the photos table) and reconcile cannot
      // find (it drains the outbox). Exactly the orphan the outbox exists to
      // prevent, arriving through the fix for the other ordering.
      //
      // So after the bytes land, ask whether the row is still there. Present:
      // any later deletion will see it and enqueue normally. Absent: the
      // deleter already swept a key that did not exist, and this path owns the
      // cleanup. Exhaustive rather than timing-dependent — there is no third
      // answer — and the outbox row is written before the sweep, so a crash in
      // between still converges.
      const stillReferenced = await this.driver.transaction(async (tx) => {
        const { rows } = await tx.query("SELECT 1 FROM photos WHERE id = $1", [photoId]);
        if (rows[0]) return true;
        await tx.query(
          `INSERT INTO pending_object_deletions (object_key, practice_id, reason)
           VALUES ($1, $2, 'orphaned_upload') ON CONFLICT (object_key) DO NOTHING`,
          [objectKey, practiceId],
        );
        return false;
      });
      if (!stillReferenced) {
        await this.sweepOne(objectKey);
        // The bundle assembled inside the transaction describes an intake that
        // no longer exists. Saying "uploaded" would be a second lie on top of
        // the first.
        throw new AppError("NOT_FOUND", `intake ${intakeId} was deleted during the upload`);
      }
    }
    return outcome;
  }

  async removePhoto(intakeId: string, photoId: string): Promise<{ bundle: IntakeBundle; removed: boolean }> {
    if (!this.objects) throw new AppError("INTERNAL", "object store not configured");
    let pendingKey: string | null = null;

    const bundle = await this.driver.transaction(async (tx) => {
      const { rows } = await tx.query<IntakeRow>(
        "SELECT * FROM intakes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [intakeId],
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", `intake ${intakeId}`);

      const status = rows[0].status;
      // A frozen intake's photos are part of the record under review.
      if (status !== "ready_for_review" && status !== "reviewed") {
        const { rows: del } = await tx.query<{ object_key: string }>(
          "DELETE FROM photos WHERE id = $1 AND intake_id = $2 RETURNING object_key",
          [photoId, intakeId],
        );
        if (del[0]) {
          // Enqueue inside the transaction, then attempt the delete outside the
          // happy path's critical section. If the attempt fails — or we die
          // before it — the outbox entry survives and the sweeper converges.
          await tx.query(
            `INSERT INTO pending_object_deletions (object_key, practice_id, reason)
             VALUES ($1, $2, 'photo_removed') ON CONFLICT (object_key) DO NOTHING`,
            [del[0].object_key, rows[0].practice_id],
          );
          pendingKey = del[0].object_key;
        }
      }

      const b = await this.assemble(tx, rows[0]);
      if (!b) throw new AppError("INTERNAL", "intake has no bundle");
      return b;
    });

    // Outside the transaction: the row is already gone and the intent is
    // durable, so a failure here is a retry, not a lost deletion.
    if (pendingKey) await this.sweepOne(pendingKey);
    return { bundle, removed: pendingKey !== null };
  }

  /**
   * Deletes one owed object and clears its outbox entry.
   *
   * The entry is cleared **only** on a confirmed absence. `ObjectStore.delete`
   * returns true when the object is gone — including when it was already gone,
   * which is what makes a retry safe — and false when the store could not
   * confirm that. Resolving on anything less would drop the intent and strand
   * the bytes permanently, which is the exact failure this outbox exists to
   * prevent; an earlier version of this method ignored the return value and
   * did precisely that.
   */
  async sweepOne(objectKey: string): Promise<boolean> {
    if (!this.objects) return false;
    let gone = false;
    try {
      gone = await this.objects.delete(objectKey);
    } catch {
      gone = false;
    }
    if (gone) {
      await this.resolveObjectDeletion(objectKey);
      return true;
    }
    await this.failObjectDeletion(objectKey);
    return false;
  }

  /**
   * Drains owed deletions. Safe to run concurrently with itself and with live
   * traffic: every step is idempotent, so the worst a double run costs is a
   * second DELETE against an object that is already gone.
   *
   * @returns how many objects are now confirmed gone, and how many are still owed.
   */
  async sweepPendingDeletions(limit = 200): Promise<{ swept: number; failed: number }> {
    let swept = 0;
    let failed = 0;
    for (const entry of await this.pendingObjectDeletions(limit)) {
      if (await this.sweepOne(entry.objectKey)) swept += 1;
      else failed += 1;
    }
    return { swept, failed };
  }

  async pendingObjectDeletions(limit: number): Promise<Array<{ objectKey: string; attempts: number }>> {
    const { rows } = await this.driver.query<{ object_key: string; attempts: number }>(
      // Fewest attempts first: a key that keeps failing — a bucket permission
      // problem, a key the provider will not accept — must not sit at the head
      // of the queue starving every deletion enqueued after it.
      "SELECT object_key, attempts FROM pending_object_deletions ORDER BY attempts, enqueued_at LIMIT $1",
      [Math.max(1, Math.min(limit, 1000))],
    );
    return rows.map((r) => ({ objectKey: r.object_key, attempts: Number(r.attempts) }));
  }

  async resolveObjectDeletion(objectKey: string): Promise<void> {
    await this.driver.query("DELETE FROM pending_object_deletions WHERE object_key = $1", [objectKey]);
  }

  async failObjectDeletion(objectKey: string): Promise<void> {
    await this.driver.query(
      "UPDATE pending_object_deletions SET attempts = attempts + 1, last_error_at = now() WHERE object_key = $1",
      [objectKey],
    );
  }

  async addPhoto(p: {
    id: string;
    intakeId: string;
    practiceId: string;
    objectKey: string;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    kind: string;
    caption: string;
    advisories: string[];
    idempotencyKey: string | null;
  }): Promise<{ id: string; created: boolean }> {
    // A retried upload carries the same idempotency key, and the partial
    // unique index turns the second insert into a no-op rather than a
    // duplicate photo. DO NOTHING then re-select, so the caller learns the id
    // of the row that actually exists.
    const { rows } = await this.driver.query<{ id: string }>(
      `INSERT INTO photos (id, intake_id, practice_id, object_key, mime, bytes, width, height,
                           kind, caption, advisories, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        p.id, p.intakeId, p.practiceId, p.objectKey, p.mime, p.bytes, p.width, p.height,
        p.kind, p.caption, JSON.stringify(p.advisories), p.idempotencyKey,
      ],
    );
    if (rows[0]) return { id: rows[0].id, created: true };

    if (p.idempotencyKey) {
      const { rows: existing } = await this.driver.query<{ id: string }>(
        "SELECT id FROM photos WHERE intake_id = $1 AND idempotency_key = $2",
        [p.intakeId, p.idempotencyKey],
      );
      if (existing[0]) return { id: existing[0].id, created: false };
    }
    throw new AppError("INTERNAL", "photo insert conflicted without an idempotency key");
  }

  async photoForAccess(
    photoId: string,
  ): Promise<{ id: string; intakeId: string; practiceId: string; objectKey: string; mime: string } | null> {
    const { rows } = await this.driver.query<Record<string, unknown>>(
      `SELECT id, intake_id, practice_id, object_key, mime FROM photos
        WHERE id = $1 AND deleted_at IS NULL`,
      [photoId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      intakeId: String(r.intake_id),
      practiceId: String(r.practice_id),
      objectKey: String(r.object_key),
      mime: String(r.mime),
    };
  }

  async deletePhoto(photoId: string): Promise<{ objectKey: string } | null> {
    const { rows } = await this.driver.query<{ object_key: string }>(
      "DELETE FROM photos WHERE id = $1 RETURNING object_key",
      [photoId],
    );
    return rows[0] ? { objectKey: rows[0].object_key } : null;
  }

  async photoCount(intakeId: string): Promise<number> {
    const { rows } = await this.driver.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM photos WHERE intake_id = $1 AND deleted_at IS NULL",
      [intakeId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  // --- Audit ---------------------------------------------------------------

  async appendAudit(event: Omit<AuditEvent, "id" | "at"> & { at?: string }): Promise<void> {
    await this.driver.query(
      `INSERT INTO audit_events (at, action, actor_kind, actor_id, practice_id, resource, resource_id, request_id, meta)
       VALUES (COALESCE($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        event.at ?? null,
        event.action,
        event.actorKind,
        event.actorId,
        event.practiceId,
        event.resource,
        event.resourceId,
        event.requestId,
        JSON.stringify(event.meta ?? {}),
      ],
    );
  }

  async readAudit(filter: { practiceId?: string; intakeId?: string; limit?: number }): Promise<AuditEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.practiceId) {
      params.push(filter.practiceId);
      where.push(`practice_id = $${params.length}`);
    }
    if (filter.intakeId) {
      params.push(filter.intakeId);
      where.push(`resource_id = $${params.length}`);
    }
    params.push(Math.min(filter.limit ?? 200, 1000));
    const { rows } = await this.driver.query<Record<string, unknown>>(
      `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: String(r.id),
      at: iso(r.at) ?? "",
      action: String(r.action) as AuditEvent["action"],
      actorKind: String(r.actor_kind) as AuditEvent["actorKind"],
      actorId: r.actor_id ? String(r.actor_id) : null,
      practiceId: r.practice_id ? String(r.practice_id) : null,
      resource: String(r.resource),
      resourceId: r.resource_id ? String(r.resource_id) : null,
      requestId: r.request_id ? String(r.request_id) : null,
      meta: (typeof r.meta === "string" ? JSON.parse(r.meta) : (r.meta ?? {})) as AuditEvent["meta"],
    }));
  }

  // --- Clinicians ----------------------------------------------------------

  async clinicianByEmail(email: string): Promise<(ClinicianAccount & { passwordHash: string }) | null> {
    const { rows } = await this.driver.query<Record<string, unknown>>(
      `SELECT id, practice_id, email, display_name, credential, password_hash, disabled_at, session_epoch
         FROM clinicians WHERE lower(email) = lower($1)`,
      [email],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      practiceId: String(r.practice_id),
      email: String(r.email),
      displayName: String(r.display_name),
      credential: String(r.credential ?? ""),
      disabledAt: iso(r.disabled_at),
      sessionEpoch: Number(r.session_epoch ?? 0),
      passwordHash: String(r.password_hash),
    };
  }

  async clinicianById(id: string): Promise<ClinicianAccount | null> {
    const { rows } = await this.driver.query<Record<string, unknown>>(
      `SELECT id, practice_id, email, display_name, credential, disabled_at, session_epoch
         FROM clinicians WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      practiceId: String(r.practice_id),
      email: String(r.email),
      displayName: String(r.display_name),
      credential: String(r.credential ?? ""),
      disabledAt: iso(r.disabled_at),
      sessionEpoch: Number(r.session_epoch ?? 0),
    };
  }

  async bumpSessionEpoch(clinicianId: string): Promise<number> {
    const { rows } = await this.driver.query<{ session_epoch: number }>(
      "UPDATE clinicians SET session_epoch = session_epoch + 1 WHERE id = $1 RETURNING session_epoch",
      [clinicianId],
    );
    return Number(rows[0]?.session_epoch ?? 0);
  }

  // --- Reference data ------------------------------------------------------

  async getPractice(id: string): Promise<Practice | null> {
    const { rows } = await this.driver.query<Record<string, unknown>>(
      "SELECT id, name FROM practices WHERE id = $1",
      [id],
    );
    const r = rows[0];
    return r
      ? { id: String(r.id), name: String(r.name), clinicianName: "", clinicianCredential: "" }
      : null;
  }

  async getVisit(id: string): Promise<Visit | null> {
    const { rows } = await this.driver.query<Record<string, unknown>>(
      "SELECT id, practice_id, patient_id, scheduled_for, reason_booked, location FROM visits WHERE id = $1",
      [id],
    );
    const r = rows[0];
    return r
      ? {
          id: String(r.id),
          practiceId: String(r.practice_id),
          patientId: String(r.patient_id),
          scheduledFor: iso(r.scheduled_for) ?? "",
          reasonBooked: String(r.reason_booked ?? ""),
          location: String(r.location ?? ""),
        }
      : null;
  }

  async getPatient(id: string): Promise<Patient | null> {
    const { rows } = await this.driver.query<Record<string, unknown>>(
      "SELECT id, first_name, last_name, date_of_birth FROM patients WHERE id = $1",
      [id],
    );
    const r = rows[0];
    return r
      ? {
          id: String(r.id),
          firstName: String(r.first_name),
          lastName: String(r.last_name),
          dateOfBirth: (iso(r.date_of_birth) ?? "").slice(0, 10),
        }
      : null;
  }
}
