# Real lifecycle demo

The `lifecycle-demo` command uses production HTTP contracts to create a real Board, card and
versioned WorkContract, then publishes the contract. Its safe default stops there: it does not
launch a provider, spend tokens, modify a worktree, submit evidence, or accept its own delivery.

After the Lane D integrator registers the command:

```sh
orchestra lifecycle-demo --project /absolute/path/to/a/test-repository --json
```

Inspect the returned card and its immutable Requested/Asked state. Only after `orchestra doctor`
passes for a genuinely claimed native-subscription provider may an operator explicitly add
`--launch`. Provider-API mode is not used by this demo.

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
