/**
 * Synthetic pilot seed.
 *
 * Two practices, because a single-tenant seed cannot demonstrate that tenancy
 * works — every cross-practice test in the suite needs a second practice with
 * records the first must not be able to see.
 *
 * Every token lifecycle state is represented, so the authorization tests have
 * something real to attack rather than constructing fixtures inline:
 *
 *   live      not started, token valid            → the normal case
 *   active    in progress, token valid
 *   submitted ready for review, token still valid → freeze-on-submit
 *   expired   token past its expiry               → 410
 *   revoked   token revoked by the practice       → 410
 *   reviewed  clinician finished with it
 *
 * SYNTHETIC ONLY. Names, dates of birth and complaints are invented. Nothing
 * here may ever be run against a database holding real patients — hence the
 * explicit confirmation flag on the CLI.
 */

import { blankIntake } from "@/lib/demo/seed";
import type { Driver } from "./driver";
import { hashPassword } from "@/lib/auth/password";
import { hashToken } from "@/lib/patient/token";
import type { Intake } from "@/lib/domain/types";

export interface SeededToken {
  label: string;
  intakeId: string;
  practiceId: string;
  rawToken: string;
  state: "live" | "active" | "submitted" | "expired" | "revoked" | "reviewed";
}

export interface PilotSeed {
  practices: Array<{ id: string; name: string }>;
  clinicians: Array<{ id: string; email: string; password: string; practiceId: string }>;
  tokens: SeededToken[];
}

/** Fixed so the seed is reproducible and tests can name a token. */
const RAW_TOKENS: Record<string, string> = {
  live: "seed-live-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  active: "seed-active-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  submitted: "seed-submitted-token-cccccccccccccccccccccccccc",
  expired: "seed-expired-token-dddddddddddddddddddddddddddd",
  revoked: "seed-revoked-token-eeeeeeeeeeeeeeeeeeeeeeeeeeee",
  reviewed: "seed-reviewed-token-ffffffffffffffffffffffffffff",
  other: "seed-otherpractice-token-gggggggggggggggggggggggg",
};

/** The password for every seeded account. Synthetic data, stated plainly. */
export const SEED_PASSWORD = "SyntheticPilot1";

interface IntakeSpec {
  id: string;
  practiceId: string;
  visitId: string;
  tokenLabel: string;
  state: SeededToken["state"];
  concern: string;
  pathway: Intake["pathway"];
}

