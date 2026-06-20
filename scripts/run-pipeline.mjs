// Run the full ingest -> normalize -> score -> tag -> geo pipeline locally.
// Usage: DATABASE_URL=... node scripts/run-pipeline.mjs
// (Uses tsx-free dynamic import of the compiled TS via the Next build is not
//  available here, so this script calls the pipeline through a small loader.)
import { register } from "node:module";

// Allow importing the TypeScript pipeline directly when tsx is available.
try {
  register("tsx/esm", import.meta.url);
} catch {
  console.error("Install tsx to run the pipeline locally:  npm i -D tsx");
  console.error("Or trigger it on the deployment:  curl -H 'Authorization: Bearer <CRON_SECRET>' https://<your-app>/api/cron/refresh");
  process.exit(1);
}

const { runPipeline } = await import("../lib/pipeline/run.ts");
const result = await runPipeline();
console.log(JSON.stringify(result, null, 2));
