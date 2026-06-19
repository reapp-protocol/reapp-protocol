import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Output lives inside the repo (example-output/screenshots), never /tmp.
const OUT = fileURLToPath(new URL("../example-output/screenshots", import.meta.url));
mkdirSync(OUT, { recursive: true });

const CONTRACT = "CB4KOTLGMM5JEPFPU6QBJLADIBP3RSGUX44FOYTFRICNXKKFPYIW7ZOA";
const tx = (h) => `https://testnet.stellarchain.io/tx/${h}`;

// waitText = a string that only appears once the page's client-side data has rendered.
const TARGETS = [
  { name: "01-approve",               url: tx("bf3db709d2724b42565fb569b9c130e23c32642645eecde3cfaaaf42d8106b8d"), waitText: "bf3db709" },
  { name: "02-register-mandate",      url: tx("fba8d71bcb95ef71d7e01dec583491d0790b599136e8a45fb18dd0bb30c38f42"), waitText: "fba8d71b" },
  { name: "03-validate-and-consume",  url: tx("50c8f482e8f809eb5bc076e5d5ad286f8dc33cb9d03f9935ca0de72230c893c0"), waitText: "50c8f482" },
  { name: "04-execute-payment",       url: tx("d4814ab9baa927f2276116e57f3b0384e1b21e67a3aa6ea1907869efcff910ab"), waitText: "d4814ab9" },
  { name: "05-revoke-mandate",        url: tx("4ea9f8b1e4fea05afc7526ffebeceb88804f18541c529db67745f1ba1f4a6132"), waitText: "4ea9f8b1" },
  { name: "06-unauthorized-FAILED",   url: tx("18214372c9b13d3679808101773d8c372a2438cf2ab96e336c35e1753b0eadd2"), waitText: "18214372" },
  { name: "07-contract-overview",     url: `https://testnet.stellarchain.io/contracts/${CONTRACT}`,                    waitText: "Contract Details" },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

let ok = 0;
for (const t of TARGETS) {
  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // dismiss cookie banner if it appears (non-fatal)
    try { await page.getByRole("button", { name: /accept|decline/i }).first().click({ timeout: 2500 }); } catch {}
    // the real gate: wait until the data has actually rendered into the DOM
    await page.waitForFunction(
      (needle) => document.body && document.body.innerText.includes(needle),
      t.waitText,
      { timeout: 45000 },
    );
    await page.waitForTimeout(800); // let layout/fonts settle
    const file = `${OUT}/${t.name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(`OK    ${t.name}`);
    ok++;
  } catch (e) {
    console.log(`FAIL  ${t.name}  (${String(e).split("\n")[0].slice(0, 80)})`);
  }
}
await browser.close();
console.log(`\n${ok}/${TARGETS.length} captured`);
process.exit(ok === TARGETS.length ? 0 : 1);
