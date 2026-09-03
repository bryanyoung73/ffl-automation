import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { calibrateFromLog, renderCalibration } from "../draft/live/calibrate.js";
import type { DraftLogEvent, DraftLogFinal, DraftLogLine, DraftLogMeta } from "../draft/live/record.js";
import { hasFlag } from "./prompt.js";

/**
 * Read a draft log recorded by `npm run draft --record` and print a calibration
 * report: observed survival sigma vs the model, bucket reliability, VOR
 * tier-gap distribution, and recommendation hit rate. Pure analysis — no
 * network.
 *
 *   npm run draft:review -- output/draft-log-<league>-<date>.jsonl [--csv]
 */
function main(): void {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: npm run draft:review -- <logfile.jsonl> [--csv]");
    process.exit(1);
  }
  const path = resolve(process.cwd(), file);

  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l) as DraftLogLine;
      } catch {
        throw new Error(`line ${i + 1} is not valid JSON`);
      }
    });

  const meta = lines.find((l): l is DraftLogMeta => l.kind === "meta");
  if (!meta) {
    console.error("no meta line in the log — is this a draft-log file?");
    process.exit(1);
  }
  const events = lines.filter((l): l is DraftLogEvent => l.kind === "event");
  const final = lines.find((l): l is DraftLogFinal => l.kind === "final") ?? null;

  if (events.length === 0) {
    console.error("log has a meta line but no events — nothing to calibrate yet.");
    process.exit(1);
  }

  const report = calibrateFromLog(meta, events, final);
  console.log(renderCalibration(report));

  if (hasFlag("csv")) {
    const rows = ["adp,adp_error,position,overall,mine"];
    for (const e of events) {
      for (const l of e.landed) {
        if (l.adp != null) {
          rows.push(`${l.adp},${l.adpError},${l.position ?? ""},${l.overall},${l.mine ? 1 : 0}`);
        }
      }
    }
    const csvPath = `${path.replace(/\.jsonl$/, "")}-points.csv`;
    writeFileSync(csvPath, `${rows.join("\n")}\n`, "utf8");
    console.log(`\nwrote ${csvPath}`);
  }
}

main();
