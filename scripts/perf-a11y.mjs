/**
 * Performance and accessibility checks against the running app.
 *
 *   node scripts/perf-a11y.mjs
 *
 * Deliberately narrow: transferred bytes and first paint on the two screens
 * that matter, plus the accessibility properties a real patient or physician
 * would actually hit — landmarks, heading order, labels, contrast on body text,
 * live regions, and a keyboard walk through the whole patient flow.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3100";
const OPEN = "demoopen0000open0000demo0000";

const findings = [];
const note = (where, what) => findings.push(`${where}: ${what}`);

async function measure(page, url, label) {
  let bytes = 0;
  let requests = 0;
  const onResponse = async (res) => {
    requests += 1;
    try {
      const len = Number(res.headers()["content-length"] ?? 0);
      bytes += Number.isFinite(len) ? len : 0;
    } catch {
      /* a response body that cannot be sized is not worth failing over */
    }
  };
  page.on("response", onResponse);
  await page.goto(url, { waitUntil: "networkidle" });
  page.off("response", onResponse);

  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint");
    return {
      domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0),
      loadComplete: Math.round(nav?.loadEventEnd ?? 0),
      firstPaint: Math.round(paint?.startTime ?? 0),
    };
  });
  console.log(
    `${label.padEnd(24)} ${String(requests).padStart(3)} req  ${String(Math.round(bytes / 1024)).padStart(4)} KB  FCP ${String(timing.firstPaint).padStart(4)}ms  DCL ${String(timing.domContentLoaded).padStart(4)}ms`,
  );
  if (timing.firstPaint > 2000) note(label, `first paint ${timing.firstPaint}ms is over 2s`);
  if (bytes / 1024 > 900) note(label, `${Math.round(bytes / 1024)}KB transferred on first load`);
}

/** Relative luminance contrast, the WCAG formula. */
const CONTRAST_FN = `(fg, bg) => {
  const parse = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(parse(fg));
  const b2 = lum(parse(bg));
  return (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
}`;