export async function seedPilot(driver: Driver, pepper: string): Promise<PilotSeed> {
  const now = new Date();
  const hours = (n: number) => new Date(now.getTime() + n * 3600_000).toISOString();

  await driver.transaction(async (tx) => {
    // Idempotent: re-running the seed replaces it rather than doubling it.
    await tx.query("DELETE FROM audit_events");
    await tx.query("DELETE FROM intakes");
    await tx.query("DELETE FROM visits");
    await tx.query("DELETE FROM patients");
    await tx.query("DELETE FROM clinicians");
    await tx.query("DELETE FROM practices");
  });

  const practices = [
    { id: "prac_northgate", name: "Northgate Dermatology" },
    { id: "prac_riverside", name: "Riverside Skin Clinic" },
  ];
  for (const p of practices) {
    await driver.query("INSERT INTO practices (id, name) VALUES ($1, $2)", [p.id, p.name]);
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const clinicians = [
    { id: "cli_okonkwo", email: "okonkwo@northgate.example", name: "A. Okonkwo", cred: "MD", practiceId: "prac_northgate" },
    { id: "cli_bell", email: "bell@northgate.example", name: "J. Bell", cred: "PA-C", practiceId: "prac_northgate" },
    { id: "cli_navarro", email: "navarro@riverside.example", name: "L. Navarro", cred: "MD", practiceId: "prac_riverside" },
  ];
  for (const c of clinicians) {
    await driver.query(
      `INSERT INTO clinicians (id, practice_id, email, display_name, credential, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [c.id, c.practiceId, c.email, c.name, c.cred, passwordHash],
    );
  }

  const patients = [
    { id: "pat_ellison", practiceId: "prac_northgate", first: "Maya", last: "Ellison", dob: "1991-04-12" },
    { id: "pat_osei", practiceId: "prac_northgate", first: "Robert", last: "Osei", dob: "1962-11-03" },
    { id: "pat_raman", practiceId: "prac_northgate", first: "Priya", last: "Raman", dob: "1989-07-22" },
    { id: "pat_whitaker", practiceId: "prac_northgate", first: "Daniel", last: "Whitaker", dob: "2007-02-18" },
    { id: "pat_okafor", practiceId: "prac_northgate", first: "Lena", last: "Okafor", dob: "1978-09-30" },
    { id: "pat_dacosta", practiceId: "prac_riverside", first: "Tomas", last: "da Costa", dob: "1984-01-25" },
  ];
  for (const p of patients) {
    await driver.query(
      "INSERT INTO patients (id, practice_id, first_name, last_name, date_of_birth) VALUES ($1,$2,$3,$4,$5)",
      [p.id, p.practiceId, p.first, p.last, p.dob],
    );
  }

  const specs: Array<IntakeSpec & { patientId: string; when: string; reason: string }> = [
    { id: "int_live", practiceId: "prac_northgate", visitId: "vis_live", patientId: "pat_whitaker", tokenLabel: "live", state: "live", concern: "", pathway: "general", when: hours(26), reason: "Acne review" },
    { id: "int_active", practiceId: "prac_northgate", visitId: "vis_active", patientId: "pat_ellison", tokenLabel: "active", state: "active", concern: "Itchy rash on both arms", pathway: "rash", when: hours(4), reason: "Rash" },
    { id: "int_submitted", practiceId: "prac_northgate", visitId: "vis_submitted", patientId: "pat_osei", tokenLabel: "submitted", state: "submitted", concern: "Dark spot on upper back", pathway: "lesion", when: hours(2), reason: "Spot of concern" },
    { id: "int_expired", practiceId: "prac_northgate", visitId: "vis_expired", patientId: "pat_okafor", tokenLabel: "expired", state: "expired", concern: "", pathway: "general", when: hours(-48), reason: "General dermatology" },
    { id: "int_revoked", practiceId: "prac_northgate", visitId: "vis_revoked", patientId: "pat_raman", tokenLabel: "revoked", state: "revoked", concern: "", pathway: "general", when: hours(30), reason: "Hair loss" },
    { id: "int_reviewed", practiceId: "prac_northgate", visitId: "vis_reviewed", patientId: "pat_raman", tokenLabel: "reviewed", state: "reviewed", concern: "Hair thinning since March", pathway: "hair_loss", when: hours(-6), reason: "Hair loss" },
    { id: "int_other", practiceId: "prac_riverside", visitId: "vis_other", patientId: "pat_dacosta", tokenLabel: "other", state: "submitted", concern: "Scaly patches on elbows", pathway: "rash", when: hours(3), reason: "Rash" },
  ];

  const tokens: SeededToken[] = [];

  for (const s of specs) {
    await driver.query(
      "INSERT INTO visits (id, practice_id, patient_id, scheduled_for, reason_booked, location) VALUES ($1,$2,$3,$4,$5,$6)",
      [s.visitId, s.practiceId, s.patientId, s.when, s.reason, "Main clinic"],
    );

    const base = blankIntake(s.visitId);
    const status: Intake["status"] =
      s.state === "live" || s.state === "expired" || s.state === "revoked"
        ? "not_started"
        : s.state === "active"
          ? "in_progress"
          : s.state === "reviewed"
            ? "reviewed"
            : "ready_for_review";

    const intake: Intake = {
      ...base,
      id: s.id,
      visitId: s.visitId,
      status,
      pathway: s.pathway,
      questionCount: status === "not_started" ? 0 : 4,
      startedAt: status === "not_started" ? undefined : hours(-1),
      submittedAt: status === "ready_for_review" || status === "reviewed" ? hours(-0.5) : undefined,
      facts: s.concern
        ? [
            {
              slot: "concern",
              value: s.concern,
              verbatim: s.concern,
              certainty: "stated",
              source: "patient",
              at: hours(-1),
            },
          ]
        : [],
      messages: s.concern
        ? [
            { id: "msg_q", role: "assistant", text: "What would you most like the dermatologist to help you with?", at: hours(-1), targets: ["concern"] },
            { id: "msg_a", role: "patient", text: s.concern, at: hours(-1), targets: [], inputMode: "text" },
          ]
        : [],
    };

    await driver.query(
      `INSERT INTO intakes (id, practice_id, visit_id, status, pathway, urgent_flag, document, started_at, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [
        s.id, s.practiceId, s.visitId, intake.status, intake.pathway, intake.urgentFlag,
        JSON.stringify(intake), intake.startedAt ?? null, intake.submittedAt ?? null,
      ],
    );

    const rawToken = RAW_TOKENS[s.tokenLabel];
    const expiresAt = s.state === "expired" ? hours(-1) : hours(72);
    await driver.query(
      `INSERT INTO patient_tokens (intake_id, practice_id, token_hash, expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [s.id, s.practiceId, hashToken(rawToken, pepper), expiresAt, s.state === "revoked" ? hours(-2) : null],
    );

    tokens.push({ label: s.tokenLabel, intakeId: s.id, practiceId: s.practiceId, rawToken, state: s.state });
  }

  return {
    practices,
    clinicians: clinicians.map((c) => ({
      id: c.id,
      email: c.email,
      password: SEED_PASSWORD,
      practiceId: c.practiceId,
    })),
    tokens,
  };
}
