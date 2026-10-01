import type { AuditFinding } from "./audit";

export type FindingCode = AuditFinding["code"];

export function findingCopy(code: FindingCode, name: string): { label: string; reason: string } {
  switch (code) {
    case "stale-evidence": return { label: `Re-check ${name}`, reason: "The source changed since you checked this passage. Confirm it still says the same thing." };
    case "missing-locator": return { label: `Say where ${name} is`, reason: "Add the page or section so anyone can find this passage." };
    case "unreviewed-evidence": return { label: `Check ${name}`, reason: "This passage was suggested for you. Keep it or reject it." };
    case "unreviewed-claim": return { label: `Check claim ${name}`, reason: "Confirm the claim says only what its passages support." };
    case "unsupported-claim": return { label: `Back up ${name}`, reason: "No checked passage supports this claim yet." };
    case "rejected-claim": return { label: `Rework ${name}`, reason: "You rejected this claim. Revise it or leave it out of the outline." };
    case "broken-reference": return { label: `Fix a broken link in ${name}`, reason: "It points to a note that no longer exists." };
    case "invalid-record": return { label: `Fix ${name}`, reason: "Some of its properties can't be read. Open it and check the fields at the top." };
    case "unverifiable-source": return { label: `Restore ${name}`, reason: "The source file can't be read." };
    case "unused-evidence": return { label: `${name} isn't used yet`, reason: "Use this passage in a claim, or leave it." };
  }
}

export function challengedClaimCopy(name: string, count: number): { label: string; reason: string } {
  return { label: `Answer the challenge to ${name}`, reason: `${count} ${count === 1 ? "passage pushes" : "passages push"} back on this claim. Note what it doesn't cover.` };
}
