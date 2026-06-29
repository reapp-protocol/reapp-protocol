/**
 * Terminal output: dependency-free ANSI colors + a tagged logger. Ported from
 * reapp-protocol-demo/lib/log.ts so the CLI and the hosted demo speak the same
 * visual language. Keep this dependency-free — it ships in the published bin.
 */

const E = "\x1b[";
const wrap = (open: string, s: string, close = "39") => `${E}${open}m${s}${E}${close}m`;

export const c = {
  reset: `${E}0m`,
  bold: (s: string) => `${E}1m${s}${E}22m`,
  dim: (s: string) => `${E}2m${s}${E}22m`,
  mint: (s: string) => wrap("38;5;121", s),
  emerald: (s: string) => wrap("38;5;48", s),
  green: (s: string) => wrap("38;5;42", s),
  teal: (s: string) => wrap("38;5;43", s),
  cyan: (s: string) => wrap("38;5;51", s),
  deep: (s: string) => wrap("38;5;30", s),
  gray: (s: string) => wrap("38;5;245", s),
  white: (s: string) => wrap("38;5;231", s),
  amber: (s: string) => wrap("38;5;215", s),
  red: (s: string) => wrap("38;5;203", s),
};

type Tag = "INFO" | "OK" | "CHAIN" | "WARN" | "ERR" | "STEP";
const TAGS: Record<Tag, (s: string) => string> = {
  INFO: c.cyan,
  OK: c.green,
  CHAIN: c.emerald,
  WARN: c.amber,
  ERR: c.red,
  STEP: c.gray,
};

function line(tag: Tag, msg: string, extra?: Record<string, unknown>) {
  const tail = extra
    ? " " +
      Object.entries(extra)
        .map(([k, v]) => c.gray(k + "=") + c.white(String(v)))
        .join(" ")
    : "";
  console.log(`${c.emerald("⬢")} ${c.bold(TAGS[tag](tag.padEnd(5)))} ${msg}${tail}`);
}

export const log = {
  info: (m: string, x?: Record<string, unknown>) => line("INFO", m, x),
  ok: (m: string, x?: Record<string, unknown>) => line("OK", m, x),
  chain: (m: string, x?: Record<string, unknown>) => line("CHAIN", m, x),
  warn: (m: string, x?: Record<string, unknown>) => line("WARN", m, x),
  err: (m: string, x?: Record<string, unknown>) => line("ERR", m, x),
  step: (m: string, x?: Record<string, unknown>) => line("STEP", m, x),
};

/**
 * REAPP banner: figlet "ANSI Shadow", each letter painted its own neon brand
 * shade. Ported verbatim from reapp-protocol-demo/lib/banner.ts so the CLI and
 * the hosted demo share one wordmark.
 */
type Seg = [string, keyof typeof c];
const ART: Seg[][] = [[["██████╗ ","cyan"],["███████╗","mint"],[" █████╗ ","emerald"],["██████╗ ","teal"],["██████╗ ","green"]],[["██╔══██╗","cyan"],["██╔════╝","mint"],["██╔══██╗","emerald"],["██╔══██╗","teal"],["██╔══██╗","green"]],[["██████╔╝","cyan"],["█████╗  ","mint"],["███████║","emerald"],["██████╔╝","teal"],["██████╔╝","green"]],[["██╔══██╗","cyan"],["██╔══╝  ","mint"],["██╔══██║","emerald"],["██╔═══╝ ","teal"],["██╔═══╝ ","green"]],[["██║  ██║","cyan"],["███████╗","mint"],["██║  ██║","emerald"],["██║     ","teal"],["██║     ","green"]],[["╚═╝  ╚═╝","cyan"],["╚══════╝","mint"],["╚═╝  ╚═╝","emerald"],["╚═╝     ","teal"],["╚═╝     ","green"]]];

export function banner(): string {
  const paint = (col: keyof typeof c, t: string) => (c[col] as (s: string) => string)(t);
  const art = ART.map((row) => "  " + row.map(([t, col]) => paint(col, t)).join("")).join("\n");
  const tag =
    "  " +
    c.dim("agent payments") + c.emerald(" · ") +
    c.dim("enforced on-chain") + c.emerald(" · ") +
    c.dim("stellar testnet");
  return art + "\n" + tag;
}
