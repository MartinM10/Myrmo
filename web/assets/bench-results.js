// Written by the runners in bench/. Stays null until the first real run is published,
// so the website never shows a number nobody measured.
// Shape:
//   { value: { run_id, date, pioneer, followers: [], tasks, repetitions,
//              without: { success_rate, median_tokens, median_failed_attempts, median_seconds },
//              with:    { ...same keys } },
//     load:  { run_id, date, hardware,
//              scenarios: [{ name, rps_per_vcpu, p50_ms, p99_ms }] } }
window.MYRMO_BENCH = null;
