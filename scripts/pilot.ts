/**
 * Pilot operations CLI.
 *
 *   npm run db:migrate            apply migrations
 *   npm run db:seed -- --confirm  load the synthetic pilot seed
 *   npm run pilot:check           technical readiness report
 *   npm run pilot:retention       delete records past their retention window
 *   npm run pilot:reconcile       drain the deletion outbox (photo bytes still owed)
 *   npm run pilot:code -- --intake=int_x   issue a second-factor code for one intake
 *   npm run pilot:invite -- --practice=... --first=... --last=... --dob=... --when=...
 *   npm run pilot:clinician -- --practice=... --email=... --name=...   (password from env)
 *
 * Every command works against whatever DATABASE_URL names: a real Postgres
 * server, or in-process Postgres via the "pglite:<dir>" scheme, which is what
 * the local pilot workflow uses so a developer needs no database server.
 */

import { migrate, isUpToDate, loadMigrations } from "@/lib/db/migrate";
import { pgliteDriver } from "@/lib/db/pglite";
import { seedPilot, SEED_PASSWORD } from "@/lib/db/seed-pilot";
import { SqlStore } from "@/lib/store/sql";
import { LocalObjectStore } from "@/lib/objects/local";
import { objectStore } from "@/lib/objects/select";
import { readConfig, ConfigError } from "@/lib/config/runtime";
import type { Driver } from "@/lib/db/driver";

const args = process.argv.slice(2);
const command = args[0] ?? "check";
const has = (flag: string) => args.includes(flag);

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function openDriver(): Promise<Driver> {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (url.startsWith("pglite:")) {
    const dir = url.slice("pglite:".length) || ".pglite";
    process.stderr.write(`using in-process Postgres at ${dir}\n`);
    // In-process means in THIS process. A running dev server holds its own
    // handle on the same directory with its own cache, so a change made here
    // is not visible there until it restarts — and two writers on one PGlite
    // directory is not a supported arrangement. Worth saying out loud: the
    // symptom is a command that reports success and appears to have done
    // nothing, which is a confusing hour.
    process.stderr.write(
      yellow("stop any running dev:pilot server first — pglite is single-writer\n"),
    );
    return pgliteDriver(dir);
  }
  if (!url) throw new Error("DATABASE_URL is not set");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 4 });
  const { driverFrom } = await import("@/lib/db/driver");
  return driverFrom(
    {
      query: async (sql: string, params?: unknown[]) => {
        const res = await pool.query(sql, params as never[]);
        return { rows: res.rows, rowCount: res.rowCount ?? 0 };
      },
      // Without this a transaction is spread across the pool: BEGIN on one
      // connection, the work on others. The migration and restore commands both
      // rely on a transaction meaning something.
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, params?: unknown[]) => {
            const res = await client.query(sql, params as never[]);
            return { rows: res.rows, rowCount: res.rowCount ?? 0 };
          },
          release: () => client.release(),
        };
      },
      close: () => pool.end(),
    },
    { exclusive: false },
  );
}

async function cmdMigrate(): Promise<number> {
  const driver = await openDriver();
  try {
    const res = await migrate(driver);
    if (res.applied.length === 0) console.log(`Schema already current (${res.alreadyApplied.length} migrations).`);
    else console.log(`Applied ${res.applied.length}: ${res.applied.join(", ")}`);
    return 0;
  } finally {
    await driver.close();
  }
}

