/**
 * The patient's second factor, behind one interface.
 *
 * Holding the link must not be the same as being the patient. A link arrives by
 * SMS to a phone that may be shared, forwarded, backed up, or read over a
 * shoulder, so opening the intake asks for something the link does not contain.
 *
 * Which "something" is a policy decision, and it is genuinely contested — so it
 * is a strategy rather than a hard-wired comparison. Three exist:
 *
 *   A. DATE OF BIRTH (`dob`) — the default.
 *      For:     the practice already holds it and the patient always knows it.
 *               Zero setup, zero cost, nothing to deliver, nothing to expire,
 *               and no way for the mechanism itself to lock out a real patient
 *               who is simply not near their phone.
 *      Against: it is a weak secret. Family members know it, it appears in
 *               plenty of records, and anyone who has already obtained the link
 *               from someone's phone very likely knows it too. It raises the
 *               bar against a casually forwarded message and against nothing
 *               more determined than that.
 *      Use when: the threat is accidental exposure, which is the pilot's.
 *
 *   B. PRACTICE-ISSUED CODE (`code`) — a short code the practice gives the
 *      patient through a different channel than the link: spoken at booking,
 *      printed on the appointment card, said on the confirmation call.
 *      For:     a real second channel, and a secret nobody in the household
 *               knows by default. No provider, no cost, no phone number needed.
 *      Against: it is operational work for the front desk on every single
 *               visit, and the failure mode is a patient who cannot start their
 *               intake at 9pm because the card is at home. That failure lands
 *               on the practice as a phone call.
 *      Use when: a practice has decided date of birth is not enough and is
 *               willing to carry the desk work.
 *
 *   C. ONE-TIME CODE TO A KNOWN CONTACT (`otp`) — a code delivered to the
 *      phone number already on the patient record, through a provider adapter.
 *      For:     the strongest of the three. Proves control of a contact the
 *               practice recorded before this visit, and the code is
 *               short-lived, so a stolen link goes stale fast.
 *      Against: it needs a delivery provider (cost, a contract, another
 *               processor touching patient contact details, and a BAA
 *               conversation), it fails when the number on file is wrong or
 *               the patient has changed phones, and if the link and the code
 *               land on the same handset it stops being a second channel at
 *               all — which for an SMS-delivered link is the common case.
 *      Use when: the link is delivered by email and the code by SMS, or the
 *               reverse. Not before then.
 *
 * **The default is A, and only A.** Exactly one is active at a time, chosen by
 * `AION_PATIENT_SECOND_FACTOR`, defaulting to `dob`. The patient sees one
 * field and one line of instruction whichever is configured: the strategy
 * supplies the prompt, so adding a strategy never adds a control to the screen.
 * A patient-facing security screen that offers choices is a screen people fail.
 *
 * **What ships here**: A is complete and is what the pilot runs. B and C are
 * implemented against synthetic/local adapters only — B's codes are issued by
 * the practice through the store, C's delivery adapter writes the code to the
 * server log and nothing else. No SMS or email provider is integrated, and
 * none is claimed to be.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { dobMatches } from "./token";

export const SECOND_FACTOR_KINDS = ["dob", "code", "otp"] as const;
export type SecondFactorKind = (typeof SECOND_FACTOR_KINDS)[number];

/** What the patient is asked. Rendered as-is; it never contains the answer. */
export interface SecondFactorChallenge {
  kind: SecondFactorKind;
  /** The field label. Short — it sits above one input.  */
  label: string;
  /** One line explaining where the answer comes from. */
  hint: string;
  /** Drives the mobile keyboard. */
  inputMode: "numeric" | "text";
  /** Longest sensible answer, so the field can cap input. */
  maxLength: number;
}

/** Everything a strategy may look at. Deliberately small. */
export interface SecondFactorSubject {
  intakeId: string;
  practiceId: string;
  /** ISO date on the patient record. Used by the `dob` strategy. */
  patientDateOfBirth: string;
  /** Peppered hash of the expected value, for strategies that store one. */
  storedHash: string | null;
  /** When a stored one-time value stops being acceptable. */
  storedExpiresAt: string | null;
}

export interface SecondFactor {
  readonly kind: SecondFactorKind;
  challenge(): SecondFactorChallenge;
  /**
   * True when `supplied` is correct. Must not throw on malformed input — a
   * patient typing nonsense is a wrong answer, not a server error — and must
   * not vary its work in a way that leaks the expected value.
   */
  verify(supplied: string, subject: SecondFactorSubject): boolean;
}

