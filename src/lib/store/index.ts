import type { Intake, IntakeBundle, Patient, Practice, Visit } from "@/lib/domain/types";
import { seedData } from "@/lib/demo/seed";

/**
 * Storage.
 *
 * One in-process store behind a narrow interface, seeded with synthetic demo
 * data on first touch. This is a deliberate pre-product-market-fit choice: zero
 * infrastructure, zero fixed cost, zero operational burden, and no real patient
 * data anywhere near it.
 *
 * Swapping in Postgres or Turso means implementing the eight functions below.
 * Nothing else in the codebase touches persistence. See SECURITY.md for what
 * must be true before this holds anything real.
 */

export interface Db {
  practices: Map<string, Practice>;
  patients: Map<string, Patient>;
  visits: Map<string, Visit>;
  intakes: Map<string, Intake>;
  seededAt: string;
}

const globalForDb = globalThis as unknown as { __aionDb?: Db };

export function db(): Db {
  if (!globalForDb.__aionDb) {
    globalForDb.__aionDb = seedData();
  }
  return globalForDb.__aionDb;
}

export function resetDb(): Db {
  globalForDb.__aionDb = seedData();
  return globalForDb.__aionDb;
}

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

/** Clinician list: newest activity first, unreviewed before reviewed. */
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
