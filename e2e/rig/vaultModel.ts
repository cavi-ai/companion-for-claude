import { createHash } from "node:crypto";

export interface VaultSnapshot {
  files: Record<string, string>;
  directories: string[];
}

export interface NativeVaultModel {
  paths: string[];
  hashes: Record<string, string>;
  markdownPaths: string[];
  cachedHashes: Record<string, string>;
}

export interface VaultModelIssue {
  path: string;
  problem: "still-present" | "missing" | "content-mismatch" | "missing-markdown" | "cached-content-mismatch";
}

/** Match native UTF-8 text reads: consume a leading BOM, preserve other text. */
export function markdownTextHash(bytes: Uint8Array): string {
  return createHash("sha256").update(new TextDecoder("utf-8").decode(bytes)).digest("hex");
}

export function vaultModelIssues(phase: "removed" | "seeded", expected: VaultSnapshot, observed: NativeVaultModel, expectedTextHashes: Record<string, string>): VaultModelIssue[] {
  const paths = new Set(observed.paths);
  const markdownPaths = new Set(observed.markdownPaths);
  const issues: VaultModelIssue[] = [];
  for (const path of [...expected.directories, ...Object.keys(expected.files)]) {
    if (phase === "removed") {
      if (paths.has(path) || markdownPaths.has(path)) issues.push({ path, problem: "still-present" });
    } else if (!paths.has(path)) {
      issues.push({ path, problem: "missing" });
    } else if (path in expected.files && observed.hashes[path] !== expected.files[path]) {
      issues.push({ path, problem: "content-mismatch" });
    } else if (path in expected.files && path.toLowerCase().endsWith(".md")) {
      if (!markdownPaths.has(path)) issues.push({ path, problem: "missing-markdown" });
      else if (!(path in expectedTextHashes) || observed.cachedHashes[path] !== expectedTextHashes[path]) issues.push({ path, problem: "cached-content-mismatch" });
    }
  }
  return issues;
}