async function cmdSeed(): Promise<number> {
  // The seed deletes everything before writing. Making that require an
  // explicit flag is the difference between a development convenience and an
  // afternoon spent restoring a backup.
  if (!has("--confirm")) {
    console.error(
      red("Refusing to seed without --confirm.") +
        "\nThis DELETES every practice, patient, visit, intake and audit row in the target database." +
        "\nSynthetic data only — never run this against a database holding real patients.",
    );
    return 1;
  }
  const pepper = process.env.AION_TOKEN_PEPPER ?? "";
  if (pepper.length < 32) {
    console.error(red("AION_TOKEN_PEPPER must be set (32+ chars) so seeded tokens hash the same way the app will."));
    return 1;
  }

  const driver = await openDriver();
  try {
    await migrate(driver);
    const seed = await seedPilot(driver, pepper);
    console.log(`\n${green("Synthetic pilot seeded.")}\n`);
    console.log("Practices:");
    for (const p of seed.practices) console.log(`  ${p.id.padEnd(18)} ${p.name}`);
    console.log(`\nClinicians (password: ${SEED_PASSWORD}):`);
    for (const c of seed.clinicians) console.log(`  ${c.email.padEnd(32)} ${c.practiceId}`);
    console.log("\nPatient links by lifecycle state:");
    for (const t of seed.tokens) {
      console.log(`  ${t.state.padEnd(10)} ${t.intakeId.padEnd(16)} /intake/${t.rawToken}`);
    }
    console.log("\nAll synthetic. Nothing here describes a real person.\n");
    return 0;
  } finally {
    await driver.close();
  }
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** False for checks that are informational rather than blocking. */
  blocking: boolean;
}

async function cmdCheck(): Promise<number> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, blocking = true) =>
    checks.push({ name, ok, detail, blocking });

  // 1. Configuration parses and is a pilot.
  let cfg: ReturnType<typeof readConfig> | null = null;
  try {
    cfg = readConfig();
    add("configuration valid", true, `mode=${cfg.mode}`);
  } catch (err) {
    const problems = err instanceof ConfigError ? err.problems : [String(err)];
    add("configuration valid", false, problems.join("; "));
  }

  if (cfg?.mode !== "pilot") {
    add(
      "runtime mode",
      false,
      "AION_RUNTIME_MODE is not 'pilot' — this check reports on pilot prerequisites",
    );
  } else {
    add("runtime mode", true, "pilot");
    add("session secret configured", cfg.pilot!.sessionSecret.length >= 32, "AION_SESSION_SECRET");
    add("token pepper configured", cfg.pilot!.tokenPepper.length >= 32, "AION_TOKEN_PEPPER");
    add(
      "retention policy chosen",
      cfg.pilot!.photoRetentionDays > 0 && cfg.pilot!.intakeRetentionDays > 0,
      `photos ${cfg.pilot!.photoRetentionDays}d, intakes ${cfg.pilot!.intakeRetentionDays}d ` +
        "(a configured value, NOT a legal determination)",
    );

    const factor = cfg.pilot!.patientSecondFactor;
    add(
      "patient second factor chosen",
      true,
      factor === "dob"
        ? "date of birth — a weak factor that stops a forwarded link, not a determined party"
        : factor === "code"
          ? "practice-issued code — the practice must actually issue one per visit, or patients are locked out"
          : "one-time code",
    );
    if (factor === "otp") {
      // The only delivery adapter that ships prints the code to the log.
      add(
        "one-time code delivery",
        false,
        "no delivery provider is integrated — the console adapter prints codes to the server log",
      );
    }

    // 2. Database reachable and migrated.
    try {
      const driver = await openDriver();
      try {
        const store = new SqlStore(driver, { pepper: cfg.pilot!.tokenPepper });
        // The password is masked: this output goes into terminals, tickets
        // and screenshots.
        add("database reachable", await store.ping(), cfg.pilot!.databaseUrl.replace(/:[^:@/]+@/, ":***@"));
        if (cfg.pilot!.localDatabase) {
          add(
            "database is durable",
            false,
            "in-process Postgres (pglite:) — fine for development, never for a pilot with patients",
            false,
          );
        }
        const current = await isUpToDate(driver);
        add(
          "schema migrated",
          current,
          current ? `${loadMigrations().length} migrations applied` : "run npm run db:migrate",
        );
      } finally {
        await driver.close();
      }
    } catch (err) {
      add("database reachable", false, err instanceof Error ? err.message.slice(0, 120) : "unknown error");
    }

    // 3. Object storage writable.
    try {
      const os = cfg.pilot!.objectStore;
      if (os.kind === "local") {
        const probe = new LocalObjectStore(os.root);
        const key = `_healthcheck/${Date.now()}.bin`;
        await probe.put(key, Buffer.from("ok"), "application/octet-stream");
        const back = await probe.get(key);
        await probe.delete(key);
        add("object storage writable", back !== null, `local:${os.root}`);
      } else {
        // A live S3 round-trip needs credentials this command should not
        // assume; configuration presence is what can honestly be checked here.
        add("object storage configured", Boolean(os.bucket && os.region), `s3:${os.bucket} (${os.region})`);
        add(
          "object storage round-trip",
          false,
          "not verified — run a manual put/get against the bucket before the first patient",
          false,
        );
      }
    } catch (err) {
      add("object storage writable", false, err instanceof Error ? err.message.slice(0, 120) : "unknown");
    }

    // 4. Clinician accounts exist.
    try {
      const driver = await openDriver();
      try {
        const { rows } = await driver.query<{ n: string }>(
          "SELECT count(*)::text n FROM clinicians WHERE disabled_at IS NULL",
        );
        const n = Number(rows[0]?.n ?? 0);
        add("clinician accounts exist", n > 0, `${n} enabled`);
      } finally {
        await driver.close();
      }
    } catch {
      add("clinician accounts exist", false, "could not query clinicians");
    }
  }

  // 5. Model boundary — informational, because deterministic is a valid choice.
  const modelOn = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.AION_MODEL_MODE !== "off";
  add(
    "model provider boundary",
    true,
    modelOn
      ? "ENABLED — patient text is sent to the model provider; a BAA must be in place"
      : "disabled — no patient text leaves this deployment",
    false,
  );

  const blocking = checks.filter((c) => c.blocking);
  const failed = blocking.filter((c) => !c.ok);

  console.log("\nTECHNICAL PILOT READINESS");
  console.log("─".repeat(76));
  for (const c of checks) {
    const mark = c.ok ? green("PASS") : c.blocking ? red("FAIL") : yellow("NOTE");
    console.log(`${mark}  ${c.name.padEnd(30)} ${c.detail}`);
  }
  console.log("─".repeat(76));
  console.log(
    failed.length === 0
      ? green(`All ${blocking.length} technical prerequisites met.`)
      : red(`${failed.length} of ${blocking.length} technical prerequisites not met.`),
  );
  console.log(
    yellow(
      "\nThis is a TECHNICAL check only. It says nothing about HIPAA compliance,\n" +
        "signed Business Associate Agreements, an independent security review, or\n" +
        "whether a retention period is lawful. See PILOT_READINESS.md.\n",
    ),
  );
  return failed.length === 0 ? 0 : 1;
}

