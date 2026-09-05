/**
 * Runtime mode.
 *
 * AION Intake runs as one of two different products from the same code:
 *
 *   demo   Synthetic data in process memory. Resettable, free, safe to point
 *          the internet at. This is what aion-intake.vercel.app runs.
 *   pilot  Durable Postgres, authenticated clinicians, visit-bound patient
 *          access, private object storage, an audit trail.
 *
 * The single most dangerous failure this file prevents: a missing environment
 * variable quietly turning a pilot deployment into an open demo, or a demo
 * deployment into something that writes to the pilot database. So the mode is
 * never inferred. It is read from AION_RUNTIME_MODE, it defaults to the safe
 * value, and an unrecognised value is a startup error rather than a guess.
 *
 * Pilot mode additionally refuses to start unless everything it needs is
 * present and non-default. A pilot that boots half-configured is worse than
 * one that does not boot.
 */

import { SECOND_FACTOR_KINDS, type SecondFactorKind } from "@/lib/patient/second-factor";

export type RuntimeMode = "demo" | "pilot";

/** Anything that reads like an environment. Keeps tests from having to fake NODE_ENV. */
export type EnvLike = Record<string, string | undefined>;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Values that must never be accepted as a real secret. */
const FORBIDDEN_SECRETS = new Set([
  "",
  "changeme",
  "change-me",
  "secret",
  "password",
  "development",
  "dev",
  "test",
  "aion",
  "insecure",
  "default",
]);

const MIN_SECRET_LENGTH = 32;

export interface PilotConfig {
  /**
   * A postgres:// connection string, or "pglite:<dir>" for the local
   * development pilot. The local form is a URL rather than a separate flag on
   * purpose: one variable says where the database is, so there is no
   * combination of settings where the two disagree about it.
   */
  databaseUrl: string;
  /** True for the in-process database. Never a deployment target. */
  localDatabase: boolean;
  sessionSecret: string;
  tokenPepper: string;
  objectStore: { kind: "local"; root: string } | { kind: "s3"; bucket: string; region: string; endpoint?: string };
  /** Days a photo is retained after the visit before deletion is due. */
  photoRetentionDays: number;
  /** Days an intake record is retained after submission before deletion is due. */
  intakeRetentionDays: number;
  /** Hours a patient access token stays valid after being issued. */
  patientTokenTtlHours: number;
  /**
   * Which second factor a patient must pass. Explicit, never inferred — see
   * patient/second-factor.ts for the three strategies and their tradeoffs.
   * Defaults to date of birth, the only one with no operational dependency.
   */
  patientSecondFactor: SecondFactorKind;
}

export interface RuntimeConfig {
  mode: RuntimeMode;
  /** Present only in pilot mode. Demo mode has nothing to configure. */
  pilot: PilotConfig | null;
}

function requireSecret(env: EnvLike, name: string, problems: string[]): string {
  const raw = (env[name] ?? "").trim();
  if (!raw) {
    problems.push(`${name} is required in pilot mode`);
    return "";
  }
  if (FORBIDDEN_SECRETS.has(raw.toLowerCase())) {
    problems.push(`${name} is a well-known placeholder value and must be replaced`);
    return "";
  }
  if (raw.length < MIN_SECRET_LENGTH) {
    problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters (got ${raw.length})`);
    return "";
  }
  return raw;
}

function requirePositiveInt(env: EnvLike, name: string, problems: string[]): number {
  const raw = (env[name] ?? "").trim();
  if (!raw) {
    // Retention is a policy decision with legal input. There is no safe default
    // to invent, so pilot mode refuses to start until someone has chosen one.
    problems.push(`${name} is required in pilot mode — retention is a policy decision, not a default`);
    return 0;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${name} must be a positive whole number of days (got "${raw}")`);
    return 0;
  }
  return n;
}

function readObjectStore(env: EnvLike, problems: string[]): PilotConfig["objectStore"] {
  const kind = (env.AION_OBJECT_STORE ?? "").trim().toLowerCase();
  if (kind === "local") {
    const root = (env.AION_OBJECT_STORE_ROOT ?? "").trim();
    if (!root) problems.push("AION_OBJECT_STORE_ROOT is required when AION_OBJECT_STORE=local");
    return { kind: "local", root };
  }
  if (kind === "s3") {
    const bucket = (env.AION_S3_BUCKET ?? "").trim();
    const region = (env.AION_S3_REGION ?? "").trim();
    if (!bucket) problems.push("AION_S3_BUCKET is required when AION_OBJECT_STORE=s3");
    if (!region) problems.push("AION_S3_REGION is required when AION_OBJECT_STORE=s3");
    if (!env.AION_S3_ACCESS_KEY_ID) problems.push("AION_S3_ACCESS_KEY_ID is required when AION_OBJECT_STORE=s3");
    if (!env.AION_S3_SECRET_ACCESS_KEY) {
      problems.push("AION_S3_SECRET_ACCESS_KEY is required when AION_OBJECT_STORE=s3");
    }
    return { kind: "s3", bucket, region, endpoint: env.AION_S3_ENDPOINT?.trim() || undefined };
  }
  problems.push('AION_OBJECT_STORE must be "local" or "s3" in pilot mode');
  return { kind: "local", root: "" };
}

