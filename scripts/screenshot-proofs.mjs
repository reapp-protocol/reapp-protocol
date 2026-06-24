import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TESTNET } from "@reapp-sdk/stellar";

// Captures full-page screenshots of the canonical MandateRegistry's on-chain
// activity, for grant/demo materials. Run after building the SDK:
//   npm run build && node scripts/screenshot-proofs.mjs

// Output lives in a gitignored proofs/ dir at the repo root (regenerated artifacts,
// never committed). Never /tmp, per project convention.
const OUT = fileURLToPath(new URL("../proofs", import.meta.url));
mkdirSync(OUT, { recursive: true });

// The contract id comes from the single source of truth (deployments.ts, via the
// SDK), so this script never holds its own copy. stellar.expert is the canonical
// explorer.
const CONTRACT = TESTNET.mandateRegistryId;
const base = "https://stellar.expert/explorer/testnet";
const tx = (h) => `${base}/tx/${h}`;

// The canonical lifecycle, matching the on-chain activity table in
// docs/mandate-registry-contract.md. If the contract is redeployed (deploy.mjs
// updates the id in deployments.ts), refresh these hashes from the new run.
const TARGETS = [
  { name: "01-deploy-create-contract", url: tx("14f0f5b6c6745d0907c6a92e072e9d2ef3e172627d4dc08d5e39ec1c18d706b8"), waitText: "14f0f5b6" },
  { name: "02-register-mandate",       url: tx("c45ca03c96f5d6627a716cda7ed83610c5b0d495860f15bb7a3668bc6bb0bbdd"), waitText: "c45ca03c" },
  { name: "03-execute-payment",        url: tx("237a3832b1ec05901745e97db3dafc61cd553871e16738bbb9dfec5c0404b01a"), waitText: "237a3832" },
  { name: "04-revoke-mandate",         url: tx("fd2fb6a5fc7c795ae89eb26eef4734954eec8eb9583d230e642c442098034625"), waitText: "fd2fb6a5" },
  { name: "05-contract-overview",      url: `${base}/contract/${CONTRACT}`,                                            waitText: CONTRACT.slice(0, 8) },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

let ok = 0;
for (const t of TARGETS) {
  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // dismiss a cookie/consent banner if it appears (non-fatal)
    try { await page.getByRole("button", { name: /accept|decline|agree/i }).first().click({ timeout: 2500 }); } catch {}
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
console.log(`\n${ok}/${TARGETS.length} captured -> ${OUT}`);
process.exit(ok === TARGETS.length ? 0 : 1);
