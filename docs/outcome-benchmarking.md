# Controlled outcome benchmarking

Orchestra ships a fail-closed runner for MET-015 evidence. It executes the same frozen scenario
twice, control (`before`) first, while changing only
`ORCHESTRA_OUTCOME_BENCHMARK_VARIANT`. The child command must write its bounded result JSON to
`ORCHESTRA_OUTCOME_BENCHMARK_RESULT`.

Run it from the exact source commit with no staged or unstaged changes to tracked files:

```sh
npm run benchmark:outcomes -- ./benchmark-manifest.json ./benchmark-report.json
```

The manifest contains `schema_version: 1`, the full lowercase `source_commit`, a stable
`suite_key`, and one or more scenarios. Each scenario freezes its objective, acceptance criteria,
provider, model, seed, working directory and shell-free command array. The child result permits
only accepted-delivery count, quality, provider/context tokens, duration and repeated-exploration
count. Raw prompts, output, filenames, user identity and credentials are rejected.

A scenario passes only when quality and accepted-delivery count do not decline and tokens per
accepted delivery decrease. Lower tokens with lower verified quality always fail. The report binds
each child result by SHA-256 and binds the complete report by `report_sha256`.

The runner deliberately writes `representative_evidence_observed: false` and
`gate_claimed: false`. A passing synthetic or developer-controlled run proves the harness, not
MET-GATE. Release owners must retain representative exact-artifact observations, independently
review task representativeness, and then use the release evidence process; never edit these fields.
The runner checks tracked-source cleanliness before executing and again before writing a report,
so a command or concurrent process that changes tracked source invalidates the run. Untracked files
are intentionally outside the source-commit claim and are not included in this check.
