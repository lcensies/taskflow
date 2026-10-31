import * as c from "taskflow-core";
import fs from "node:fs";
const text = fs.readFileSync(0, "utf8");
const entries = c.parseTranscript(text);
console.log(JSON.stringify({ entries, formatted: c.formatTranscript(entries) }));