async function cmdRetention(): Promise<number> {
  const cfg = readConfig();
  if (cfg.mode !== "pilot") {
    console.error(red("Retention only applies in pilot mode."));
    return 1;
  }
  const dryRun = !has("--apply");
  const driver = await openDriver();
  try {
    const store = new SqlStore(driver, { pepper: cfg.pilot!.tokenPepper, objects: await objectStore() });

    const photoCutoff = new Date(Date.now() - cfg.pilot!.photoRetentionDays * 86400_000);
    const intakeCutoff = new Date(Date.now() - cfg.pilot!.intakeRetentionDays * 86400_000);

    const duePhotos = await store.photosPastRetention(photoCutoff);
    // An intake nobody ever submitted had no retention clock at all: the query
    // required a submitted_at. A patient who opened their link, typed a symptom
    // and closed the tab left a record that stayed forever. It is held to the
    // photo window, which is the shorter of the two — an abandoned intake holds
    // less than a completed one, and there is less reason to keep it.
    const abandonedCutoff = photoCutoff;
    const dueIntakes = await store.intakesPastRetention(intakeCutoff, abandonedCutoff);

    console.log(`\nRetention (${dryRun ? "dry run — pass --apply to delete" : "APPLYING"})`);
    console.log(`  photos older than ${cfg.pilot!.photoRetentionDays}d : ${duePhotos.length}`);
    console.log(`  intakes submitted over ${cfg.pilot!.intakeRetentionDays}d ago,`);
    console.log(`    plus never-submitted intakes idle over ${cfg.pilot!.photoRetentionDays}d : ${dueIntakes.length}`);

    if (!dryRun) {
      // Both paths write the row delete and the intent to delete the bytes in
      // one transaction, then attempt the bytes. Nothing here has to succeed
      // for the deletion to hold: what fails stays in the outbox and the
      // sweeper below (and `pilot:reconcile`) retries it. Re-running after an
      // interruption is safe — every step is idempotent.
      for (const p of duePhotos) {
        await store.retirePhoto(p.photoId);
      }
      for (const i of dueIntakes) {
        const res = await store.deleteIntake(i.id);
        await store.appendAudit({
          action: "intake.deleted",
          actorKind: "system",
          actorId: null,
          practiceId: i.practiceId,
          resource: "intake",
          resourceId: i.id,
          requestId: null,
          meta: { reason: "retention", photos: res.photoKeys.length },
        });
      }
      console.log(green(`  deleted ${duePhotos.length} photos and ${dueIntakes.length} intakes`));

      // Rate-limit buckets are keyed by attacker-influenced values, so the
      // table grows with traffic and nothing else was dropping rows. An evicted
      // bucket simply refills to full, so this costs nothing but disk. The
      // sweeper had a test and no caller — which is how a table grows without
      // bound in a system that believes it does not.
      const { sweepRateLimits } = await import("@/lib/ratelimit-shared");
      const dropped = await sweepRateLimits(driver, new Date(Date.now() - 24 * 3600_000));
      if (dropped > 0) console.log(`  rate-limit buckets swept: ${dropped}`);

      const swept = await store.sweepPendingDeletions();
      console.log(`  object bytes reclaimed: ${swept.swept}` + (swept.failed ? red(`, still owed: ${swept.failed}`) : ""));
      if (swept.failed) {
        console.log(yellow("  Re-run `npm run pilot:reconcile` — the rows are deleted and the bytes are still owed."));
      }
    }
    console.log("");
    return 0;
  } finally {
    await driver.close();
  }
}

