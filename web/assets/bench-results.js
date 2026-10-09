// Written by the runners in bench/. Stays null until the first real run is published,
// so the website never shows a number nobody measured.
// Shape:
//   { value: { run_id, date, agent, pioneer, followers: [], tasks, repetitions,
//              without: { success_rate, median_tokens, median_failed_attempts, median_seconds },
//              with:    { ...same keys } },
//     load:  { run_id, date, hardware,
//              scenarios: [{ name, rps_per_vcpu, p50_ms, p99_ms }] } }
window.MYRMO_BENCH = {
  "load": {
    "run_id": "load-20261001-1921",
    "date": "2026-10-01",
    "hardware": "Intel Core i7-8700K (6 cores, 12 threads), Docker Desktop on Windows, whole stack on one machine, 64 virtual users",
    "scenarios": [
      {
        "name": "Fingerprint lookup",
        "rps": 27498.9,
        "rps_per_vcpu": 2291.6,
        "p50_ms": 1.92,
        "p99_ms": 8.59,
        "error_rate": 0
      },
      {
        "name": "Semantic search",
        "rps": 87.8,
        "rps_per_vcpu": 7.3,
        "p50_ms": 735.09,
        "p99_ms": 2348.74,
        "error_rate": 0
      },
      {
        "name": "Semantic search (40 req/s)",
        "rps": 40.0,
        "rps_per_vcpu": 3.3,
        "p50_ms": 17.56,
        "p99_ms": 27.81,
        "error_rate": 0
      },
      {
        "name": "Publish (202)",
        "rps": 10536,
        "rps_per_vcpu": 878.0,
        "p50_ms": 5.05,
        "p99_ms": 18.02,
        "error_rate": 0
      },
      {
        "name": "Outcome report",
        "rps": 12046.3,
        "rps_per_vcpu": 1003.9,
        "p50_ms": 4.79,
        "p99_ms": 13.39,
        "error_rate": 0
      }
    ]
  },
  "value": null
};
