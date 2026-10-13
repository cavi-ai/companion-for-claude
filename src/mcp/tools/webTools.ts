import type { ToolRecord } from "../toolRecord";
import type { VaultToolsOptions } from "../vaultTools";
import { num, read, str } from "./context";

const WEB_SEARCH_OFF_MESSAGE = "Web search is disabled. Enable it in Companion settings → Agent.";
const WEB_FETCH_OFF_MESSAGE = "Web fetch is disabled. Enable it in Companion settings → Agent.";

export class WebTools {
  constructor(private opts: VaultToolsOptions) {}

  records(): ToolRecord[] {
    return [
      read({
        name: "web_search",
        description: "Search the public web. Returns numbered results with titles, URLs, and snippets. Use for current events, external facts, or anything the vault can't answer; follow up with web_fetch to read a promising page.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            count: { type: "number", description: "Max results (default 5, cap 10)." },
          },
          required: ["query"],
        },
      }, async (args) => {
        if (!this.opts.webSearch) throw new Error(WEB_SEARCH_OFF_MESSAGE);
        return this.opts.webSearch(str(args.query), Math.min(num(args.count, 5), 10));
      }, this.opts.webSearch ? undefined : WEB_SEARCH_OFF_MESSAGE),
      read({
        name: "web_fetch",
        description: "Read one public web page as clean markdown (readable-content extraction). Use after web_search or on a URL the user gave you.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string", description: "The http(s) URL to read." } },
          required: ["url"],
        },
      }, async (args) => {
        if (!this.opts.webFetch) throw new Error(WEB_FETCH_OFF_MESSAGE);
        return this.opts.webFetch(str(args.url));
      }, this.opts.webFetch ? undefined : WEB_FETCH_OFF_MESSAGE),
    ];
  }
}