/**
 * Reads and validates configuration. Throws ConfigError listing every problem
 * at once — a boot that fails should tell you everything wrong, not make you
 * fix one variable per restart.
 */
export function readConfig(env: EnvLike = process.env): RuntimeConfig {
  const raw = (env.AION_RUNTIME_MODE ?? "demo").trim().toLowerCase();
  if (raw !== "demo" && raw !== "pilot") {
    throw new ConfigError([`AION_RUNTIME_MODE must be "demo" or "pilot" (got "${raw}")`]);
  }
  const mode: RuntimeMode = raw;

  if (mode === "demo") {
    const problems: string[] = [];
    // A demo pointing at a pilot database is the accident this whole file
    // exists to prevent. Refusing to start is the correct response: the
    // variable being set at all means someone expected durable storage.
    if (env.DATABASE_URL) {
      problems.push(
        "DATABASE_URL is set but AION_RUNTIME_MODE=demo — refusing to start rather than " +
          "risk a demo writing to a pilot database. Unset DATABASE_URL or set AION_RUNTIME_MODE=pilot.",
      );
    }
    if (problems.length > 0) throw new ConfigError(problems);
    return { mode, pilot: null };
  }

  const problems: string[] = [];
  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) problems.push("DATABASE_URL is required in pilot mode");
  else if (!/^postgres(ql)?:\/\//.test(databaseUrl) && !databaseUrl.startsWith("pglite:")) {
    problems.push(
      'DATABASE_URL must be a postgres:// connection string, or "pglite:<dir>" for local development',
    );
  }

  const sessionSecret = requireSecret(env, "AION_SESSION_SECRET", problems);
  const tokenPepper = requireSecret(env, "AION_TOKEN_PEPPER", problems);
  if (sessionSecret && tokenPepper && sessionSecret === tokenPepper) {
    problems.push("AION_SESSION_SECRET and AION_TOKEN_PEPPER must be different values");
  }

  const objectStore = readObjectStore(env, problems);
  const photoRetentionDays = requirePositiveInt(env, "AION_PHOTO_RETENTION_DAYS", problems);
  const intakeRetentionDays = requirePositiveInt(env, "AION_INTAKE_RETENTION_DAYS", problems);

  const ttlRaw = (env.AION_PATIENT_TOKEN_TTL_HOURS ?? "72").trim();
  const patientTokenTtlHours = Number(ttlRaw);
  if (!Number.isInteger(patientTokenTtlHours) || patientTokenTtlHours <= 0 || patientTokenTtlHours > 24 * 30) {
    problems.push("AION_PATIENT_TOKEN_TTL_HOURS must be a whole number of hours between 1 and 720");
  }

  const sfRaw = (env.AION_PATIENT_SECOND_FACTOR ?? "dob").trim().toLowerCase();
  if (!(SECOND_FACTOR_KINDS as readonly string[]).includes(sfRaw)) {
    problems.push(`AION_PATIENT_SECOND_FACTOR must be one of ${SECOND_FACTOR_KINDS.join(", ")}`);
  }
  const patientSecondFactor = sfRaw as SecondFactorKind;

  // The demo reset endpoint wipes and reseeds the store. In pilot mode that
  // would destroy real records, so it must be off — and being explicit about
  // it beats relying on the route to check the mode correctly forever.
  if ((env.AION_ALLOW_DEMO_RESET ?? "").trim() === "1") {
    problems.push("AION_ALLOW_DEMO_RESET=1 is not permitted in pilot mode");
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    mode,
    pilot: {
      databaseUrl,
      localDatabase: databaseUrl.startsWith("pglite:"),
      sessionSecret,
      tokenPepper,
      objectStore,
      photoRetentionDays,
      intakeRetentionDays,
      patientTokenTtlHours,
      patientSecondFactor,
    },
  };
}

let cached: RuntimeConfig | null = null;

/** Memoised config. Throws on first call if the environment is unsafe. */
export function config(): RuntimeConfig {
  if (!cached) cached = readConfig();
  return cached;
}

/** Test hook: forget the memoised config so a new environment can be read. */
export function resetConfigCache(): void {
  cached = null;
}

export function runtimeMode(): RuntimeMode {
  return config().mode;
}

export function isPilot(): boolean {
  return config().mode === "pilot";
}

export function isDemo(): boolean {
  return config().mode === "demo";
}

/** Pilot config, or a thrown error if called in demo mode. */
export function pilotConfig(): PilotConfig {
  const c = config();
  if (!c.pilot) throw new Error("pilotConfig() called in demo mode");
  return c.pilot;
}