async function auditA11y(page, label) {
  const issues = await page.evaluate((contrastSrc) => {
    const contrast = eval(`(${contrastSrc})`);
    const out = [];

    if (!document.querySelector("main")) out.push("no <main> landmark");
    if (!document.querySelector("h1")) out.push("no <h1>");
    if (document.querySelectorAll("h1").length > 1) out.push("more than one <h1>");
    if (document.documentElement.lang !== "en") out.push("no lang on <html>");

    // Heading order must not skip a level.
    const levels = [...document.querySelectorAll("h1,h2,h3,h4")].map((h) => Number(h.tagName[1]));
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] - levels[i - 1] > 1) {
        out.push(`heading order skips h${levels[i - 1]} to h${levels[i]}`);
        break;
      }
    }

    // Every form control needs a programmatic label.
    for (const el of document.querySelectorAll("input, textarea, select")) {
      const named =
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby") ||
        (el.labels && el.labels.length > 0) ||
        el.getAttribute("title");
      if (!named) out.push(`${el.tagName.toLowerCase()}#${el.id || "(no id)"} has no label`);
    }

    // Images need alt text; decorative ones need it to be empty and marked.
    for (const img of document.querySelectorAll("img")) {
      if (img.getAttribute("alt") === null) out.push("img with no alt attribute");
    }

    // Body text contrast against its own background.
    // Only rgb()/rgba() backgrounds can be measured here. Modern Chromium
    // serialises a Tailwind alpha utility like `bg-paper/95` as oklab(), whose
    // first three numbers are not channel values — reading them as RGB reports
    // dark text on a light header as 1.17:1. Those layers are skipped and the
    // next opaque ancestor is used, which for this design is the page ground.
    const bgOf = (el) => {
      let node = el;
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        const opaqueRgb = /^rgba?\((\s*\d+\s*,){2}\s*\d+\s*(,\s*(1|0?\.9\d+)\s*)?\)$/.test(bg);
        if (opaqueRgb) return bg;
        node = node.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor || "rgb(255,255,255)";
    };
    const seen = new Set();
    for (const el of document.querySelectorAll("p, li, td, dd, dt, h1, h2, h3, span, button, a")) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || "").trim();
      if (text.length < 4) continue;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      const ratio = contrast(style.color, bgOf(el));
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const required = large ? 3 : 4.5;
      if (ratio < required) {
        const key = `${style.color}|${size}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(`contrast ${ratio.toFixed(2)}:1 (needs ${required}) at ${Math.round(size)}px: "${text.slice(0, 30)}"`);
        }
      }
    }
    return [...new Set(out)];
  }, CONTRAST_FN);

  for (const i of issues) note(label, i);
}

/** The whole patient flow, keyboard only. */
async function keyboardFlow(page) {
  // Intake state lives on the server, so an earlier context that pressed Start
  // has started it for everyone. Reset before walking the flow from the top.
  await fetch(`${BASE}/api/demo/reset`, { method: "POST" }).catch(() => {});
  await page.goto(`${BASE}/intake/${OPEN}`, { waitUntil: "networkidle" });

  const tabTo = async (name) => {
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const el = document.activeElement;
        return (el?.getAttribute("aria-label") || el?.textContent || "").trim();
      });
      if (label.includes(name)) return true;
    }
    return false;
  };

  if (!(await tabTo("Start"))) return note("a11y/keyboard", "cannot reach Start with the keyboard");
  await page.keyboard.press("Enter");
  await page.waitForSelector('textarea[aria-label="Your answer"]', { timeout: 5000 });

  if (!(await tabTo("Your answer"))) return note("a11y/keyboard", "cannot reach the answer box");
  await page.keyboard.type("An itchy rash on both of my arms");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);

  const advanced = await page.evaluate(() => document.querySelectorAll("ol li").length);
  if (advanced < 3) note("a11y/keyboard", "Enter did not submit the answer");

  // A screen reader needs to be told the question changed.
  const live = await page.evaluate(() => document.querySelectorAll("[aria-live]").length);
  if (live === 0) note("a11y/keyboard", "no live region announces the next question");

  // A focus indicator may live on the control or on the wrapper that draws its
  // border, so check a couple of levels up before calling it missing.
  const focusVisible = await page.evaluate(() => {
    let el = document.activeElement;
    if (!el || el === document.body) return false;
    for (let i = 0; i < 3 && el; i += 1) {
      const s = getComputedStyle(el);
      if (s.outlineStyle !== "none" || s.boxShadow !== "none") return true;
      el = el.parentElement;
    }
    return false;
  });
  if (!focusVisible) note("a11y/keyboard", "focus is not visible after submitting");
}

async function main() {
  await fetch(`${BASE}/api/demo/reset`, { method: "POST" }).catch(() => {});
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });

  console.log("screen                   reqs   size   first paint");
  console.log("-".repeat(66));
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mPage = await mobile.newPage();
  await measure(mPage, `${BASE}/intake/${OPEN}`, "patient intake (390)");
  await auditA11y(mPage, "a11y/patient-welcome");
  await mPage.getByRole("button", { name: "Start" }).click();
  await mPage.waitForSelector("textarea");
  await auditA11y(mPage, "a11y/patient-question");
  await mobile.close();

  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dPage = await desk.newPage();
  await measure(dPage, `${BASE}/clinician`, "clinician list (1440)");
  await auditA11y(dPage, "a11y/clinician-list");
  await dPage.locator('a:has-text("Review")').first().click();
  await dPage.waitForSelector("text=Pre-visit brief");
  await auditA11y(dPage, "a11y/clinician-brief");
  await measure(dPage, `${BASE}/demo`, "demo panel (1440)");
  await desk.close();

  const kb = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await keyboardFlow(await kb.newPage());
  await kb.close();

  await browser.close();

  console.log("\n=== FINDINGS ===");
  if (findings.length === 0) console.log("none");
  for (const f of [...new Set(findings)]) console.log(" ! " + f);
}

void main();