/**
 * Peppered SHA-256, the same construction the access token uses and for the
 * same reason: lookup is by the supplied value, so a per-row salt would not be
 * available, and the pepper lives in the environment rather than the database.
 *
 * A short practice code has little entropy, so this hash would not survive an
 * offline attack on its own. What protects it is the durable five-attempt
 * lockout on the token, which makes the online guess budget five rather than
 * unbounded. Said plainly because it is the load-bearing control, not the hash.
 */
export function hashSecondFactor(value: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:sf:${normalizeCode(value)}`).digest("hex");
}

/** Codes are compared case- and space-insensitively; patients read them aloud. */
export function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "");
}

function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** A. Date of birth. The default. */
class DateOfBirthFactor implements SecondFactor {
  readonly kind = "dob" as const;
  challenge(): SecondFactorChallenge {
    return {
      kind: "dob",
      label: "Date of birth",
      hint: "So we know it's you. Use the date of birth your clinic has on file.",
      inputMode: "numeric",
      maxLength: 40,
    };
  }
  verify(supplied: string, subject: SecondFactorSubject): boolean {
    if (!supplied) return false;
    return dobMatches(supplied, subject.patientDateOfBirth);
  }
}

/** B and C differ in how the secret is delivered, not in how it is checked. */
class HashedCodeFactor implements SecondFactor {
  constructor(
    readonly kind: SecondFactorKind,
    private readonly pepper: string,
    private readonly text: { label: string; hint: string },
    private readonly enforceExpiry: boolean,
  ) {}

  challenge(): SecondFactorChallenge {
    return { kind: this.kind, label: this.text.label, hint: this.text.hint, inputMode: "text", maxLength: 16 };
  }

  verify(supplied: string, subject: SecondFactorSubject): boolean {
    // No code issued is a closed door, not an open one. A practice that
    // switched to this factor without issuing codes gets patients who cannot
    // get in — visible, fixable — rather than patients who need no factor.
    if (!supplied || !subject.storedHash) return false;
    if (this.enforceExpiry) {
      if (!subject.storedExpiresAt) return false;
      if (new Date(subject.storedExpiresAt).getTime() <= Date.now()) return false;
    }
    return hashEquals(hashSecondFactor(supplied, this.pepper), subject.storedHash);
  }
}

/**
 * The configured factor. One per process, chosen explicitly — like the runtime
 * mode, it is never inferred, because inferring a security control from the
 * shape of the data is how a control quietly turns itself off.
 */
export function secondFactorFor(kind: SecondFactorKind, pepper: string): SecondFactor {
  switch (kind) {
    case "dob":
      return new DateOfBirthFactor();
    case "code":
      return new HashedCodeFactor(
        "code",
        pepper,
        {
          label: "Clinic code",
          hint: "The short code your clinic gave you when you booked.",
        },
        // A practice-issued code lasts as long as the link does: it was given
        // out at booking, which may be weeks before the visit.
        false,
      );
    case "otp":
      return new HashedCodeFactor(
        "otp",
        pepper,
        {
          label: "Security code",
          hint: "We sent a short code to the phone number your clinic has on file.",
        },
        // A one-time code must expire, or it is just a second password.
        true,
      );
  }
}

/** Minutes a one-time code stays valid. Short enough to matter, long enough to type. */
export const OTP_TTL_MINUTES = 10;

/**
 * Delivery for strategy C.
 *
 * Only a local adapter ships. It writes the code to the server log, which is
 * exactly what a developer needs and exactly what a real deployment must never
 * use — so it says so on every send, and `pilot:check` refuses to call the
 * configuration production-ready while it is the active factor.
 */
export interface OtpDelivery {
  readonly kind: "console";
  send(to: { intakeId: string }, code: string): Promise<void>;
}

export const consoleOtpDelivery: OtpDelivery = {
  kind: "console",
  async send(to, code) {
    console.warn(
      `[aion] SYNTHETIC OTP DELIVERY — no message was sent. intake=${to.intakeId} code=${code}\n` +
        "        This adapter exists for local development. Do not run a real pilot on it.",
    );
  },
};

/** Six characters from an alphabet without look-alikes (no O/0, I/1, S/5). */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXY2346789";

export function mintCode(randomBytesFn: (n: number) => Buffer, length = 6): string {
  const bytes = randomBytesFn(length * 2);
  let out = "";
  // Rejection sampling: taking bytes modulo the alphabet length would make the
  // first few characters slightly likelier, which on a 6-character secret is a
  // real reduction in the guess space rather than a rounding detail.
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    if (bytes[i] < limit) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  // Astronomically unlikely; recurse rather than return a short code.
  if (out.length < length) return mintCode(randomBytesFn, length);
  return out;
}