/**
 * Drains the deletion outbox. Every entry is a photograph whose row is already
 * gone and whose bytes are still owed a deletion. Safe to run at any time, as
 * often as you like — it is the convergence half of "deleted means deleted".
 */
async function cmdReconcile(): Promise<number> {
  const cfg = readConfig();
  if (cfg.mode !== "pilot") {
    console.error(red("Reconcile only applies in pilot mode."));
    return 1;
  }
  const driver = await openDriver();
  try {
    const store = new SqlStore(driver, { pepper: cfg.pilot!.tokenPepper, objects: await objectStore() });
    const owed = await store.pendingObjectDeletions(1000);
    console.log(`\nDeletion outbox: ${owed.length} object(s) owed a deletion`);
    if (owed.length === 0) {
      console.log(green("  Nothing owed. Rows and bytes agree.\n"));
      return 0;
    }
    const stuck = owed.filter((o) => o.attempts >= 5);
    const { swept, failed } = await store.sweepPendingDeletions(1000);
    console.log(green(`  reclaimed ${swept}`));
    if (failed) {
      console.log(red(`  still owed ${failed}`));
      // A key that has failed repeatedly is a configuration problem — bucket
      // permissions, a deleted bucket — not something a further retry fixes.
      // Say so rather than letting it retry quietly forever.
      if (stuck.length) {
        console.log(
          yellow(
            `  ${stuck.length} key(s) have failed 5+ times. Check object-store credentials and\n` +
              "  bucket permissions; until they succeed, those photographs still exist.",
          ),
        );
      }
      return 1;
    }
    console.log("");
    return 0;
  } finally {
    await driver.close();
  }
}

/**
 * Issues a second-factor secret for one intake — strategy B (a code the
 * practice reads out at booking) or C (a one-time code delivered to the
 * contact on file).
 *
 * This exists so those two strategies are reachable rather than decorative.
 * Without a way to issue a secret they would be code nobody could exercise, and
 * a security mechanism nobody can exercise is one nobody has tested. Delivery
 * for C is the console adapter and nothing else: it prints the code to this
 * terminal, which is exactly what a developer needs and exactly what a real
 * pilot must not run on.
 */
