/** Clears the stand-in's rate-limit counters between gate scripts (see clearRequestCounters). */
import { clearRequestCounters } from "./fixtures";

clearRequestCounters().then(
  (passes) => console.log(`request_counters cleared (${passes} pass${passes === 1 ? "" : "es"})`),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
