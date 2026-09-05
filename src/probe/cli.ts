import { parseProbeArgs, runProbe } from "./run.js";

try {
  const result = await runProbe(parseProbeArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ pass: result.pass, count: result.list.count, pages: result.list.pages, errors: result.errors }, null, 2));
  if (!result.pass) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
