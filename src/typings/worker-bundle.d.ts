// esbuild's `.gz` binary loader supplies the gzipped worker artifacts as bytes.
declare module "*.gz" {
  const content: Uint8Array;
  export default content;
}
