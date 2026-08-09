#!/usr/bin/env node
/**
 * Stamps a fork-specific version across the three published workspaces.
 *
 * This is the ONLY mutation the publish pipeline makes to the working tree,
 * and it is never committed. Everything else — package names, import
 * specifiers, jest/webpack/tsconfig wiring — stays byte-identical to
 * `aws-observability/aws-rum-web`, so `git merge upstream/main` only ever
 * conflicts on changes we actually made on purpose.
 *
 * Package names are deliberately NOT rewritten. We publish to a CodeArtifact
 * repository, which places no constraint on package names (unlike GitHub
 * Packages, which forces every package into an `@<org>` scope). Keeping
 * `aws-rum-web` / `@aws-rum/web-core` / `@aws-rum/web-slim` means:
 *
 *   - zero source churn, so the fork diff stays reviewable;
 *   - `package-lock.json` never diverges, which removes the single worst
 *     source of merge conflicts when tracking a fork;
 *   - consuming apps swap registries, not import statements, so reverting
 *     to upstream is an `.npmrc` change rather than a code change.
 *
 * The tradeoff is that our packages SHADOW the public ones inside our
 * registry — see `docs/fork-maintenance.md` for how package origin controls
 * make that explicit rather than accidental.
 *
 * Usage:
 *   node scripts/set-fork-version.mjs 3.2.0-finalis.7
 *   FORK_VERSION=3.2.0-finalis.7 node scripts/set-fork-version.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspaces that get published, in dependency order. */
const PUBLISHED_PACKAGES = ['core', 'slim', 'web'];

/**
 * Intra-monorepo dependencies. Upstream pins these exactly (`lerna.json` sets
 * `exact: true`), so `packages/web` depending on `"@aws-rum/web-core":
 * "3.2.0"` must become the fork version too — otherwise npm resolves the
 * PUBLIC 3.2.0 from the upstream registry at install time and consumers
 * silently get a mix of forked and unforked code.
 */
const WORKSPACE_DEPENDENCIES = ['@aws-rum/web-core', '@aws-rum/web-slim'];

/**
 * Mirrors `.prettierrc.json` (`tabWidth: 4`) so a stamped manifest is
 * byte-identical to a hand-edited one, and `git diff` during a dry run shows
 * only the version lines.
 */
const JSON_INDENT = 4;

const version = process.argv[2] ?? process.env.FORK_VERSION;

if (!version) {
    console.error(
        'Usage: node scripts/set-fork-version.mjs <version>\n' +
            '   or: FORK_VERSION=<version> node scripts/set-fork-version.mjs'
    );
    process.exit(1);
}

// Loose semver check. Not a full validator — just enough to catch a shell
// variable that expanded to an empty string or a stray `v` prefix, both of
// which npm would otherwise accept far too late in the pipeline.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(
        `Refusing to stamp malformed version: ${JSON.stringify(version)}`
    );
    process.exit(1);
}

for (const pkg of PUBLISHED_PACKAGES) {
    const manifestPath = join(REPO_ROOT, 'packages', pkg, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    manifest.version = version;

    for (const dependency of WORKSPACE_DEPENDENCIES) {
        if (manifest.dependencies?.[dependency] !== undefined) {
            manifest.dependencies[dependency] = version;
        }
    }

    writeFileSync(
        manifestPath,
        `${JSON.stringify(manifest, null, JSON_INDENT)}\n`
    );
    console.log(`${manifest.name} -> ${version}`);
}
