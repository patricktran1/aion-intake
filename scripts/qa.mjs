/**
 * Browser QA: drives the real product across every breakpoint that matters and
 * writes screenshots plus a defect report.
 *
 *   SHOTS=/tmp/shots node scripts/qa.mjs [--full]
 *
 * The checks are the ones a person would make and then forget to make again:
 * does anything overflow horizontally, is every tap target reachable, does the
 * composer survive an open keyboard, does any control lack an accessible name.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3100";
const SHOTS = process.env.SHOTS ?? "/tmp/aion-shots";
const ACNE = "demoacne0000acne0000demo0000";
const OPEN = "demoopen0000open0000demo0000";

const PATIENT_VIEWPORTS = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "iphone-mini", width: 375, height: 667 },
  { name: "iphone-14", width: 390, height: 844 },
  { name: "iphone-max", width: 430, height: 932 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

const CLINICIAN_VIEWPORTS = [
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
];

const defects = [];
const note = (where, what) => defects.push(`${where}: ${what}`);

/** Horizontal overflow is the single most common mobile defect. */
async function checkNoHorizontalScroll(page, where) {
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    const offenders = [];
    if (de.scrollWidth > de.clientWidth + 1) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.right > de.clientWidth + 1 && r.width > 0) {
          offenders.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 60)}`);
          if (offenders.length > 4) break;
        }
      }
      return { over: de.scrollWidth - de.clientWidth, offenders };
    }
    return null;
  });
  if (overflow) note(where, `page scrolls horizontally by ${overflow.over}px — ${overflow.offenders.join(" | ")}`);
}

/** Anything interactive needs an accessible name and a usable tap target. */
async function checkControls(page, where) {
  const issues = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("button, a[href], input, textarea, select")) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const name = (
        el.getAttribute("aria-label") ||
        el.textContent ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        (el.labels && el.labels.length ? el.labels[0].textContent : "") ||
        ""
      ).trim();
      const tag = el.tagName.toLowerCase();
      if (!name) out.push(`${tag} has no accessible name`);
      const r = el.getBoundingClientRect();
      const isSrOnly = el.className && el.className.toString().includes("sr-only");
      if (!isSrOnly && r.width > 0 && r.height > 0 && r.height < 32 && tag === "button") {
        out.push(`${tag} "${name.slice(0, 24)}" is only ${Math.round(r.height)}px tall`);
      }
    }
    return [...new Set(out)];
  });
  for (const i of issues) note(where, i);
}

/** Text that clips or wraps out of its box reads as broken software. */
async function checkClipping(page, where) {
  const clipped = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("h1, h2, h3, p, td, dd, span, li, button")) {
      if (el.children.length > 0) continue;
      const style = getComputedStyle(el);
      if (style.overflow === "auto" || style.overflow === "scroll") continue;
      if (el.scrollWidth > el.clientWidth + 2 && style.textOverflow !== "ellipsis" && style.whiteSpace !== "nowrap") {
        out.push(`${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 40)}"`);
      }
    }
    return [...new Set(out)].slice(0, 5);
  });
  for (const c of clipped) note(where, `text overflows its box: ${c}`);
}

async function audit(page, where) {
  await checkNoHorizontalScroll(page, where);
  await checkControls(page, where);
  await checkClipping(page, where);
}

const ANSWERS = {
  concern:
    "I've been breaking out badly along my jaw and chin for about a year and it's leaving dark marks",
  acne_distribution: "Jawline, chin and a bit on my chest. It leaves marks and a couple of small scars",
  timeline: "It's been getting worse over the last few months",
  acne_treatments:
    "A benzoyl peroxide wash from the drugstore and a clindamycin gel from my doctor. The wash dried me out, the gel helped a little at first",
  acne_pattern: "Worse before my period and when I'm stressed",
  acne_impact: "I don't want to go out without makeup",
  context: "No medications, no allergies",
  goal: "I want it to stop scarring, and to know if I need something stronger",
};

