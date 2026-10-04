// packages/shared/src/platform.ts
//
// The platform's shape as platform-map reports it. The engine reads the mode
// from `@spec-engine/platform-map`; the webapp reads it from `/api/platform`,
// so the vocabulary is stated once here for both sides of that route.

/** platform-map's `Mode`: one repo, one repo of workspace packages, or a declared platform of repos. */
export type PlatformMode = "single-repo" | "monorepo" | "multi-repo";

/** The `/api/platform` response. */
export interface PlatformInfo {
  /** The derived platform version: the maximum domain version. */
  version: number;
  /** The platform file's name, else the platform directory's name. Never a path. */
  name: string;
  source: "derived";
  mode: PlatformMode;
}
