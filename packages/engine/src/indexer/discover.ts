// packages/engine/src/indexer/discover.ts
//
// Platform discovery. Membership and shape come from @spec-engine/platform-map
// (this is the one engine file that imports its map() and locate()), each
// member's pin comes from its spec-engine.member.json, and the platform
// version is derived from the domain files. Nothing here touches the index.

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type Locations,
  locate,
  type Diagnostic as MapDiagnostic,
  type Package as MapPackage,
  type Repo as MapRepo,
  map,
  type PlatformMap,
} from "@spec-engine/platform-map";
import {
  DiagnosticCode,
  NotASpecPlatformError,
  type PlatformMode,
  type Repo,
  type SpecConfig,
  SpecConfigSchema,
} from "@spec-engine/shared";
import {
  CANONICAL_SPECS_DIR,
  isExistingDir,
  MEMBER_CONFIG_FILENAME,
  PLATFORM_MANIFEST_FILENAME,
} from "../constants";
import { parseDomainJsonFile } from "../parser/domainJson";
import { findDomainJsonFiles } from "../scanner/fs";

/** The not-a-platform message the `map` / `index` / `check` boundaries print. */
export function formatNotASpecPlatform(platformDir: string): string {
  return [
    `${platformDir} is not a Spec Engine platform yet (no spec-engine/ directory).`,
    "A platform directory must contain a canonical spec-engine/ folder holding your SPEC.md requirements.",
    "To get your first spec completed:",
    "  spec domain new <KEY>   scaffold spec-engine/<KEY>/SPEC.md (e.g. spec domain new BILLING)",
    "  spec req <KEY>          author your first requirement interactively",
    "To see a worked example, run:  spec map fixtures/platform-fixture",
    'For the full walkthrough, see the "Getting started" section of the README.',
  ].join("\n");
}

/** The indexed-but-empty guidance a read command prints on stderr, still exiting 0. */
export function formatNoRequirementsIndexed(platformDir: string): string {
  return [
    `No requirements indexed at ${platformDir}.`,
    "To get your first spec completed:",
    "  spec domain new <KEY>   scaffold spec-engine/<KEY>/SPEC.md (e.g. spec domain new BILLING)",
    "  spec req <KEY>          author your first requirement interactively",
    "Then re-run `spec index` followed by this command.",
    "To see a worked example: spec map fixtures/platform-fixture",
  ].join("\n");
}

/**
 * Throws `NotASpecPlatformError` when `<platformDir>/spec-engine` is absent.
 * A command boundary calls this before it creates `.spec-engine/` or opens
 * the index, so a failed run leaves no artifact behind.
 */
export function assertSpecPlatform(platformDir: string): void {
  const absPlatform = resolve(platformDir);
  if (!isExistingDir(join(absPlatform, CANONICAL_SPECS_DIR))) {
    throw new NotASpecPlatformError(absPlatform);
  }
}

