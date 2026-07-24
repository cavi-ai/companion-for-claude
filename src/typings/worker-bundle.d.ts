// Lets TypeScript accept the inlined worker-bundle import in workerSource.ts;
// esbuild's `.txt` text loader supplies the actual string at bundle time.
declare module "*.txt" {
  const content: string;
  export default content;
}
