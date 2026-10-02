import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inflateWorkerSource } from "../../src/semantic/workerText";

describe("inflateWorkerSource", () => {
  it("round-trips a gzipped string exactly", () => {
    const source = '"use strict";(()=>{self.onmessage=e=>postMessage("héllo ✓ "+e.data)})();\n'.repeat(50);
    const gz = new Uint8Array(gzipSync(Buffer.from(source, "utf8"), { level: 9 }));
    expect(inflateWorkerSource(gz)).toBe(source);
  });
});
