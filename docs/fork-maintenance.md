# Fork maintenance

This repository is a fork of [`aws-observability/aws-rum-web`](https://github.com/aws-observability/aws-rum-web) that Finalis builds, publishes, and consumes internally.

Its central design constraint is that **the working tree stays byte-identical to upstream except for changes we made on purpose.** Nothing is renamed, re-scoped, or re-pathed. That is what keeps `git merge upstream/main` tractable.

## Why nothing is renamed

The obvious way to publish a fork is to rename the packages — `aws-rum-web` becomes `@dealsyte/aws-rum-web`, and so on. Doing that here touches 57 files: every cross-package import in `packages/*/src`, every mock in `packages/*/__tests__`, the `moduleNameMapper` in `jest.unit.config.js`, the `paths` in four tsconfigs, the `alias` blocks in two webpack configs, and `package-lock.json`.

Every one of those is a permanent merge conflict against upstream, forever. The lockfile is the worst of them.

We publish to **AWS CodeArtifact**, which places no constraint on package names. (GitHub Packages does — it forces every package into a scope matching the owning org, which is what would have made a rename unavoidable.) So we publish under the original names and change nothing but the version:

|  | rename in-tree | what we do |
| --- | --- | --- |
| Files diverging from upstream | 57 | 0 |
| `package-lock.json` diverges | yes | no |
| Merge conflicts | every touched test and source file | only real changes |
| Build artifacts need rewriting | yes (`tsc` emits the specifier verbatim) | no |

## What is fork-specific

Three files, all additive, none of which upstream will ever touch:

-   `scripts/set-fork-version.mjs` — stamps a version across the three published workspaces
-   `.github/workflows/publish-codeartifact.yaml` — builds and publishes
-   `docs/fork-maintenance.md` — this file

Upstream's own `cd.yaml`, `cdn_rollback.yaml`, and `npm_deprecate.yaml` are left untouched. They are `workflow_dispatch`-only and depend on AWS secrets we do not hold, so they cannot fire here by accident, and not editing them keeps them conflict-free.

## Syncing with upstream

```bash
git fetch upstream
git merge upstream/main
```

Conflicts should only appear in files we have genuinely modified. If a conflict shows up in a test file or the lockfile, something has drifted from the strategy above — fix that rather than resolving the conflict.

## Publishing

Run the **Publish Fork to CodeArtifact** workflow (Actions → Run workflow). Inputs:

-   `version` — optional. Defaults to `<lerna.json version>-finalis.<run number>`, e.g. `3.2.0-finalis.7`.
-   `dry_run` — build and `npm pack`, publish nothing.

The workflow installs from public npm, runs the unit tests, stamps the version, builds, then assumes `finalis-codeartifact-publish` via GitHub OIDC and publishes `@aws-rum/web-core`, `@aws-rum/web-slim`, and `aws-rum-web` in dependency order. No AWS credentials are stored in this repository.

The version stamp is never committed.

### Version scheme and a semver caveat

`3.2.0-finalis.7` is a **prerelease** of `3.2.0` in semver terms. That has a consequence worth knowing:

```jsonc
"aws-rum-web": "^3.2.0"          // will NOT match 3.2.0-finalis.7
"aws-rum-web": "3.2.0-finalis.7" // pin exactly — do this
```

npm excludes prereleases from ranges unless the range itself carries one. Pin the exact version in consuming apps. This is a feature rather than a nuisance for a fork — it makes "which build am I on" unambiguous — but it will surprise anyone who writes a caret range out of habit.

If you would rather use ordinary versions that satisfy caret ranges, pass an explicit `version` input (e.g. `3.2.100`) and adopt a numbering convention that cannot collide with upstream's.

## Package origin controls

All three package names also exist on public npm, and our `internal` CodeArtifact repository lists npmjs as an upstream. CodeArtifact resolves that ambiguity with **package origin controls**, and its default depends on which happened first:

-   package first enters the repo via **our publish** → `publish=ALLOW, upstream=BLOCK`
-   package first enters via an **upstream fetch** (someone ran `npm install aws-rum-web` against this registry) → `publish=BLOCK`, and our publish fails with `AccessDeniedException`

The publish workflow does not leave this to chance. It calls `put-package-origin-configuration` before each publish (repairing the second case; expected to fail harmlessly the very first time, when the package is not yet in the repo) and again afterwards to pin the setting.

The consequence is deliberate: **inside our registry, our fork shadows the public package.** `npm install aws-rum-web@3.2.0` through this repository will not resolve the real upstream 3.2.0 — only versions we publish are visible. Anything that needs genuine upstream artifacts should go to npmjs directly.

## Consuming the fork

Point the registry at CodeArtifact and pin the version. Locally:

```bash
aws codeartifact login --tool npm \
  --domain finalis --domain-owner 260282789507 \
  --repository internal --region us-east-1

npm install aws-rum-web@3.2.0-finalis.7
```

`codeartifact login` writes a 12-hour token into `~/.npmrc`; re-run it when installs start returning 401.

In CI, give the build role `codeartifact:GetAuthorizationToken`, `codeartifact:GetRepositoryEndpoint`, `codeartifact:ReadFromRepository`, and `sts:GetServiceBearerToken` (that last one is an STS action, not a CodeArtifact one, and is the single most commonly omitted permission), then run the same `codeartifact login` in the pre-build phase.

Because the package names are unchanged, **no application code changes** — `import { AwsRum } from 'aws-rum-web'` keeps working, and moving back to upstream is an `.npmrc` change rather than a code change.

## Infrastructure

The registry is defined in the `finalis-atlas` repository at `packages/cdk-infrastructure/src/pipeline/stacks/codeartifact.ts`, deployed into the Teams account (`260282789507`, `us-east-1`) as part of the `TeamsPipelines` stage. It provisions the `finalis` domain, the `internal` and `npm-store` repositories, the customer-managed KMS key the domain requires for cross-account reads, and the `finalis-codeartifact-publish` role this workflow assumes.

The OIDC trust on that role is scoped to `repo:DealSyte/aws-rum-web-modified` on `main` and tags. Publishing from another branch, or from a fork's pull request, will fail the credential step by design.