/**
 * Creates one visit and its intake, and prints the patient's link.
 *
 * A pilot had no way to do this at all: tokens existed only in the synthetic
 * seed, so a practice could not enrol a real appointment without writing SQL by
 * hand. The infrastructure was complete and unusable.
 *
 * This is deliberately not scheduling. It creates one appointment because the
 * intake needs something to belong to, and it stops there — no calendar, no
 * recurrence, no reminders. The wedge is that the history arrives before the
 * visit, not that we run the diary.
 */
/**
 * Creates a clinician account.
 *
 * PILOT_SETUP told an operator to hash a password with
 * `node -e "require('./dist/lib/auth/password')"`, against a `dist/` this
 * project does not build. The first instruction for standing up a real pilot
 * did not run. There is deliberately no self-service registration and there
 * should not be — but "no registration" has to mean a command, not a recipe
 * that fails.
 */
async function cmdClinician(): Promise<number> {
  const cfg = readConfig();
  if (cfg.mode !== "pilot") {
    console.error(red("Clinician accounts only exist in pilot mode."));
    return 1;
  }
  const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const practiceId = arg("practice");
  const email = arg("email");
  const name = arg("name");
  const credential = arg("credential") ?? "";
  const password = process.env.AION_NEW_CLINICIAN_PASSWORD;
  if (!practiceId || !email || !name) {
    console.error(
      red("Usage: AION_NEW_CLINICIAN_PASSWORD=... pilot clinician --practice=<id> --email=<addr> --name=<display> [--credential=MD]"),
    );
    return 1;
  }
  if (!password || password.length < 12) {
    // Read from the environment, not from a flag: an argument is in the shell
    // history and in the process list of every other user on the machine.
    console.error(red("Set AION_NEW_CLINICIAN_PASSWORD (12+ chars). It is read from the environment so it does not land in shell history."));
    return 1;
  }

  const { randomBytes } = await import("node:crypto");
  const { hashPassword } = await import("@/lib/auth/password");
  const driver = await openDriver();
  try {
    const store = new SqlStore(driver, { pepper: cfg.pilot!.tokenPepper });
    if (!(await store.getPractice(practiceId))) {
      console.error(red(`No practice ${practiceId}. Create it first.`));
      return 1;
    }
    if (await store.clinicianByEmail(email)) {
      console.error(red(`An account already exists for ${email}.`));
      return 1;
    }
    const id = `cli_${randomBytes(8).toString("hex")}`;
    await driver.query(
      `INSERT INTO clinicians (id, practice_id, email, display_name, credential, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, practiceId, email, name, credential, await hashPassword(password)],
    );
    console.log(`\n${green("Clinician created.")}`);
    console.log(`  id:       ${id}`);
    console.log(`  email:    ${email}`);
    console.log(`  practice: ${practiceId}`);
    console.log(yellow("\n  Disable later with: UPDATE clinicians SET disabled_at = now() WHERE id = '" + id + "';"));
    console.log(yellow("  That takes effect on the very next request — the account is re-read every time.\n"));
    return 0;
  } finally {
    await driver.close();
  }
}

async function cmdInvite(): Promise<number> {
  const cfg = readConfig();
  if (cfg.mode !== "pilot") {
    console.error(red("Invites only apply in pilot mode."));
    return 1;
  }
  const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const practiceId = arg("practice");
  const first = arg("first");
  const last = arg("last");
  const dob = arg("dob");
  const when = arg("when");
  const reason = arg("reason") ?? "";
  if (!practiceId || !first || !last || !dob || !when) {
    console.error(
      red("Usage: pilot invite --practice=<id> --first=<name> --last=<name> --dob=YYYY-MM-DD --when=<iso> [--reason=...]"),
    );
    return 1;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    console.error(red("--dob must be YYYY-MM-DD. It is the default second factor; getting it wrong locks the patient out."));
    return 1;
  }
  if (Number.isNaN(new Date(when).getTime())) {
    console.error(red("--when must be a parseable date/time."));
    return 1;
  }

  const { randomBytes } = await import("node:crypto");
  const { mintToken } = await import("@/lib/patient/token");
  const { blankIntake } = await import("@/lib/demo/seed");
  const driver = await openDriver();
  try {
    const store = new SqlStore(driver, {
      pepper: cfg.pilot!.tokenPepper,
      defaultSecondFactor: cfg.pilot!.patientSecondFactor,
    });
    const practice = await store.getPractice(practiceId);
    if (!practice) {
      console.error(red(`No practice ${practiceId}.`));
      return 1;
    }

    const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
    const patientId = id("pat");
    const visitId = id("vis");
    const intakeId = id("int");
    const rawToken = mintToken();
    const expiresAt = new Date(
      Date.now() + cfg.pilot!.patientTokenTtlHours * 3600_000,
    ).toISOString();

    // One transaction: a visit with no intake, or an intake with no link, is a
    // half-enrolled patient somebody has to notice and clean up.
    await driver.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO patients (id, practice_id, first_name, last_name, date_of_birth) VALUES ($1,$2,$3,$4,$5)",
        [patientId, practiceId, first, last, dob],
      );
      await tx.query(
        "INSERT INTO visits (id, practice_id, patient_id, scheduled_for, reason_booked) VALUES ($1,$2,$3,$4,$5)",
        [visitId, practiceId, patientId, new Date(when).toISOString(), reason],
      );
      const intake = { ...blankIntake(visitId), id: intakeId, visitId };
      await tx.query(
        `INSERT INTO intakes (id, practice_id, visit_id, status, pathway, urgent_flag, document)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [intakeId, practiceId, visitId, intake.status, intake.pathway, false, JSON.stringify(intake)],
      );
    });
    await store.issueToken(intakeId, practiceId, rawToken, expiresAt);
    await store.appendAudit({
      action: "intake.created",
      actorKind: "system",
      actorId: null,
      practiceId,
      resource: "intake",
      resourceId: intakeId,
      requestId: null,
      meta: { factor: cfg.pilot!.patientSecondFactor },
    });

    console.log(`\n${green("Intake created.")}`);
    console.log(`  intake:  ${intakeId}`);
    console.log(`  link:    /intake/${rawToken}`);
    console.log(`  expires: ${expiresAt} (${cfg.pilot!.patientTokenTtlHours}h)`);
    console.log(`  factor:  ${cfg.pilot!.patientSecondFactor}`);
    if (cfg.pilot!.patientSecondFactor !== "dob") {
      console.log(yellow(`  Issue the secret before sending the link: npm run pilot:code -- --intake=${intakeId}`));
    }
    console.log(
      yellow(
        "\n  The link is a bearer credential. It is printed once, here, and only its\n" +
          "  hash is stored — nothing can show it to you again.\n",
      ),
    );
    return 0;
  } finally {
    await driver.close();
  }
}

