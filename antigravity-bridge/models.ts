// Model mapping adapted from @firespoon/pi-antigravity-bridge v1.10.16 (MIT).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Api,
  Model,
  ThinkingLevel,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";

/** Reasoning-effort tiers agy accepts via --effort. */
export type AgyEffort = "low" | "medium" | "high" | "xhigh";

/** pi thinking-effort order mirrors agy's, for clamping. */
export const AGY_EFFORT_ORDER: readonly AgyEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Map pi's thinking level onto one of the tiers `efforts` the base actually
 *  supports, clamping to the nearest available. agy rejects an effort tier a
 *  base doesn't list (e.g. medium on Pro), so we never emit one. Shared by the
 *  provider turns AND the AskAntigravity delegation tool (thinking/effort
 *  params): one vocabulary, one clamp. When pi sends no level we fall to the
 *  first available tier. */
export function toAgyEffort(
  reasoning: ThinkingLevel | undefined,
  efforts: readonly AgyEffort[],
): AgyEffort {
  let candidate: AgyEffort;
  switch (reasoning) {
    case "minimal":
    case "low":
      candidate = "low";
      break;
    case "medium":
      candidate = "medium";
      break;
    case "high":
      candidate = "high";
      break;
    case "xhigh":
    case "max":
      candidate = "xhigh";
      break;
    default:
      candidate = efforts[0] ?? "low";
  }
  if (efforts.includes(candidate)) return candidate;
  const i = AGY_EFFORT_ORDER.indexOf(candidate);
  for (let j = i; j < AGY_EFFORT_ORDER.length; j++) {
    if (efforts.includes(AGY_EFFORT_ORDER[j])) return AGY_EFFORT_ORDER[j];
  }
  for (let j = i - 1; j >= 0; j--) {
    if (efforts.includes(AGY_EFFORT_ORDER[j])) return AGY_EFFORT_ORDER[j];
  }
  return efforts[0] ?? "low";
}

/** Split a recognized effort suffix from the native model slug. */
const TIER_RE = /^(.+)-(xhigh|high|medium|low)$/;

/** agy emits clean slug ids (gemini-3.6-flash-high). Validate col1 of each
 *  line so a banner / auth / "Fetching models…" line can't register as a
 *  model, and a leading-dash token (e.g. "-high") can't reach agy's flag
 *  parser as --model. First char must be alphanumeric; the slug must contain
 *  at least one hyphen (every real agy slug does: family-version-name), which
 *  also drops a prose banner word split out of col1 ("Available"). */
const MODEL_LINE_RE = /^[A-Za-z0-9][A-Za-z0-9._]*-[A-Za-z0-9._-]*$/;

/** Model families VERIFIED to accept base-slug + --effort. Only these collapse
 *  to a base slug with a thinking toggle. Any other family stays as agy's exact
 *  qualified slug (always valid on its own), so an unknown or fixed-thinking
 *  family degrades safely instead of forcing an unsupported --effort. Add a
 *  family here only after confirming base+--effort is accepted for it.
 *  Claude 5.5 verified live 2026-10: base+--effort accepted; a bare base is
 *  rejected ("requires --effort"). */
const EFFORT_CAPABLE_FAMILIES: readonly RegExp[] = [/^gemini-/, /^claude-/];

/** Families dropped outright, even while `agy models` still lists them: the
 *  fixed-thinking single slug loses to the cheaper effort-tiered options and
 *  its removal upstream is already announced, so we stop offering it now. */
const HIDDEN_FAMILY_RE = /^gpt-oss-/;

export interface AgyModelEntry {
  /** Exact agy --model string to pass: a base slug ("gemini-3.8-flash") when
   *  effort-driven, else agy's full qualified slug (unverified family). */
  full: string;
  /** pi model id, e.g. "gemini-3-8-flash". */
  id: string;
  /** Present iff this is an effort-driven base slug. Lists the tiers agy
   *  accepts for it; pi's thinking toggle picks among them and we always pass
   *  --effort. Absent => fixed model, never pass --effort. */
  efforts?: AgyEffort[];
}

/** Parse raw `agy models` text into the provider's model entries.
 *
 *  Effort-driven bases (>= 2 tier variants in the catalog, verified
 *  effort-capable family) collapse to one BASE-slug entry carrying the tiers
 *  they accept. Models with 0 or 1 tier variants keep agy's exact qualified
 *  slug: without a verified effort-capable family match, --effort is never
 *  risked. Hidden families are dropped outright. Insertion order of
 *  first-seen bases is preserved. */
