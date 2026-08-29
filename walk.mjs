import { chromium } from "playwright";

const BASE = "http://localhost:3100";
const SHOTS = process.env.SHOTS;
const TOKEN = "demoacne0000acne0000demo0000";

const ANSWERS = [
  "I've been breaking out really badly on my jaw and chin for about a year and it's leaving marks",
  "Mostly jawline and chin, some on my chest. It's definitely leaving dark marks and a couple of small scars",
  "Started around a year ago, maybe a bit longer. It's been getting worse the last few months",
  "I used a benzoyl peroxide wash from the drugstore and a clindamycin gel my doctor gave me. The wash dried me out and the gel helped a little at first",
  "It gets worse before my period and when I'm stressed with exams",
  "It really bothers me, I don't want to go out without makeup",
  "I'm not on any medication. No allergies that I know of",
  "I want it to stop scarring. And I want to know if I need something stronger",
];

await fetch(`${BASE}/api/demo/reset`, { method: "POST" });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

const shot = async (name) => { await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); console.log("shot:", name); };

// --- patient, iPhone-sized ---------------------------------------------------
await page.goto(`${BASE}/intake/${TOKEN}`, { waitUntil: "networkidle" });
await shot("01-patient-welcome-390");
console.log("welcome heading:", await page.locator("h1").innerText());

await page.getByRole("button", { name: "Start" }).click();
await page.waitForSelector("textarea");
await shot("02-patient-first-question-390");

let asked = 0;
for (const a of ANSWERS) {
  const ta = page.locator('textarea[aria-label="Your answer"]');
  if (await ta.count() === 0) break;
  await ta.fill(a);
  await page.getByRole("button", { name: "Send answer" }).click();
  asked += 1;
  await page.waitForTimeout(600);
  if (asked === 3) await shot("03b-patient-midconversation-390");
  if (await page.locator("text=Want to add a photo").count() > 0) break;
}
console.log("answers sent:", asked);
await shot("03-patient-conversation-390");

await page.waitForSelector("text=Want to add a photo", { timeout: 8000 });
await shot("04-patient-photos-390");

// Upload two synthetic images through the real file input.
const mk = (w, h, hue) => {
  const canvasScript = ({ w, h, hue }) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${hue},30%,55%)`); g.addColorStop(1, `hsl(${hue},25%,35%)`);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = "rgba(255,255,255,.8)"; x.font = "28px sans-serif";
    x.fillText("SYNTHETIC TEST IMAGE", 30, h / 2);
    return c.toDataURL("image/jpeg", 0.9);
  };
  return page.evaluate(canvasScript, { w, h, hue });
};
const dataUrls = [await mk(1200, 900, 20), await mk(1000, 1000, 200)];
const files = dataUrls.map((d, i) => ({
  name: `photo${i}.jpg`,
  mimeType: "image/jpeg",
  buffer: Buffer.from(d.split(",")[1], "base64"),
}));
await page.locator('input[type="file"]').setInputFiles(files);
await page.waitForTimeout(1500);
await shot("05-patient-photos-added-390");
console.log("photos on screen:", await page.locator("figure").count());

await page.getByRole("button", { name: /Continue|Skip photos/ }).click();
await page.waitForSelector("text=Here’s what you told us", { timeout: 8000 });
await shot("06-patient-review-390");

// Edit one answer to prove corrections stick.
await page.getByRole("button", { name: "Edit" }).first().click();
const edit = page.locator("textarea").first();
await edit.fill("Breaking out along my jaw and chin for a bit over a year, leaving dark marks");
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(800);
await shot("07-patient-review-edited-390");

await page.getByRole("button", { name: /Send this to my dermatologist/ }).click();
await page.waitForSelector("text=That’s everything", { timeout: 10000 });
await shot("08-patient-done-390");

// --- clinician ---------------------------------------------------------------
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const cp = await desk.newPage();
cp.on("pageerror", (e) => errors.push(`clinician pageerror: ${e.message}`));
cp.on("console", (m) => { if (m.type() === "error") errors.push(`clinician console: ${m.text()}`); });

await cp.goto(`${BASE}/clinician`, { waitUntil: "networkidle" });
await cp.screenshot({ path: `${SHOTS}/10-clinician-list-1440.png`, fullPage: true });
const rows = await cp.locator("tbody tr").count();
console.log("clinician rows:", rows);

await cp.locator('a:has-text("Review")').first().click();
await cp.waitForSelector("text=Pre-visit brief", { timeout: 8000 });
await cp.screenshot({ path: `${SHOTS}/11-clinician-brief-1440.png`, fullPage: true });
console.log("brief headline:", await cp.locator("h1").innerText());

await cp.getByRole("button", { name: "Show patient's own words" }).click();
await cp.waitForTimeout(300);
await cp.screenshot({ path: `${SHOTS}/12-clinician-brief-provenance-1440.png`, fullPage: true });

await cp.locator("#f-exam").fill("Flexural erythematous plaques with excoriation, both antecubital fossae and anterior neck.");
await cp.locator("#f-assessment").fill("Atopic dermatitis flare.");
await cp.locator("#f-plan").fill("Triamcinolone 0.1% ointment BID x 2 weeks to body, hydrocortisone 2.5% to neck. Emollient and bathing education.");
await cp.locator("#f-medications").fill("Triamcinolone 0.1% ointment 60g; hydrocortisone 2.5% ointment 30g");
await cp.locator("#f-followUp").fill("6 weeks, sooner if worsening.");
await cp.locator("#f-followUp").blur();
await cp.waitForTimeout(600);
await cp.getByRole("button", { name: "Generate draft note" }).click();
await cp.waitForSelector('textarea[aria-label="Draft clinical note"]', { timeout: 8000 });
await cp.waitForTimeout(400);
await cp.screenshot({ path: `${SHOTS}/13-clinician-note-1440.png`, fullPage: true });
const note = await cp.locator('textarea[aria-label="Draft clinical note"]').inputValue();
console.log("note has HPI block:", note.includes("HISTORY OF PRESENT ILLNESS"));
console.log("note has exam block:", note.includes("EXAMINATION (clinician-entered)"));

// Responsive passes
for (const [w, h, name] of [[768, 1024, "tablet"], [1920, 1080, "desktop"]]) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const p = await c.newPage();
  await p.goto(cp.url(), { waitUntil: "networkidle" });
  await p.screenshot({ path: `${SHOTS}/14-clinician-brief-${name}-${w}.png`, fullPage: true });
  await p.goto(`${BASE}/intake/demoopen0000open0000demo0000`, { waitUntil: "networkidle" });
  await p.screenshot({ path: `${SHOTS}/15-patient-${name}-${w}.png`, fullPage: true });
  await c.close();
}

// Home page
const hp = await desk.newPage();
await hp.goto(BASE, { waitUntil: "networkidle" });
await hp.screenshot({ path: `${SHOTS}/00-home-1440.png`, fullPage: true });

console.log("ERRORS:", errors.length ? JSON.stringify(errors, null, 1) : "none");
await browser.close();