async function cmdCode(): Promise<number> {
  const cfg = readConfig();
  if (cfg.mode !== "pilot") {
    console.error(red("Second-factor codes only apply in pilot mode."));
    return 1;
  }
  const intakeId = args.find((a) => a.startsWith("--intake="))?.slice("--intake=".length);
  if (!intakeId) {
    console.error(red("Usage: pilot code --intake=<id> [--kind=code|otp]"));
    return 1;
  }
  const kind = (args.find((a) => a.startsWith("--kind="))?.slice("--kind=".length) ?? "code") as
    | "code"
    | "otp";
  if (kind !== "code" && kind !== "otp") {
    console.error(red("--kind must be 'code' or 'otp'."));
    return 1;
  }

  const { randomBytes } = await import("node:crypto");
  const { mintCode, hashSecondFactor, consoleOtpDelivery, OTP_TTL_MINUTES } = await import(
    "@/lib/patient/second-factor"
  );
  const driver = await openDriver();
  try {
    const store = new SqlStore(driver, { pepper: cfg.pilot!.tokenPepper });
    const bundle = await store.bundleById(intakeId);
    if (!bundle) {
      console.error(red(`No intake ${intakeId}.`));
      return 1;
    }

    const code = mintCode(randomBytes);
    const expiresAt =
      kind === "otp" ? new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString() : null;
    // Only the hash is stored. The plaintext exists in this terminal and in
    // whatever channel the practice uses, and nowhere else.
    await store.setSecondFactor(intakeId, kind, hashSecondFactor(code, cfg.pilot!.tokenPepper), expiresAt);

    if (kind === "otp") await consoleOtpDelivery.send({ intakeId }, code);
    console.log(`\n${green(`Second factor for ${intakeId} is now '${kind}'.`)}`);
    console.log(`  code: ${code}`);
    if (expiresAt) console.log(`  expires: ${expiresAt} (${OTP_TTL_MINUTES} minutes)`);
    console.log(
      yellow(
        "\n  Any verification already passed for this link has been cleared, and the\n" +
          "  attempt counter reset. Deliver this through a DIFFERENT channel than the\n" +
          "  link itself — if both arrive on the same handset it is not a second factor.\n",
      ),
    );
    return 0;
  } finally {
    await driver.close();
  }
}

