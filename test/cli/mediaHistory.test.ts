import { describe, expect, it } from "vitest";
import { userMessageLine } from "../../src/cli/session";
import type { CompletionRequest } from "../../src/providers/types";

const request: CompletionRequest = { system: "sys", model: "m", maxTokens: 10, messages: [
  { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "Earlier chart question" }] },
  { role: "assistant", content: "Earlier chart answer" },
  { role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AQ==" } }, { type: "text", text: "Earlier PDF question" }] },
  { role: "assistant", content: "Earlier PDF answer" },
  { role: "user", content: "Compare the chart and the paper" },
] };

describe("fresh CLI media context", () => {
  it("keeps historical images and PDFs with their questions", () => {
    const content = JSON.parse(userMessageLine(request, "Earlier text-only transcript")).message.content;
    expect(content.slice(1)).toEqual([
      { type: "text", text: "User:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      { type: "text", text: "Earlier chart question" },
      { type: "text", text: "Assistant:" },
      { type: "text", text: "Earlier chart answer" },
      { type: "text", text: "User:" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AQ==" } },
      { type: "text", text: "Earlier PDF question" },
      { type: "text", text: "Assistant:" },
      { type: "text", text: "Earlier PDF answer" },
      { type: "text", text: "Newest user message:" },
      { type: "text", text: "Compare the chart and the paper" },
    ]);
    expect(content[0].text).toContain("do not repeat earlier actions");
  });
  it("keeps newly selected media after the history boundary", () => {
    const next: CompletionRequest = { ...request, messages: [...request.messages.slice(0, -1),
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Ag==" } }, { type: "text", text: "New chart" }] },
    ] };
    const content = JSON.parse(userMessageLine(next, "Earlier text-only transcript")).message.content;
    expect(content.filter((block: { type: string }) => block.type === "image").map((block: { source: { data: string } }) => block.source.data)).toEqual(["AA==", "Ag=="]);
    expect(content.slice(-3)).toEqual([
      { type: "text", text: "Newest user message:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Ag==" } },
      { type: "text", text: "New chart" },
    ]);
  });
  it("sends only the new question when the CLI already owns the history", () => {
    expect(JSON.parse(userMessageLine(request, null)).message.content).toEqual([{ type: "text", text: "Compare the chart and the paper" }]);
  });
});
