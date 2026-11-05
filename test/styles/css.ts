import { readFileSync } from "node:fs";
import { join } from "node:path";
export const readStyles = (): string => readFileSync(join(__dirname, "..", "..", "styles.css"), "utf8");
