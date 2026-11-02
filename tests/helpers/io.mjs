// String collectors for main(argv, io, deps).
export function makeIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(String(s)) }, stderr: { write: (s) => err.push(String(s)) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}
