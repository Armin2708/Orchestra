#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const contractPath = join(dirname(fileURLToPath(import.meta.url)), 'beta-release-contract.json')
const contract = JSON.parse(readFileSync(contractPath, 'utf8'))

const invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}

const unique = (values) => Array.isArray(values) && new Set(values).size === values.length

invariant(contract.schema_version === 1, 'beta release contract schema is unsupported')
invariant(contract.channel?.name === 'beta', 'release channel must be beta')
invariant(contract.channel?.npm_dist_tag === 'beta', 'beta npm dist-tag is required')
invariant(contract.channel?.opt_in === true, 'beta channel must be opt-in')
invariant(
  contract.channel?.stable_promotion_allowed === false,
  'stable promotion must remain disabled',
)
invariant(
  contract.channel?.public_action_requires_human_approval === true,
  'public release actions must require human approval',
)
invariant(contract.versioning?.semver_prerelease_required === true, 'beta requires a prerelease version')
invariant(
  contract.versioning?.tag_must_equal_v_plus_package_version === true,
  'beta tag must match the exact package version',
)
invariant(
  contract.versioning?.stable_version_forbidden_on_beta_channel === true,
  'stable versions must not publish to the beta channel',
)
invariant(
  contract.versioning?.current_source_version_change_requires_human_approval === true,
  'changing the release version must require human approval',
)
invariant(contract.artifact?.single_retained_tarball === true, 'one retained tarball is required')
invariant(contract.artifact?.rebuild_after_verification === false, 'verified artifacts must not rebuild')
invariant(unique(contract.artifact?.required_digests), 'artifact digests must be unique')
invariant(unique(contract.artifact?.required_assets), 'artifact assets must be unique')
invariant(unique(contract.artifact?.verification), 'artifact verification gates must be unique')
invariant(
  JSON.stringify(contract.stages?.map((stage) => stage.name)) ===
    JSON.stringify(['internal', 'canary', 'beta']),
  'release stages must be internal, canary, then beta',
)
invariant(
  contract.stages.every((stage) => stage.migration_flags_default_on === false),
  'migration flags must default off in every beta stage',
)
invariant(unique(contract.promotion_requires), 'promotion requirements must be unique')
invariant(unique(contract.rollback?.triggers), 'rollback triggers must be unique')
invariant(unique(contract.rollback?.actions), 'rollback actions must be unique')
invariant(unique(contract.rollback?.forbidden), 'rollback forbidden actions must be unique')
invariant(
  contract.rollback.forbidden.includes('schema_down_migration'),
  'rollback must forbid schema down migrations',
)
invariant(contract.hotfix?.skip_tests_allowed === false, 'hotfixes may not skip release gates')
invariant(
  contract.hotfix?.direct_public_mutation_allowed === false,
  'hotfixes may not mutate public releases directly',
)
invariant(unique(contract.public_actions), 'public action inventory must be unique')

console.log(
  `beta release contract valid: ${contract.stages.length} stages, ` +
  `${contract.promotion_requires.length} promotion gates, stable disabled`,
)
