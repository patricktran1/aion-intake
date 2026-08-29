/**
 * Pilot operations CLI.
 *
 *   npm run db:migrate            apply migrations
 *   npm run db:seed -- --confirm  load the synthetic pilot seed
 *   npm run pilot:check           technical readiness report
 *   npm run pilot:retention       delete records past their retention window
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
    const store = new SqlStore(driver, { pepper: cfg.pilot!.tokenPepper });
    const objects =
      cfg.pilot!.objectStore.kind === "local" ? new LocalObjectStore(cfg.pilot!.objectStore.root) : null;

    const photoCutoff = new Date(Date.now() - cfg.pilot!.photoRetentionDays * 86400_000);
    const intakeCutoff = new Date(Date.now() - cfg.pilot!.intakeRetentionDays * 86400_000);

    const duePhotos = await store.photosPastRetention(photoCutoff);
    const dueIntakes = await store.intakesPastRetention(intakeCutoff);

    console.log(`\nRetention (${dryRun ? "dry run — pass --apply to delete" : "APPLYING"})`);
    console.log(`  photos older than ${cfg.pilot!.photoRetentionDays}d : ${duePhotos.length}`);
    console.log(`  intakes submitted over ${cfg.pilot!.intakeRetentionDays}d ago : ${dueIntakes.length}`);

    if (!dryRun) {
      for (const p of duePhotos) {
        // Object first, then the row: an orphaned row is a recoverable
        // inconsistency, an orphaned object is a photograph nothing points to.
        if (objects) await objects.delete(p.objectKey);
        await store.deletePhoto(p.photoId);
      }
      for (const i of dueIntakes) {
        const res = await store.deleteIntake(i.id);
        if (objects) for (const key of res.photoKeys) await objects.delete(key);
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
    }
    console.log("");
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
