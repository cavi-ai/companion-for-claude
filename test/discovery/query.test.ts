import { describe, expect, it } from "vitest";
import { deriveDiscoveryQuery } from "../../src/discovery/query";

describe("discovery query derivation", () => {
  it("derives the query from the project question and reviewed claims only", () => {
    const query = deriveDiscoveryQuery({
      project: { path: "P/Project.md", title: "P", type: "research-project", project: "P/Project.md", question: "Do interventions work?", stage: "gather", status: "active" },
      sources: [], evidence: [], questions: [], documents: [], issues: [],
      claims: [
        { path: "C1.md", title: "Reviewed", type: "claim", project: "P/Project.md", proposition: "Interventions reduce risk", confidence: "moderate", reviewState: "reviewed", supports: [], challenges: [], contextualizes: [], limitations: [] },
        { path: "C2.md", title: "Proposed", type: "claim", project: "P/Project.md", proposition: "Secret draft", confidence: "low", reviewState: "proposed", supports: [], challenges: [], contextualizes: [], limitations: [] },
      ],
    });
    expect(query.text).toContain("Do interventions work?");
    expect(query.text).toContain("Interventions reduce risk");
    expect(query.text).not.toContain("Secret draft");
  });

  it("deduplicates normalized lines", () => {
    const snapshot = {
      project: { path: "P.md", question: "  Shared   question  " },
      claims: [{ reviewState: "reviewed", proposition: "shared question" }],
    } as Parameters<typeof deriveDiscoveryQuery>[0];
    expect(deriveDiscoveryQuery(snapshot).text).toBe("Shared   question");
  });

  it("clips the derived query to 2,000 characters", () => {
    const snapshot = {
      project: { path: "P.md", question: "x".repeat(2_100) },
      claims: [],
    } as Parameters<typeof deriveDiscoveryQuery>[0];
    expect(deriveDiscoveryQuery(snapshot).text).toHaveLength(2_000);
  });
});