async function runPatient(browser, vp, shot) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: vp.width < 500,
    hasTouch: vp.width < 900,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${vp.name} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${vp.name} console: ${m.text()}`));

  await page.goto(`${BASE}/intake/${ACNE}`, { waitUntil: "networkidle" });
  await audit(page, `patient/${vp.name}/welcome`);
  if (shot) await page.screenshot({ path: `${SHOTS}/p-${vp.name}-01-welcome.png`, fullPage: true });

  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForSelector('textarea[aria-label="Your answer"]');
  await audit(page, `patient/${vp.name}/question`);

  // Keyboard-open simulation: the composer must stay reachable when the
  // viewport shrinks to what iOS leaves after the keyboard appears.
  if (vp.width < 500) {
    await ctx.pages()[0].setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.45) });
    await page.locator('textarea[aria-label="Your answer"]').fill("typing with the keyboard up");
    const visible = await page.getByRole("button", { name: "Send answer" }).isVisible();
    if (!visible) note(`patient/${vp.name}/keyboard`, "send button is not visible with the keyboard open");
    if (shot) await page.screenshot({ path: `${SHOTS}/p-${vp.name}-02-keyboard.png` });
    await audit(page, `patient/${vp.name}/keyboard`);
    await ctx.pages()[0].setViewportSize({ width: vp.width, height: vp.height });
    await page.locator('textarea[aria-label="Your answer"]').fill("");
  }

  let turns = 0;
  for (let i = 0; i < 12; i += 1) {
    const ta = page.locator('textarea[aria-label="Your answer"]');
    if ((await ta.count()) === 0) break;
    const slot = await page.evaluate(async (token) => {
      const r = await fetch(`/api/intake/${token}`);
      return r.ok ? (await r.json()).currentSlot : null;
    }, ACNE);
    const answer = ANSWERS[slot] ?? `Answer for ${slot ?? "unknown"}`;
    await ta.fill(answer);
    await page.getByRole("button", { name: "Send answer" }).click();
    turns += 1;
    await page.waitForTimeout(450);
    if ((await page.locator("text=Want to add a photo").count()) > 0) break;
  }
  if (shot) await page.screenshot({ path: `${SHOTS}/p-${vp.name}-03-conversation.png`, fullPage: true });
  await audit(page, `patient/${vp.name}/conversation`);

  await page.waitForSelector("text=Want to add a photo", { timeout: 10000 });
  await audit(page, `patient/${vp.name}/photos`);
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 900;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 1200, 900);
    g.addColorStop(0, "hsl(20,30%,55%)");
    g.addColorStop(1, "hsl(20,25%,35%)");
    x.fillStyle = g;
    x.fillRect(0, 0, 1200, 900);
    x.fillStyle = "rgba(255,255,255,.85)";
    x.font = "34px sans-serif";
    x.fillText("SYNTHETIC TEST IMAGE", 40, 450);
    return c.toDataURL("image/jpeg", 0.9);
  });
  await page.locator('input[type="file"]').setInputFiles([
    { name: "p1.jpg", mimeType: "image/jpeg", buffer: Buffer.from(dataUrl.split(",")[1], "base64") },
  ]);
  await page.waitForTimeout(1200);
  if (shot) await page.screenshot({ path: `${SHOTS}/p-${vp.name}-04-photos.png`, fullPage: true });
  await audit(page, `patient/${vp.name}/photos-added`);

  await page.getByRole("button", { name: /Continue|Skip photos/ }).click();
  await page.waitForSelector("text=Here", { timeout: 10000 });
  await audit(page, `patient/${vp.name}/review`);
  if (shot) await page.screenshot({ path: `${SHOTS}/p-${vp.name}-05-review.png`, fullPage: true });

  const editButtons = page.getByRole("button", { name: "Edit" });
  if ((await editButtons.count()) > 0) {
    await editButtons.first().click();
    await page.waitForTimeout(250);
    await audit(page, `patient/${vp.name}/review-editing`);
    if (shot) await page.screenshot({ path: `${SHOTS}/p-${vp.name}-06-editing.png`, fullPage: true });
    await page.getByRole("button", { name: "Cancel" }).click();
  }

  await page.getByRole("button", { name: /Send this to my dermatologist/ }).click();
  await page.waitForSelector("text=thank you", { timeout: 12000 });
  await audit(page, `patient/${vp.name}/done`);
  if (shot) await page.screenshot({ path: `${SHOTS}/p-${vp.name}-07-done.png`, fullPage: true });

  await ctx.close();
  return { turns, errors };
}

async function runClinician(browser, vp, shot) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`clinician/${vp.name} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`clinician/${vp.name} console: ${m.text()}`));

  await page.goto(`${BASE}/clinician`, { waitUntil: "networkidle" });
  await audit(page, `clinician/${vp.name}/list`);
  if (shot) await page.screenshot({ path: `${SHOTS}/c-${vp.name}-01-list.png`, fullPage: true });

  await page.locator('a:has-text("Review")').first().click();
  await page.waitForSelector("text=Pre-visit brief", { timeout: 10000 });
  await audit(page, `clinician/${vp.name}/brief`);
  if (shot) await page.screenshot({ path: `${SHOTS}/c-${vp.name}-02-brief.png`, fullPage: true });

  const wordsBtn = page.getByRole("button", { name: /own words/ });
  if ((await wordsBtn.count()) > 0) {
    await wordsBtn.click();
    await page.waitForTimeout(200);
    await audit(page, `clinician/${vp.name}/provenance`);
    if (shot) await page.screenshot({ path: `${SHOTS}/c-${vp.name}-03-provenance.png`, fullPage: true });
  }

  await page.locator("#f-exam").fill("Comedones and inflammatory papules along the jawline, with post-inflammatory hyperpigmentation.");
  await page.locator("#f-assessment").fill("Moderate inflammatory acne with post-inflammatory hyperpigmentation.");
  await page.locator("#f-plan").fill("Start adapalene nightly and a benzoyl peroxide wash. Discussed sun protection for the marks.");
  await page.locator("#f-medications").fill("Adapalene 0.1% gel; benzoyl peroxide 5% wash");
  await page.locator("#f-followUp").fill("12 weeks.");
  await page.locator("#f-followUp").blur();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Generate draft note" }).click();
  await page.waitForSelector('textarea[aria-label="Draft clinical note"]', { timeout: 10000 });
  await page.waitForTimeout(400);
  await audit(page, `clinician/${vp.name}/note`);
  if (shot) await page.screenshot({ path: `${SHOTS}/c-${vp.name}-04-note.png`, fullPage: true });

  const note = await page.locator('textarea[aria-label="Draft clinical note"]').inputValue();
  if (!note.includes("HISTORY OF PRESENT ILLNESS")) note(`clinician/${vp.name}`, "draft note is missing the HPI block");

  await ctx.close();
  return { errors };
}