/** Read and validate a `spec-engine.member.json`; every failure is a location-tagged error. */
export async function readRepoConfig(configPath: string): Promise<SpecConfig> {
  let text: string;
  try {
    text = await Bun.file(configPath).text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`spec-engine.member.json at ${configPath} could not be read: ${msg}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`spec-engine.member.json at ${configPath} failed to parse as JSON: ${msg}`);
  }
  try {
    return SpecConfigSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`spec-engine.member.json at ${configPath} failed validation: ${msg}`);
  }
}

/** The integer pin in a `spec-engine@N` string. */
function extractPin(specs: string): number {
  const m = specs.match(/^spec-engine@(\d+)$/);
  if (!m) {
    throw new Error(`expected 'spec-engine@N', got ${JSON.stringify(specs)}`);
  }
  return Number.parseInt(m[1] ?? "", 10);
}

/**
 * The derived platform version: the maximum of the domains' derived versions
 * under `spec-engine/`, default 1. Every file goes through the one reader; a
 * file the reader rejects contributes nothing here and is reported as
 * INVALID_DOMAIN_FILE by the parse stage.
 */
export async function derivePlatformVersion(platformDir: string): Promise<number> {
  // @spec SCHM-022
  // @spec SCHM-023
  // @spec INIT-029
  const canonicalPath = join(resolve(platformDir), CANONICAL_SPECS_DIR);
  const jsonPaths = await findDomainJsonFiles(canonicalPath);
  let version = 1;
  for (const rel of jsonPaths) {
    let text: string;
    try {
      text = await Bun.file(join(canonicalPath, rel)).text();
    } catch {
      continue;
    }
    const result = parseDomainJsonFile({
      text,
      sourceFile: `${CANONICAL_SPECS_DIR}/${rel}`,
      fallbackKey: basename(dirname(rel)),
    });
    if (result.ok) version = Math.max(version, result.spec.spec_version);
  }
  return version;
}

/** A stray retired `spec-engine.platform.json` is ignored, never parsed; this says why on stderr. */
export function warnIfRetiredManifest(platformDir: string, derivedVersion: number): void {
  const manifestPath = join(resolve(platformDir), CANONICAL_SPECS_DIR, PLATFORM_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return;
  console.error(
    `spec: warning: ${manifestPath} is retired and ignored — the platform version is ` +
      `derived from the domain SPEC.json files (currently ${derivedVersion}). Delete the file.`,
  );
}

/** A directory named by its platform-map member name. */
export interface NamedDir {
  name: string;
  /** Absolute path on this machine. */
  path: string;
}

/** The platform-map codes `spec check` surfaces as rows of its own. */
export type PlatformMapCode = Extract<
  DiagnosticCode,
  | "MALFORMED_FILE"
  | "MEMBER_MISSING"
  | "MARKER_MISSING"
  | "MARKER_MISMATCH"
  | "UNLISTED_REPO"
  | "PLATFORM_NOT_LOCATED"
  | "UNDECLARED_PLATFORM"
  | "SCAN_TRUNCATED"
>;

/** A platform-map diagnostic in Spec Engine's words: same code, the severity `spec check` reports. */
export interface PlatformDiagnostic {
  code: PlatformMapCode;
  severity: "error" | "warning";
  /** A member name, a package path, or a filename. */
  subject: string;
  detail: string;
}

export interface DiscoveredPlatform {
  /** The `spec-engine/` row, pinned to the derived platform version. */
  canonical: Repo;
  platformVersion: number;
  mode: PlatformMode;
  /** One coverage column per member or workspace package, sorted by name. */
  members: Repo[];
  /** Declared members present on disk without a `spec-engine.member.json`. */
  unpinned: NamedDir[];
  /** Repositories in the platform folder that the platform file does not list. */
  undeclared: NamedDir[];
  diagnostics: PlatformDiagnostic[];
}

/** platform-map's map and the absolute paths that go with it. */
export interface PlatformReading {
  mapped: PlatformMap;
  located: Locations;
}

/**
 * platform-map's view of `dir`, or null when platform-map's starting directory
 * is an ancestor of `dir`. A directory that is neither a repository root nor
 * a declared platform (a spec tree kept inside a larger repository) is not a
 * start platform-map recognizes, and Spec Engine maps it as a lone single repo.
 */
export function readPlatformMap(dir: string): PlatformReading | null {
  const abs = resolve(dir);
  const located = locate(abs);
  if (located.root !== abs) return null;
  return { mapped: map(abs), located };
}

/** @spec SERV-026 */
export function platformName(platformDir: string): string {
  return readPlatformMap(platformDir)?.mapped.name ?? basename(resolve(platformDir));
}

/** The shape platform-map reports for `platformDir`. */
export function platformMode(platformDir: string): PlatformMode {
  return readPlatformMap(platformDir)?.mapped.mode ?? "single-repo";
}

/** Whether `dir` is the engine's own checkout: the map's root repo is the engine package. */
export function isEnginePlatform(dir: string, enginePackageName: string): boolean {
  const reading = readPlatformMap(dir);
  return reading?.mapped.repos[0]?.packageName === enginePackageName;
}

/** Where a member directory belongs. */
export interface MemberLocation {
  /** The platform root: a directory holding `spec-engine/`. */
  root: string;
  /** The member name when platform-map lists `dir` as a member of `root`. */
  member: string | null;
  /** Whether `root` is the parent directory of `dir`. */
  conventional: boolean;
}

/**
 * The platform `dir` belongs to: the platform that lists it as a member (by
 * the child-directory convention or through the per-user file); else its
 * parent when the parent holds `spec-engine/`; else platform-map's located
 * root when that holds `spec-engine/`; else null.
 * @spec INIT-034
 */
export function locateMember(dir: string): MemberLocation | null {
  const abs = resolve(dir);
  const located = locate(abs);
  const above = located.root !== abs;
  if (above) {
    const member = Object.entries(located.repos).find(([, path]) => path === abs)?.[0];
    if (member !== undefined) {
      return { root: located.root, member, conventional: dirname(abs) === located.root };
    }
  }
  const parent = dirname(abs);
  if (parent !== abs && isExistingDir(join(parent, CANONICAL_SPECS_DIR))) {
    return { root: parent, member: null, conventional: true };
  }
  if (above && isExistingDir(join(located.root, CANONICAL_SPECS_DIR))) {
    return { root: located.root, member: null, conventional: false };
  }
  return null;
}

/**
 * The coverage-column name of the workspace package at `dir`, judged against
 * the platform at `root`: a lone monorepo's package is named by its path, a
 * member monorepo's package by `<member>/<path>`. Null when `dir` is no package.
 */
export function packageColumnName(root: string, dir: string): string | null {
  const reading = readPlatformMap(root);
  if (reading === null) return null;
  const { mapped, located } = reading;
  const homes: Array<{ prefix: string; path: string; repo: MapRepo }> =
    mapped.mode === "multi-repo"
      ? mapped.repos.flatMap((repo) => {
          const path = located.repos[repo.name];
          return path === undefined ? [] : [{ prefix: `${repo.name}/`, path, repo }];
        })
      : mapped.repos.map((repo) => ({ prefix: "", path: root, repo }));
  for (const home of homes) {
    const pkg = home.repo.packages.find((p) => join(home.path, p.path) === dir);
    if (pkg !== undefined) return `${home.prefix}${pkg.path}`;
  }
  return null;
}

type Shape = Pick<
  DiscoveredPlatform,
  "mode" | "members" | "unpinned" | "undeclared" | "diagnostics"
>;

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The platform-map node a coverage column was named from: a single repo, or one workspace package. */
type MapNode = Pick<MapPackage, "ecosystem" | "packageName" | "dependsOn"> | MapRepo;

/** A coverage column before its dependency depth is known. */
interface Column {
  repo: Omit<Repo, "dependency_depth">;
  node: MapNode;
}

function column(name: string, path: string, pin: number, node: MapNode, ignore?: string[]): Column {
  return {
    repo: {
      name,
      path,
      pinned_spec_version: pin,
      ...(ignore && ignore.length > 0 ? { ignore } : {}),
    },
    node,
  };
}

/** `ecosystem` and a package name as one key: dependsOn never crosses ecosystems. */
function packageKey(ecosystem: string | undefined, packageName: string): string {
  return `${ecosystem ?? ""}\0${packageName}`;
}

/** The column that provides each package name, first by column order. */
function providersOf(columns: readonly Column[]): Map<string, string> {
  const providers = new Map<string, string>();
  for (const c of columns) {
    if (c.node.packageName === undefined) continue;
    const key = packageKey(c.node.ecosystem, c.node.packageName);
    if (!providers.has(key)) providers.set(key, c.repo.name);
  }
  return providers;
}

/** The columns `c` depends on: its dependsOn names that another column provides. */
function dependenciesOf(c: Column, providers: ReadonlyMap<string, string>): Set<string> {
  const deps = new Set<string>();
  for (const name of c.node.dependsOn) {
    const provider = providers.get(packageKey(c.node.ecosystem, name));
    if (provider !== undefined && provider !== c.repo.name) deps.add(provider);
  }
  return deps;
}

/** The dependency graph over columns: who each column waits on, and who waits on it. */
interface DependencyGraph {
  names: string[];
  dependents: Map<string, string[]>;
  waitingOn: Map<string, number>;
}

function dependencyGraph(columns: readonly Column[]): DependencyGraph {
  const providers = providersOf(columns);
  const dependents = new Map<string, string[]>();
  const waitingOn = new Map<string, number>();
  for (const c of columns) {
    const deps = dependenciesOf(c, providers);
    waitingOn.set(c.repo.name, deps.size);
    for (const provider of deps) {
      dependents.set(provider, [...(dependents.get(provider) ?? []), c.repo.name]);
    }
  }
  return { names: columns.map((c) => c.repo.name).sort(), dependents, waitingOn };
}

/**
 * Each column's depth in the dependsOn graph: 0 with no dependency on another
 * column, else one more than its deepest dependency. A dependsOn name that is
 * no column (a monorepo's root package, an absent member) is no edge. Every
 * column in a cycle, or downstream of one, sits at one depth after every
 * column outside it.
 * @spec PROP-006
 */
function dependencyDepths(columns: readonly Column[]): Map<string, number> {
  const { names, dependents, waitingOn } = dependencyGraph(columns);
  const depth = new Map<string, number>();
  const ready = names.filter((n) => waitingOn.get(n) === 0);
  for (const n of ready) depth.set(n, 0);
  for (let i = 0; i < ready.length; i++) {
    const provider = ready[i] as string;
    const providerDepth = depth.get(provider) ?? 0;
    for (const consumer of dependents.get(provider) ?? []) {
      depth.set(consumer, Math.max(depth.get(consumer) ?? 0, providerDepth + 1));
      const left = (waitingOn.get(consumer) ?? 0) - 1;
      waitingOn.set(consumer, left);
      if (left === 0) ready.push(consumer);
    }
  }
  const cyclic = Math.max(-1, ...depth.values()) + 1;
  for (const n of names) if (!depth.has(n)) depth.set(n, cyclic);
  return depth;
}

/** The columns as `Repo` rows, each stamped with its dependency depth, sorted by name. */
function toRepos(columns: readonly Column[]): Repo[] {
  const depth = dependencyDepths(columns);
  return columns
    .map((c) => ({ ...c.repo, dependency_depth: depth.get(c.repo.name) ?? 0 }))
    .sort(byName);
}

/** A lone single repository is its own coverage column, named by its directory and pinned to the derived version. */
function selfMember(absPlatform: string, platformVersion: number): Repo {
  return {
    name: basename(absPlatform),
    path: absPlatform,
    pinned_spec_version: platformVersion,
    dependency_depth: 0,
    selfMember: true,
  };
}

function loneSingleRepo(absPlatform: string, platformVersion: number): Shape {
  return {
    mode: "single-repo",
    members: [selfMember(absPlatform, platformVersion)],
    unpinned: [],
    undeclared: [],
    diagnostics: [],
  };
}

/**
 * One column per workspace package, named `<prefix><package path>`. A package
 * inherits `parentPin` unless it carries its own `spec-engine.member.json`.
 */
async function packageColumns(
  repoPath: string,
  prefix: string,
  repo: MapRepo,
  parentPin: number,
): Promise<Column[]> {
  const out: Column[] = [];
  for (const pkg of repo.packages) {
    const name = `${prefix}${pkg.path}`;
    if (name === CANONICAL_SPECS_DIR) continue;
    const path = join(repoPath, pkg.path);
    const configPath = join(path, MEMBER_CONFIG_FILENAME);
    if (!existsSync(configPath)) {
      out.push(column(name, path, parentPin, pkg));
      continue;
    }
    const cfg = await readRepoConfig(configPath);
    out.push(column(name, path, extractPin(cfg.specs), pkg, cfg.ignore));
  }
  return out;
}

/**
 * The package paths a monorepo root column must not scan, since each is its
 * own column. Null when a package sits at the repo root: the root is already
 * a column.
 */
function packageDirs(repo: MapRepo): string[] | null {
  const dirs = repo.packages.map((p) => p.path);
  return dirs.some((d) => d === "" || d === ".") ? null : dirs;
}

/**
 * A lone monorepo's files outside every workspace package, as one column
 * named by the directory like a lone single repo's.
 * @spec INIT-040
 */
function loneRootColumn(absPlatform: string, repo: MapRepo, platformVersion: number): Column[] {
  const dirs = packageDirs(repo);
  const { dependency_depth: _depth, ...self } = selfMember(absPlatform, platformVersion);
  if (dirs === null || self.name === CANONICAL_SPECS_DIR) return [];
  return [{ repo: { ...self, ignore: dirs }, node: repo }];
}

/** A lone repository's columns: a monorepo's packages and root, else the repository itself. */
async function loneMembers(
  repo: MapRepo | undefined,
  absPlatform: string,
  platformVersion: number,
): Promise<Repo[]> {
  if (repo === undefined || repo.mode !== "monorepo" || repo.packages.length === 0) {
    return [selfMember(absPlatform, platformVersion)];
  }
  return toRepos([
    ...(await packageColumns(absPlatform, "", repo, platformVersion)),
    ...loneRootColumn(absPlatform, repo, platformVersion),
  ]);
}

/**
 * A pinned member's columns: a monorepo's packages plus its files outside
 * them under the member's name, else the member itself.
 * @spec INIT-040
 */
async function memberColumns(repo: MapRepo, path: string, cfg: SpecConfig): Promise<Column[]> {
  const pin = extractPin(cfg.specs);
  if (repo.mode !== "monorepo" || repo.packages.length === 0) {
    return [column(repo.name, path, pin, repo, cfg.ignore)];
  }
  const packages = await packageColumns(path, `${repo.name}/`, repo, pin);
  const dirs = packageDirs(repo);
  if (dirs === null) return packages;
  return [...packages, column(repo.name, path, pin, repo, [...(cfg.ignore ?? []), ...dirs])];
}

/** How each platform-map code reaches `spec check`: kept as is, promoted to warning, or not surfaced. */
const SURFACED: Record<MapDiagnostic["code"], { code: PlatformMapCode; promote: boolean } | null> =
  {
    MALFORMED_FILE: { code: DiagnosticCode.MALFORMED_FILE, promote: false },
    MEMBER_MISSING: { code: DiagnosticCode.MEMBER_MISSING, promote: false },
    MARKER_MISSING: { code: DiagnosticCode.MARKER_MISSING, promote: false },
    MARKER_MISMATCH: { code: DiagnosticCode.MARKER_MISMATCH, promote: false },
    PLATFORM_NOT_LOCATED: { code: DiagnosticCode.PLATFORM_NOT_LOCATED, promote: false },
    SCAN_TRUNCATED: { code: DiagnosticCode.SCAN_TRUNCATED, promote: false },
    UNLISTED_REPO: { code: DiagnosticCode.UNLISTED_REPO, promote: true },
    UNDECLARED_PLATFORM: { code: DiagnosticCode.UNDECLARED_PLATFORM, promote: true },
    UNMATCHED_PATTERN: null,
    AMBIGUOUS_ECOSYSTEM: null,
  };

/** The detail a row carries. A platform-map message that names a platform-map command is reworded to the `spec` command that does the same. */
function describe(d: MapDiagnostic, mapped: PlatformMap): string {
  const s = d.subject;
  switch (d.code) {
    case "UNLISTED_REPO":
      return `"${s}" is a repository in the platform folder but not a member; its tags are not scanned until \`spec init ${s}\` declares it`;
    case "UNDECLARED_PLATFORM":
      return `${s}/ holds repositories (${mapped.repos.map((r) => r.name).join(", ")}) but no platform file; run \`spec init <name>\` for each one that belongs to the platform`;
    case "MARKER_MISSING":
      return `member "${s}" has no platform-map.json marker; run \`spec init ${s}\` to write it`;
    case "MEMBER_MISSING":
      return `member "${s}" is declared but not found on this machine; run \`spec init --platform <platform-dir>\` in its checkout if it lives elsewhere`;
    case "PLATFORM_NOT_LOCATED":
      return `platform "${s}" is not located on this machine; run \`spec init --platform <platform-dir>\` in this checkout`;
    default:
      return d.message;
  }
}

