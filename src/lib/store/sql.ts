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

  constructor(driver: Driver, opts: { pepper: string; objects?: ObjectStore | null }) {
    this.driver = driver;
    this.pepper = opts.pepper;
    this.objects = opts.objects ?? null;
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
              t.failed_verifications, i.visit_id
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

  /** Issues a fresh token, replacing any existing one for this intake. */
  async issueToken(intakeId: string, practiceId: string, rawToken: string, expiresAt: string): Promise<void> {
    await this.driver.query(
      `INSERT INTO patient_tokens (intake_id, practice_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (intake_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at,
             revoked_at = NULL, verified_at = NULL, failed_verifications = 0`,
      [intakeId, practiceId, hashToken(rawToken, this.pepper), expiresAt],
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

      const current = toIntake(rows[0]);
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
          toDocument(intake),
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
    return this.driver.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "SELECT id FROM intakes WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!rows[0]) return { deleted: false, photoKeys: [] };

      // Collected before the delete so the caller can remove the objects; a
      // key we forget here is a photo that outlives its record.
      const { rows: keys } = await tx.query<{ object_key: string }>(
        "SELECT object_key FROM photos WHERE intake_id = $1",
        [id],
      );
      // ON DELETE CASCADE removes photos and the patient token. Audit events
      // are not children of the intake and deliberately survive: they are the
      // record that the deletion happened.
      await tx.query("DELETE FROM intakes WHERE id = $1", [id]);
      return { deleted: true, photoKeys: keys.map((k) => k.object_key) };
    });
  }

  async intakesPastRetention(now: Date): Promise<Array<{ id: string; practiceId: string }>> {
    const { rows } = await this.driver.query<{ id: string; practice_id: string }>(
      `SELECT id, practice_id FROM intakes
        WHERE deleted_at IS NULL AND submitted_at IS NOT NULL
          AND submitted_at < $1`,
      [now.toISOString()],
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
   * The row is written before the object, and the object put is idempotent by
   * key: a failure between the two leaves a row pointing at a missing object,
   * which shows as a broken photo and is cleaned by retention — a recoverable
   * inconsistency. The reverse (an object with no row) would be an invisible
   * orphan that nothing ever reclaims.
   */
  async attachPhoto(intakeId: string, practiceId: string, input: PhotoInput): Promise<PhotoResult> {
    if (!this.objects) throw new AppError("INTERNAL", "object store not configured");
    const objects = this.objects;

    return this.driver.transaction(async (tx) => {
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
      if (!objectKey && input.idempotencyKey) {
        const { rows: existing } = await tx.query<{ object_key: string }>(
          "SELECT object_key FROM photos WHERE intake_id = $1 AND idempotency_key = $2",
          [intakeId, input.idempotencyKey],
        );
        objectKey = existing[0]?.object_key;
      }
      if (!objectKey) throw new AppError("INTERNAL", "photo insert conflicted without an idempotency key");

      await objects.put(objectKey, dataUrlToBytes(input.dataUrl), input.mime);
      return { ok: true, bundle: await refreshed() };
    });
  }

  async removePhoto(intakeId: string, photoId: string): Promise<IntakeBundle> {
    if (!this.objects) throw new AppError("INTERNAL", "object store not configured");
    const objects = this.objects;

    return this.driver.transaction(async (tx) => {
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
        // The object goes after the row, and a missing object is not an error:
        // deletion converges to "gone" whichever operation the failure hit.
        if (del[0]) await objects.delete(del[0].object_key).catch(() => false);
      }

      const b = await this.assemble(tx, rows[0]);
      if (!b) throw new AppError("INTERNAL", "intake has no bundle");
      return b;
    });
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
      `SELECT id, practice_id, email, display_name, credential, password_hash, disabled_at
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
      passwordHash: String(r.password_hash),
    };
  }

  async clinicianById(id: string): Promise<ClinicianAccount | null> {
    const { rows } = await this.driver.query<Record<string, unknown>>(
      `SELECT id, practice_id, email, display_name, credential, disabled_at
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
    };
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
