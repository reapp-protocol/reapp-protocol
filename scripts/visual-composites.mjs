#!/usr/bin/env node
/**
 * Visual UI test for the /composites demo route in reapp-protocol-demo.
 *
 *   1. cd ../reapp-protocol-demo && npm run build && npm start
 *   2. node scripts/visual-composites.mjs
 *
 * Drives a full live group-buy run in headless Chromium against the local
 * server (which itself runs the real flow on Stellar testnet), captures
 * temporary visual artifacts at each story beat, and asserts the run reaches the cleared
 * state with all three buyers captured at the uniform price.
 *
 * Output lives in the gitignored proofs/ dir at the repo root (regenerated
 * artifacts, never committed). Never /tmp, per project convention.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../proofs/composites-ui", import.meta.url));
mkdirSync(OUT, { recursive: true });

const BASE = process.env.DEMO_BASE ?? "http://127.0.0.1:3000";
const shot = (page, name, opts = {}) =>
  page.screenshot({ path: `${OUT}/${name}.png`, ...opts }).then(() => console.log(`  capture ${name}.png`));

const failures = [];
const check = (label, ok) => {
  console.log(`  ${ok ? "✓" : "✖"} ${label}`);
  if (!ok) failures.push(label);
};

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Skip the once-per-session 3D intro so captures start at the page itself.
  await context.addInitScript(() => sessionStorage.setItem("reapp_intro_seen_v1", "1"));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`);
  });

  console.log(`\n▸ loading ${BASE}/composites`);
  await page.goto(`${BASE}/composites`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200); // let the header animation land
  await shot(page, "01-initial", { fullPage: true });
  check("headline renders", await page.getByText("cleared on-chain").first().isVisible());
  check("run button present", await page.getByRole("button", { name: /Run the group buy/ }).isVisible());

  console.log("\n▸ starting the live run (testnet; includes the deadline auction)");
  await page.getByRole("button", { name: /Run the group buy/ }).click();

  // Pool registered → terms card fills in.
  await page.getByText("vendor minimum").first().waitFor({ timeout: 90_000 });
  await page.getByText(/pool [0-9a-f]{4}…[0-9a-f]{4}/).waitFor({ timeout: 90_000 });
  console.log("  pool registered");

  // All three buyers committed → simulate fires → progress reads 9 / 9.
  await page.getByText("9 / 9 units").waitFor({ timeout: 180_000 });
  console.log("  three buyers committed, simulate fired");
  await page.waitForTimeout(800);
  await shot(page, "02-buyers-committed", { fullPage: true });
  check("simulate panel shows clearing price", await page.getByText("clearing price:").isVisible());
  check(
    "early clear refusal proven",
    await page
      .getByText("DeadlineNotReached", { exact: false })
      .first()
      .isVisible()
      .catch(() => false),
  );

  // Countdown beat.
  const countdown = page.locator("text=/^\\d+s$/").first();
  if (await countdown.isVisible().catch(() => false)) {
    await shot(page, "03-deadline-countdown");
    console.log("  countdown visible");
  }

  // The capture. Wait for the punchline banner.
  await page.getByText("settled at", { exact: false }).first().waitFor({ timeout: 300_000 });
  await page.waitForTimeout(1500); // balances + double-clear proof land right after
  await shot(page, "04-cleared", { fullPage: true });
  console.log("  pool cleared");

  check(
    "uniform legs on all three buyer cards",
    (await page.getByText("13.5 XLM").count()) >= 3,
  );
  check(
    "double clear refusal proven",
    await page
      .getByText("PoolNotOpen", { exact: false })
      .first()
      .isVisible()
      .catch(() => false),
  );
  check(
    "capture tx link present",
    await page.getByRole("link", { name: /capture transaction/ }).isVisible(),
  );
  check(
    "activity log has explorer links",
    (await page.locator("section a[href*='stellar.expert/explorer/testnet/tx/']").count()) >= 8,
  );

  // Mobile framing of the landed state (layout check, no second live run).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await shot(page, "05-cleared-mobile", { fullPage: true });

  if (consoleErrors.length) {
    console.log("\n▸ browser console errors:");
    for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
    failures.push(`console errors: ${consoleErrors.length}`);
  } else {
    console.log("\n  ✓ no browser console errors");
  }

  await browser.close();
  console.log(
    failures.length
      ? `\n✖ visual test finished with ${failures.length} failure(s): ${failures.join(" · ")}`
      : "\n✦ visual test passed — artifacts in proofs/composites-ui/",
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`✖ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