/**
 * The platform-map diagnostics `spec check` surfaces. Every error and warning
 * keeps its severity; an info diagnostic is promoted to a warning only when it
 * means a repository's tags are silently not being scanned.
 * @spec CHCK-031
 */
function surfaced(mapped: PlatformMap): PlatformDiagnostic[] {
  const out: PlatformDiagnostic[] = [];
  for (const d of mapped.diagnostics) {
    const rule = SURFACED[d.code];
    if (rule === null) continue;
    const severity = rule.promote || d.severity === "info" ? "warning" : d.severity;
    out.push({ code: rule.code, severity, subject: d.subject, detail: describe(d, mapped) });
  }
  return out;
}

/**
 * The coverage columns of a platform-map map: a declared platform's present,
 * pinned members (each monorepo member as its packages); a preview folder's
 * nothing; a lone repository's packages or its own single column.
 */
async function membersOf(
  reading: PlatformReading,
  absPlatform: string,
  platformVersion: number,
): Promise<Shape> {
  const { mapped, located } = reading;
  const diagnostics = surfaced(mapped);
  if (mapped.mode !== "multi-repo") {
    // @spec INIT-035
    const members = await loneMembers(mapped.repos[0], absPlatform, platformVersion);
    return { mode: mapped.mode, members, unpinned: [], undeclared: [], diagnostics };
  }
  if (!mapped.declared) {
    const undeclared = mapped.repos.map((r) => ({ name: r.name, path: join(absPlatform, r.name) }));
    return { mode: "multi-repo", members: [], unpinned: [], undeclared, diagnostics };
  }
  const columns: Column[] = [];
  const unpinned: NamedDir[] = [];
  for (const repo of mapped.repos) {
    const path = located.repos[repo.name];
    if (!repo.present || path === undefined) continue;
    const configPath = join(path, MEMBER_CONFIG_FILENAME);
    if (!existsSync(configPath)) {
      unpinned.push({ name: repo.name, path });
      continue;
    }
    columns.push(...(await memberColumns(repo, path, await readRepoConfig(configPath))));
  }
  const undeclared = mapped.diagnostics
    .filter((d) => d.code === "UNLISTED_REPO")
    .map((d) => ({ name: d.subject, path: join(absPlatform, d.subject) }));
  return { mode: "multi-repo", members: toRepos(columns), unpinned, undeclared, diagnostics };
}

/**
 * The platform at `platformDir`: the canonical row, the derived version, and
 * the coverage columns platform-map's map names, each pinned by its own
 * `spec-engine.member.json` (a lone repository's columns by the derived
 * version). Throws `NotASpecPlatformError` when `spec-engine/` is absent.
 * @spec INIT-037
 */
export async function discoverRepos(platformDir: string): Promise<DiscoveredPlatform> {
  const absPlatform = resolve(platformDir);
  const canonicalPath = join(absPlatform, CANONICAL_SPECS_DIR);
  if (!isExistingDir(canonicalPath)) {
    throw new NotASpecPlatformError(absPlatform);
  }
  const platformVersion = await derivePlatformVersion(absPlatform);
  warnIfRetiredManifest(absPlatform, platformVersion);

  // @spec INIT-028
  const canonical: Repo = {
    name: CANONICAL_SPECS_DIR,
    path: canonicalPath,
    pinned_spec_version: platformVersion,
    dependency_depth: 0,
  };

  const reading = readPlatformMap(absPlatform);
  const shape =
    reading === null
      ? loneSingleRepo(absPlatform, platformVersion)
      : await membersOf(reading, absPlatform, platformVersion);
  return { canonical, platformVersion, ...shape };
}
