# Beta Lane B Qwen/Kimi managed-adapter checkpoint

Date: 2026-08-02

## TL;DR

Qwen Coding Plan managed foreground/background execution remains explicitly policy-blocked. Kimi
now has an implementation-complete ACP 0.23 transport primitive and provider-adapter seams, but it
remains unregistered and unsupported because this host has no Kimi executable/login, no exact
executable acceptance tuple, and ACP does not expose the provider-managed Extra Usage state needed
to prove zero overage or enforce a consented cost cap.

This checkpoint is deterministic implementation evidence only. It does not close `BASE-010`,
`TOOL-014`, either provider acceptance matrix, or any provider support claim.

## Qwen decision

- The subscription path is Alibaba Cloud Coding Plan, using its dedicated subscription-scoped key
  and coding endpoint. It is distinct from a general Model Studio pay-as-you-go API key.
- Alibaba's current Coding Plan terms say not to use the plan key for automated scripts,
  application backends, or other non-interactive scenarios. Orchestra therefore permits only the
  separately owned raw interactive terminal surface and blocks managed foreground/background use.
- `QWEN_CODING_PLAN_POLICY_EVIDENCE_V1` exposes the allowed and blocked execution scopes plus the
  exact reason code. The managed adapter's model and launch seams fail explicitly and do not invoke
  the raw driver.
- The retired Qwen OAuth free tier is not treated as a current subscription path. API mode remains
  secondary, requires explicit usage-priced consent, and never becomes a fallback.

Official evidence:

- <https://www.alibabacloud.com/help/en/model-studio/coding-plan>
- <https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/>

## Kimi ACP implementation

`KimiAcpDriverV1` uses the pinned official `@agentclientprotocol/sdk@0.23.0` and launches exactly
`<resolved kimi executable> acp` without a shell. It:

- negotiates the ACP protocol and requires the exact `Kimi Code CLI` agent identity;
- bounds initialization, new-session, configuration, and resume handshakes;
- implements new session, prompt/follow-up, session resume/load, cancellation, interruption,
  process stop, model/effort/access configuration, streamed safe output/tool/status events, and
  explicit permission resolution;
- suppresses ACP raw tool input/output and thinking content from normalized driver events;
- keeps raw provider session IDs from becoming attach authority;
- cleans failed registrations and rejects missing native control mappings rather than weakening
  provider semantics;
- leaves model discovery, stable fork, subscription usage, rate limits, token budget, and cost
  budget explicitly unavailable where the documented ACP surface does not provide them.

The canonical provider manifest remains unsupported with no validated versions or platforms. The
transport is not centrally registered or composed by this child lane.

The access-profile mapper is intentionally injected and has no production defaults. Exact
read-only/workspace-write/full-access mappings must be proven against the frozen Kimi version;
until then `access_profile` remains an explicit capability blocker rather than an inferred mapping.

Official evidence:

- <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html>
- <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html>
- <https://www.kimi.com/code/docs/en/kimi-code-cli/release-notes/changelog.html>

## Kimi billing and consent boundary

Kimi membership OAuth does not prove zero overage. Extra Usage can be enabled separately, consumes
a metered balance after subscription quota, can switch over seamlessly, and may have no monthly
spending cap. The adapter therefore defaults authentication, Extra Usage, metering, and cap state
to unknown. If a future credential-safe provider observation says Extra Usage is enabled, the
adapter derives consent only from Orchestra's separately verified provider-managed-overage consent
authority; it never infers consent from login or provider configuration.

Any future readiness observation must identify a credential-safe Kimi CLI usage or Kimi Console
source and match the executable, environment, and configuration fingerprints of the launch
boundary. API-mode observations cannot be reused for the membership path.

ACP 0.23 has no documented subscription/Extra Usage query. No production path may enable Kimi
until a separate credential-safe source proves auth, overage enabled/disabled state, metering, and
cap enforcement for the same launch boundary.

Official evidence:

- <https://www.kimi.com/code/docs/en/kimi-code/membership.html>
- <https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html>

## Host and external blockers

- Worktree base: `0dd3dd43b9f376370ee73a9e2fe4725974caaae8`.
- Observed host: macOS `26.5.1`, Darwin `25.5.0`, arm64.
- Test toolchain: Node `22.20.0`, npm `10.9.3` loaded explicitly; no repository `.env` or
  `web/.env` exists.
- Credential-free lookup found no `qwen`, `kimi`, or `kimi-cli` executable in `PATH`, common local
  bin locations, global npm packages, Python packages, or the uv tool inventory.
- Registry discovery on 2026-08-02 reported `@qwen-code/qwen-code@0.21.3` and the Kimi documentation
  changelog reported Kimi Code CLI `0.31.0`. Neither is host execution or compatibility evidence;
  neither version is added to a validated manifest range.
- No provider login, account cache, raw credential, Coding Plan key, Kimi OAuth token, or Extra
  Usage balance was read or copied.
- Exact clean-profile installation provenance, interactive login, billing/account observation,
  provider-policy confirmation where required, macOS/Linux matrices, and all eight real provider
  acceptance gates remain external blockers.

## Deterministic verification

The focused gate covers exact subprocess arguments, protocol/agent identity negotiation, native
model/effort/access controls, safe structured event projection, explicit approval, cancellation,
stop, resume, missing executable/version states, Qwen policy denial, Kimi overage fail-closed
evidence, and zero raw-driver calls through unsupported provider gateways.

Mocks prove deterministic adapter behavior only. They are not provider support evidence.
