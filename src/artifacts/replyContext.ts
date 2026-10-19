/** Older or hand-edited conversations may not have valid context metadata. */
export function contextSnapshot(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined;
}

/** Preserve recorded context labels without treating them as verified citations. */
export function replyContextSection(value: string[] | undefined, folder: string): string {
  const sources = contextSnapshot(value);
  if (!sources?.length) return "";
  const escape = (text: string) => text.replace(/[\\`*_{}[\]<>!|]/g, "\\$&").replace(/[\r\n]+/g, " ");
  const root = "../".repeat(folder.split("/").filter(Boolean).length);
  const lines = [...new Set(sources)].map((source) => {
    const path = /^(?:active note|selection): (.+\.md)$/.exec(source)?.[1];
    const label = escape(source);
    const url = path?.split("/").map((part) => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");
    return url ? `- [${label}](${root}${url})` : `- ${label}`;
  });
  return `\n\n## Context provided\n\n${lines.join("\n")}\n`;
}
