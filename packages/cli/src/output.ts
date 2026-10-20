/** Human vs JSON output, plus the shared exit-code and formatting helpers. */

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
} as const;

export type OutputStyle = keyof typeof ANSI;

export class Output {
  readonly json: boolean;
  readonly color: boolean;

  constructor(json: boolean, opts: { color?: boolean } = {}) {
    this.json = json;
    this.color = opts.color ?? true;
  }

  /** Apply ANSI styling when color is enabled. */
  paint(text: string, style: OutputStyle): string {
    if (!this.color) return text;
    return `${ANSI[style]}${text}${ANSI.reset}`;
  }

  line(text = ""): void {
    process.stdout.write(`${text}\n`);
  }

  data(value: unknown): void {
    if (this.json) this.line(JSON.stringify(value, null, 2));
  }

  /** Error goes to stderr; JSON mode keeps it machine-readable on stdout too. */
  error(message: string, code?: string): void {
    if (this.json) process.stderr.write(`${JSON.stringify({ error: message, code: code ?? "error" })}\n`);
    else process.stderr.write(`${this.paint("error:", "red")} ${message}\n`);
  }

  warn(message: string): void {
    process.stderr.write(`${this.paint("warning:", "yellow")} ${message}\n`);
  }
}

/** Right-pad to a display width (ASCII-only CLI table cells). */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Render an epoch-ms timestamp as a short ISO date (UTC days are fine for lists). */
export function shortDate(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One-line memory summary shared by search/read/list style commands. */
export function formatHit(hit: {
  id: string;
  title: string;
  type: string;
  scope: string;
  updated: number;
  score?: number;
  pinned?: boolean;
  status?: string;
}): string {
  const flags = [hit.pinned ? "pinned" : "", hit.status && hit.status !== "active" ? hit.status : ""]
    .filter(Boolean)
    .join(",");
  const score = typeof hit.score === "number" ? ` score=${hit.score.toFixed(3)}` : "";
  return `[${hit.type}/${hit.scope}${flags ? `/${flags}` : ""}] ${hit.id} ${hit.title} (${shortDate(hit.updated)}${score})`;
}
