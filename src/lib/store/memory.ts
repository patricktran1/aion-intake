/**
 * Demo adapter.
 *
 * The synthetic demo, unchanged in behaviour: one in-process map, seeded on
 * first touch, reset by a button. It implements the full Store interface so
 * that routes are written once, but several pilot concepts are deliberately
 * inert here:
 *
 *   - Tokens never expire and are stored in the clear, because a demo link
 *     printed on a QR code has to keep working and there is nothing to protect.
 *   - Verification always passes. A conference demo cannot ask a stranger for
 *     a synthetic patient's date of birth.
 *   - Audit events are kept in memory for tests to assert against, and dropped
 *     on reset with everything else.
 *
 * Each of those is a difference the pilot adapter does NOT share, which is why
 * the two are separate files rather than one file with flags.
 */

import type { Intake, IntakeBundle, Patient, Photo, Practice, Visit } from "@/lib/domain/types";
import { MAX_PHOTOS } from "@/lib/photos";
import { seedData } from "@/lib/demo/seed";
import { withIntakeLock } from "./lock";
import type {
  AccessResult,
  AuditEvent,
  ClinicianAccount,
  PhotoInput,
  PhotoResult,
  Store,
} from "./types";

export interface MemoryDb {
  practices: Map<string, Practice>;
  patients: Map<string, Patient>;
  visits: Map<string, Visit>;
  intakes: Map<string, Intake>;
  audit: AuditEvent[];
  seededAt: string;
}

const globalForDb = globalThis as unknown as { __aionDb?: MemoryDb };

export function db(): MemoryDb {
  const existing = globalForDb.__aionDb;
  if (existing) return existing;
  const fresh: MemoryDb = { ...seedData(), audit: [] };
  globalForDb.__aionDb = fresh;
  return fresh;
}

export function resetDb(): MemoryDb {
  const fresh: MemoryDb = { ...seedData(), audit: [] };
  globalForDb.__aionDb = fresh;
  return fresh;
}

// --- Synchronous helpers, kept because the demo UI and tests use them -------

export function getIntake(id: string): Intake | undefined {
  return db().intakes.get(id);
}

export function getIntakeByToken(token: string): Intake | undefined {
  for (const intake of db().intakes.values()) {
    if (intake.token === token) return intake;
  }
  return undefined;
}

export function saveIntake(intake: Intake): Intake {
  const next = { ...intake, lastActivityAt: new Date().toISOString() };
  // An in-flight request that started before a demo reset must not resurrect
  // its stale intake into the fresh store — every intake id is minted by the
  // seed, so an id the current store does not know belongs to a previous life.
  if (!db().intakes.has(next.id)) return next;
  db().intakes.set(next.id, next);
  return next;
}

export function bundleFor(intake: Intake): IntakeBundle | null {
  const d = db();
  const visit = d.visits.get(intake.visitId);
  if (!visit) return null;
  const patient = d.patients.get(visit.patientId);
  const practice = d.practices.get(visit.practiceId);
  if (!patient || !practice) return null;
  return { intake, visit, patient, practice };
}

export function bundleByToken(token: string): IntakeBundle | null {
  const intake = getIntakeByToken(token);
  return intake ? bundleFor(intake) : null;
}

export function bundleById(id: string): IntakeBundle | null {
  const intake = getIntake(id);
  return intake ? bundleFor(intake) : null;
}

/** Clinician list: unreviewed first, then by appointment time. */
export function listBundles(): IntakeBundle[] {
  const order: Record<Intake["status"], number> = {
    ready_for_review: 0,
    in_progress: 1,
    not_started: 2,
    reviewed: 3,
  };
  return [...db().intakes.values()]
    .map(bundleFor)
    .filter((b): b is IntakeBundle => b !== null)
    .sort((a, b) => {
      const s = order[a.intake.status] - order[b.intake.status];
      if (s !== 0) return s;
      return new Date(a.visit.scheduledFor).getTime() - new Date(b.visit.scheduledFor).getTime();
    });
}

// --- The Store implementation ----------------------------------------------

let auditSeq = 0;

export class MemoryStore implements Store {
  readonly kind = "memory" as const;

  async init(): Promise<void> {
    db();
  }
  async close(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }

  async getIntake(id: string): Promise<Intake | null> {
    return getIntake(id) ?? null;
  }

  async bundleById(id: string): Promise<IntakeBundle | null> {
    return bundleById(id);
  }

  async bundleForClinician(id: string, practiceId: string): Promise<IntakeBundle | null> {
    const b = bundleById(id);
    // Even in the demo the tenant check is real: the seed has one practice, so
    // this always passes, but a route relying on it is exercised either way.
    if (!b || b.practice.id !== practiceId) return null;
    return b;
  }

  async listBundles(practiceId: string | null): Promise<IntakeBundle[]> {
    const all = listBundles();
    return practiceId ? all.filter((b) => b.practice.id === practiceId) : all;
  }