async function keyboardWalk(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/intake/${OPEN}`, { waitUntil: "networkidle" });
  // Tab to Start and activate it with the keyboard alone.
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    if (label === "Start") {
      await page.keyboard.press("Enter");
      await page.waitForSelector('textarea[aria-label="Your answer"]', { timeout: 5000 });
      const focusVisible = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return true;
        const s = getComputedStyle(el);
        return s.outlineStyle !== "none" || s.boxShadow !== "none";
      });
      if (!focusVisible) note("a11y/keyboard", "focused element has no visible focus indicator");
      await ctx.close();
      return true;
    }
  }
  note("a11y/keyboard", "could not reach the Start button with the keyboard");
  await ctx.close();
  return false;
}

async function main() {
  const full = process.argv.includes("--full");
  await fetch(`${BASE}/api/demo/reset`, { method: "POST" }).catch(() => {});
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });

  const allErrors = [];
  const patientVps = full ? PATIENT_VIEWPORTS : PATIENT_VIEWPORTS.filter((v) => [320, 390, 430, 768, 1440].includes(v.width));
  for (const vp of patientVps) {
    const reset = await fetch(`${BASE}/api/demo/reset`, { method: "POST" }).catch(() => null);
    if (!reset || !reset.ok) note(`demo/reset`, `reset returned ${reset ? reset.status : "no response"}`);
    const r = await runPatient(browser, vp, true);
    allErrors.push(...r.errors);
    console.log(`patient ${vp.name} (${vp.width}px): completed in ${r.turns} answers`);
  }

  for (const vp of CLINICIAN_VIEWPORTS) {
    const r = await runClinician(browser, vp, true);
    allErrors.push(...r.errors);
    console.log(`clinician ${vp.name} (${vp.width}px): ok`);
  }

  await keyboardWalk(browser);
  await browser.close();

  console.log("\n=== DEFECTS ===");
  if (defects.length === 0) console.log("none");
  for (const d of [...new Set(defects)]) console.log(" ! " + d);
  console.log("\n=== RUNTIME ERRORS ===");
  if (allErrors.length === 0) console.log("none");
  for (const e of [...new Set(allErrors)]) console.log(" ! " + e);
}

void main();
