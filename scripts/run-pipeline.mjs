// Run the full pipeline locally (ingest -> normalize -> dedup -> score -> tag ->
// enrich -> geo, per run.ts). Invoke via the npm script, which loads tsx the
// modern way (`node --import tsx`): the old `register("tsx/esm")` API is rejected
// on Node >= 20.6/18.19 ("must be loaded with --import instead of --loader").
//   npm run pipeline:run        # = node --import tsx scripts/run-pipeline.mjs
let runPipeline;
try {
  ({ runPipeline } = await import("../lib/pipeline/run.ts"));
} catch (err) {
  console.error("Could not load the TypeScript pipeline. Run it via `npm run pipeline:run`");
  console.error("(needs tsx active: `node --import tsx scripts/run-pipeline.mjs`).");
  console.error("Or trigger on the deployment: curl -H 'Authorization: Bearer <CRON_SECRET>' <app>/api/cron/refresh");
  console.error("Original error:", err?.message ?? err);
  process.exit(1);
}

const result = await runPipeline();
console.log(JSON.stringify(result, null, 2));
