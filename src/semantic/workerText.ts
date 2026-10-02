import { gunzipSync, strFromU8 } from "fflate";

export function inflateWorkerSource(gz: Uint8Array): string {
  return strFromU8(gunzipSync(gz));
}