async function cmdBackup(): Promise<number> {
  const { dumpDatabase } = await import("@/lib/db/backup");
  const { writeFileSync } = await import("node:fs");
  const driver = await openDriver();
  try {
    const out = args.find((a) => a.startsWith("--out="))?.slice("--out=".length) ?? "";
    if (!out) {
      console.error(
        red("Refusing to write a backup without an explicit --out= path.") +
          "\nThis file is an UNENCRYPTED dump of every patient record: names, dates of birth," +
          "\ninterview transcripts and photo keys. It defaulted to ./backup.json, which is" +
          "\ninside the repository — one `git add -A` from being committed, and readable by" +
          "\nanything else running on the machine. Choose a path on encrypted storage," +
          "\noutside the working tree, and delete it when the rehearsal is over.",
      );
      return 1;
    }
    const backup = await dumpDatabase(driver, new Date(0).toISOString());
    // Stamp the time outside the workflow-free path; Date is available in scripts.
    backup.takenAt = new Date().toISOString();
    const total = Object.values(backup.tables).reduce((n, rows) => n + rows.length, 0);
    // Owner-only. The default was whatever the process umask allowed, which on
    // a shared host is world-readable — for a file holding every patient record.
    writeFileSync(out, JSON.stringify(backup, null, 2), { mode: 0o600 });
    console.log(green(`Wrote ${total} rows across ${Object.keys(backup.tables).length} tables to ${out}`));
    console.log(yellow("This is a LOGICAL dump for rehearsal. Production backup is the provider's PITR — see PILOT_SETUP.md."));
    return 0;
  } finally {
    await driver.close();
  }
}

async function cmdRestore(): Promise<number> {
  if (!has("--confirm")) {
    console.error(red("Refusing to restore without --confirm.") + "\nThis REPLACES all application data with the backup's contents.");
    return 1;
  }
  const { restoreDatabase } = await import("@/lib/db/backup");
  const { readFileSync } = await import("node:fs");
  const file = args.find((a) => a.startsWith("--in="))?.slice("--in=".length) ?? "backup.json";
  const driver = await openDriver();
  try {
    await migrate(driver);
    const backup = JSON.parse(readFileSync(file, "utf8"));
    const { rows } = await restoreDatabase(driver, backup);
    console.log(green(`Restored ${rows} rows from ${file} (taken ${backup.takenAt}).`));
    console.log(yellow("Reconcile object storage to the same point — see ROLLBACK.md."));
    return 0;
  } finally {
    await driver.close();
  }
}

const COMMANDS: Record<string, () => Promise<number>> = {
  migrate: cmdMigrate,
  seed: cmdSeed,
  check: cmdCheck,
  retention: cmdRetention,
  reconcile: cmdReconcile,
  code: cmdCode,
  invite: cmdInvite,
  clinician: cmdClinician,
  backup: cmdBackup,
  restore: cmdRestore,
};

async function main() {
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`Unknown command "${command}". Try: ${Object.keys(COMMANDS).join(", ")}`);
    process.exit(2);
  }
  process.exit(await fn());
}

void main();