  async resolveToken(rawToken: string): Promise<AccessResult> {
    const intake = getIntakeByToken(rawToken);
    if (!intake) return { ok: false, reason: "not_found" };
    const b = bundleFor(intake);
    if (!b) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      access: {
        intakeId: intake.id,
        practiceId: b.practice.id,
        visitId: intake.visitId,
        // Demo links must survive a conference. They do not expire, and this
        // is the one place where demo and pilot semantics genuinely differ.
        expiresAt: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
        revokedAt: null,
        verifiedAt: new Date(0).toISOString(),
        failedVerifications: 0,
      },
    };
  }

  async bundleForToken(rawToken: string): Promise<IntakeBundle | null> {
    return bundleByToken(rawToken);
  }

  async markVerified(): Promise<void> {}
  async recordVerificationFailure(): Promise<number> {
    return 0;
  }
  async revokeToken(): Promise<void> {}

  async withIntake<T>(
    id: string,
    mutate: (intake: Intake) => Promise<{ intake: Intake | null; result: T }>,
  ): Promise<T> {
    return withIntakeLock(id, async () => {
      const current = getIntake(id);
      if (!current) throw new Error(`intake ${id} not found`);
      const { intake, result } = await mutate(current);
      if (intake) saveIntake(intake);
      return result;
    });
  }

  async attachPhoto(intakeId: string, _practiceId: string, input: PhotoInput): Promise<PhotoResult> {
    return withIntakeLock(intakeId, async () => {
      const intake = getIntake(intakeId);
      if (!intake) throw new Error(`intake ${intakeId} not found`);
      const bundle = bundleFor(intake);
      if (!bundle) throw new Error(`intake ${intakeId} has no bundle`);
      if (intake.status === "ready_for_review" || intake.status === "reviewed") {
        return { ok: false, reason: "frozen", bundle };
      }
      if (intake.photos.length >= MAX_PHOTOS) {
        return { ok: false, reason: "limit", bundle };
      }
      // Demo photos are the data URL itself, inside the intake document. Nothing
      // reaches an object store — there is nothing real to protect.
      const photo: Photo = {
        id: `pho_${Math.random().toString(36).slice(2, 12)}`,
        kind: input.kind as Photo["kind"],
        mime: input.mime,
        bytes: input.bytes,
        width: input.width,
        height: input.height,
        dataUrl: input.dataUrl,
        caption: input.caption,
        advisories: input.advisories,
        at: new Date().toISOString(),
      };
      const saved = saveIntake({ ...intake, photos: [...intake.photos, photo].slice(0, MAX_PHOTOS) });
      return { ok: true, bundle: { ...bundle, intake: saved } };
    });
  }

  async removePhoto(intakeId: string, photoId: string): Promise<IntakeBundle> {
    return withIntakeLock(intakeId, async () => {
      const intake = getIntake(intakeId);
      if (!intake) throw new Error(`intake ${intakeId} not found`);
      const bundle = bundleFor(intake);
      if (!bundle) throw new Error(`intake ${intakeId} has no bundle`);
      if (intake.status === "ready_for_review" || intake.status === "reviewed") return bundle;
      const saved = saveIntake({ ...intake, photos: intake.photos.filter((p) => p.id !== photoId) });
      return { ...bundle, intake: saved };
    });
  }

  async deleteIntake(id: string): Promise<{ deleted: boolean; photoKeys: string[] }> {
    return withIntakeLock(id, async () => {
      const intake = getIntake(id);
      if (!intake) return { deleted: false, photoKeys: [] };
      // Demo photos are data URLs inside the record, so there is nothing in an
      // object store to reconcile; the record going away is the whole deletion.
      db().intakes.delete(id);
      return { deleted: true, photoKeys: [] };
    });
  }

  async intakesPastRetention(): Promise<Array<{ id: string; practiceId: string }>> {
    return [];
  }
  async photosPastRetention(): Promise<Array<{ intakeId: string; photoId: string; objectKey: string }>> {
    return [];
  }

  async appendAudit(event: Omit<AuditEvent, "id" | "at"> & { at?: string }): Promise<void> {
    auditSeq += 1;
    db().audit.push({
      id: `aud_mem_${auditSeq}`,
      at: event.at ?? new Date().toISOString(),
      ...event,
    });
  }

  async readAudit(filter: {
    practiceId?: string;
    intakeId?: string;
    limit?: number;
  }): Promise<AuditEvent[]> {
    let rows = [...db().audit];
    if (filter.practiceId) rows = rows.filter((r) => r.practiceId === filter.practiceId);
    if (filter.intakeId) rows = rows.filter((r) => r.resourceId === filter.intakeId);
    rows.reverse();
    return rows.slice(0, filter.limit ?? 200);
  }

  async clinicianByEmail(): Promise<(ClinicianAccount & { passwordHash: string }) | null> {
    // The demo has no accounts; the middleware passphrase is its whole gate.
    return null;
  }
  async clinicianById(): Promise<ClinicianAccount | null> {
    return null;
  }

  async getPractice(id: string): Promise<Practice | null> {
    return db().practices.get(id) ?? null;
  }
  async getVisit(id: string): Promise<Visit | null> {
    return db().visits.get(id) ?? null;
  }
  async getPatient(id: string): Promise<Patient | null> {
    return db().patients.get(id) ?? null;
  }
}
