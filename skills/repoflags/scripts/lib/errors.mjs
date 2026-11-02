// Expected failures: the CLI maps them to exit code 2 with a short message and no stack.
export class AnalyzeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalyzeError';
    this.exitCode = 2;
  }
}