export function entriesFromRaw(raw: string): AgyModelEntry[] {
  // agy prints TWO columns: "<slug>  <display label>". --model takes only the
  // slug, so split col1 and validate THAT; the label is display-only. A
  // bare-slug line (no whitespace) splits to itself, so this also tolerates
  // the legacy one-column shape.
  const groups = new Map<string, { lines: string[]; tiers: Set<AgyEffort> }>();
  for (const line of raw.split("\n")) {
    const slug = line.trim().split(/\s+/)[0] ?? "";
    if (!slug || !MODEL_LINE_RE.test(slug)) continue;
    if (HIDDEN_FAMILY_RE.test(slug)) continue;
    const m = TIER_RE.exec(slug);
    const base = m ? (m[1] as string) : slug;
    const tier = m ? (m[2] as AgyEffort) : null;
    let g = groups.get(base);
    if (!g) {
      g = { lines: [], tiers: new Set<AgyEffort>() };
      groups.set(base, g);
    }
    g.lines.push(slug);
    if (tier) g.tiers.add(tier);
  }
  const entries: AgyModelEntry[] = [];
  for (const [base, g] of groups) {
    const efforts = AGY_EFFORT_ORDER.filter((tier) => g.tiers.has(tier));
    if (
      efforts.length >= 2 &&
      EFFORT_CAPABLE_FAMILIES.some((re) => re.test(base))
    ) {
      entries.push({ full: base, id: slugify(base), efforts });
    } else {
      for (const line of g.lines)
        entries.push({ full: line, id: slugify(line) });
    }
  }
  return [
    ...new Map(
      entries.filter((e) => e.id.length > 0).map((e) => [e.id, e]),
    ).values(),
  ];
}

/** "Gemini 3.6 Flash (Medium)" -> "gemini-3-6-flash-medium".
 *  Lowercase, non-alphanumerics -> "-", collapsed, trimmed. */
export function slugify(full: string): string {
  return full
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build the thinkingLevelMap for an effort-driven base: hide "off" and
 *  "minimal" always (agy has no no-thinking mode; a base REQUIRES an effort),
 *  and hide any basic tier the base doesn't offer. Pi requires an explicit
 *  mapping for extended tiers, even when the native value has the same name. */
function thinkingLevelMapFor(efforts: readonly AgyEffort[]): ThinkingLevelMap {
  const map: Record<string, string | null> = { off: null, minimal: null };
  for (const level of ["low", "medium", "high"] as const) {
    if (!efforts.includes(level)) map[level] = null;
  }
  if (efforts.includes("xhigh")) map.xhigh = "xhigh";
  return map as ThinkingLevelMap;
}

/** Project an agy entry to pi's Model shape. `input` advertises accepted
 *  inputs; both engines accept images (ACP native content blocks,
 *  stream-json staged files), so callers pass ["text", "image"] uniformly. */
export function toPiModel(
  entry: AgyModelEntry,
  input: Array<"text" | "image"> = ["text"],
): Model<Api> {
  const effortDriven = !!entry.efforts && entry.efforts.length > 0;
  return {
    id: entry.id,
    name: entry.full,
    api: "pocket-agy-acp" as Api,
    provider: "antigravity",
    // baseUrl/apiKey are not used (streamSimple intercepts everything), but
    // pi requires non-empty values. The "pocket-agy-acp" api string is a custom
    // sentinel that no built-in provider claims, so it can never collide.
    baseUrl: "pocket-agy-acp://antigravity",
    // reasoning=true only for effort-driven bases => pi shows the toggle.
    // Unverified families get no toggle: --effort support is unknown, so
    // none is ever sent.
    reasoning: effortDriven,
    ...(effortDriven
      ? { thinkingLevelMap: thinkingLevelMapFor(entry.efforts!) }
      : {}),
    // Input advertising comes from the caller: both engines deliver
    // user-attached images now.
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Gemini long context. agy doesn't expose the real per-model window in
    // `agy models`; 1M is the documented Gemini ceiling.
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  };
}

/** Fallback catalog used when `agy models` fails at load (binary missing,
 *  auth not yet done, network stall). Keeps the picker populated so the user
 *  can still select a model and get a clear runtime error instead of an empty
 *  list. Update these when agy ships new Gemini versions. */
export const FALLBACK_MODELS: AgyModelEntry[] = [
  // First entry = offline picker default; keep it aligned with the configured
  // AskAntigravity default (config.ts) so the default stays resolvable when
  // `agy models` fails.
  {
    full: "gemini-4-hydrogen",
    id: "gemini-4-hydrogen",
    efforts: ["low", "medium", "high"],
  },
  {
    full: "gemini-3.8-flash",
    id: "gemini-3-8-flash",
    efforts: ["low", "medium", "high"],
  },
  { full: "gemini-3.1-pro", id: "gemini-3-1-pro", efforts: ["low", "high"] },
  {
    full: "claude-sonnet-5-5",
    id: "claude-sonnet-5-5",
    efforts: ["low", "medium", "high"],
  },
];

export async function versionStatus(bin: string, signal?: AbortSignal) {
  const tested = "1.5.16";
  try {
    const { stdout } = await promisify(execFile)(bin, ["--version"], {
      timeout: 3000,
      maxBuffer: 4096,
      signal,
    });
    const version = stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    if (version)
      return `agy --version: ${version}.${version === tested ? "" : ` Warning: tested with ${tested}.`}`;
  } catch {
    // Do not expose raw CLI output.
  }
  return "Could not read `agy --version`. Check the configured binary and PATH.";
}

export async function discover(bin: string, signal?: AbortSignal) {
  try {
    const { stdout } = await promisify(execFile)(bin, ["models"], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      signal,
    });
    return entriesFromRaw(stdout);
  } catch {
    return [];
  }
}
