declare module "solc" {
  interface SolcImportResult {
    contents?: string;
    error?: string;
  }
  interface SolcCompileOptions {
    import?: (file: string) => SolcImportResult;
  }
  interface Solc {
    compile(input: string, options?: SolcCompileOptions): string;
    version(): string;
  }
  const solc: Solc;
  export default solc;
}
