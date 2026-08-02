# Real lifecycle demo

The `lifecycle-demo` command uses production HTTP contracts to create or reuse one marker-bound Board, card and
versioned WorkContract, then publishes the contract. Its safe default stops there: it does not
launch a provider, spend tokens, modify a worktree, submit evidence, or accept its own delivery.

After the Lane D integrator registers the command:

```sh
orchestra lifecycle-demo --project /absolute/path/to/a/test-repository --json
```

The selected project must already contain a safe sample file (`README.md`, `package.json`,
`.gitignore`, or an explicitly validated relative file). The demo does not point the WorkContract at
a nonexistent repository path.

Inspect the returned card and its immutable Requested/Asked state. `--launch` is disabled unless
central integration injects a gate that returns both a current ready doctor attestation and the
exact accepted native-subscription provider matrix (source commit, digest, executable and platform).
The supplied gate factory runs the doctor first and invokes the exact acceptance reader only after
doctor success; central wiring must use the production evidence store, never a constant success stub.
Missing, candidate or mismatched evidence fails before any API mutation. Provider-API mode is not
used by this demo. Repeating the same marker reuses its card and existing Job rather than creating a
second provider charge.

The real lifecycle is:

1. resolve the project Board;
2. create a scoped card;
3. read and compare the Job Market version;
4. set objective, stable deliverable/criterion IDs, non-goals, risks, verification, provider and
   read-only access constraints;
5. publish the contract;
6. optionally create one idempotent Job;
7. inspect the frozen Asked snapshot;
8. submit a Delivery with observed evidence;
9. verify independently; and
10. accept, reject, or revise without rewriting history.

The module accepts an injected API and is covered by a deterministic lifecycle contract test. It is
an executable integration sample, not a mocked provider-support claim.
