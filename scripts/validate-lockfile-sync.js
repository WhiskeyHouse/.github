#!/usr/bin/env node
/**
 * Package-lock synchronization validator (WhiskeyHouse org canonical copy).
 *
 * Fails when the root package-lock.json is out of sync with any workspace's
 * package.json. This is the exact condition that makes `npm ci` fail (and, in
 * release pipelines that fall back to `npm install --no-save`, risks shipping
 * unverified dependency trees). Originally TEC-1040 / whk-wms prod incident
 * 2026-05-06; generalized so it works in any npm-workspaces repo.
 *
 * Repo-agnostic: reads the `workspaces` array from the root package.json,
 * expands simple globs (e.g. "apps/*"), and compares dependencies +
 * devDependencies of each workspace against the corresponding entry in
 * package-lock.json's `packages` map.
 *
 * Resolving the repo root (in priority order):
 *   1. argv[2]            — explicit path, e.g. `node validate.js "$PWD"`
 *   2. $GITHUB_WORKSPACE  — set by actions/checkout to the caller repo root,
 *                           so this script can live in WhiskeyHouse/.github and
 *                           validate a *different* repo that was checked out.
 *   3. __dirname/..       — when vendored as `<repo>/scripts/validate-...js`.
 *
 * Exit codes:
 *   0 - lockfile is in sync with every workspace
 *   1 - drift detected (or a structural problem that would break `npm ci`)
 */

const fs = require('fs');
const path = require('path');

const rootDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.env.GITHUB_WORKSPACE || path.join(__dirname, '..');

const lockFilePath = path.join(rootDir, 'package-lock.json');
const rootPkgPath = path.join(rootDir, 'package.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

if (!fs.existsSync(lockFilePath)) {
  console.error(`❌ No package-lock.json found at ${rootDir}. Run \`npm install\`.`);
  process.exit(1);
}

const lockFile = readJson(lockFilePath);

if (!fs.existsSync(rootPkgPath)) {
  console.error(`❌ No package.json found at ${rootDir}.`);
  process.exit(1);
}

const rootPkg = readJson(rootPkgPath);

if (!lockFile.packages) {
  console.error(
    `❌ package-lock.json has lockfileVersion ${lockFile.lockfileVersion ?? '?'} ` +
      'without a `packages` map. This validator needs lockfileVersion >= 2 ' +
      '(npm 7+). Regenerate with `npm install`.',
  );
  process.exit(1);
}

// Canonicalize a workspace path to the form npm stores in package-lock.json's
// `packages` keys: no leading "./", no trailing "/". Without this, workspaces
// declared as "./apps/foo" or "apps/foo/" would miss the exact-match lookup.
function normalizeWorkspaceKey(p) {
  return path.posix.normalize(p).replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Resolve the `workspaces` field (array form or { packages: [...] } form) into
 * a concrete list of workspace directories relative to the repo root.
 * Supports literal paths and single-level globs like "apps/*".
 */
function resolveWorkspaces(pkg) {
  const raw = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : pkg.workspaces?.packages || [];

  const dirs = [];
  for (const pattern of raw) {
    if (pattern.includes('*')) {
      // Only the common "<prefix>/*" trailing-glob case is supported.
      const prefix = pattern.slice(0, pattern.indexOf('*')).replace(/\/$/, '');
      const baseDir = path.join(rootDir, prefix);
      if (!fs.existsSync(baseDir)) continue;
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const rel = path.posix.join(prefix, entry.name);
        if (fs.existsSync(path.join(rootDir, rel, 'package.json'))) {
          dirs.push(normalizeWorkspaceKey(rel));
        }
      }
    } else if (fs.existsSync(path.join(rootDir, pattern, 'package.json'))) {
      dirs.push(normalizeWorkspaceKey(pattern));
    }
  }
  return dirs;
}

const workspaces = resolveWorkspaces(rootPkg);

console.log('🔍 Validating package-lock.json synchronization...\n');

if (workspaces.length === 0) {
  console.error('❌ No workspaces resolved from root package.json `workspaces`.');
  process.exit(1);
}

console.log(`Found ${workspaces.length} workspace(s): ${workspaces.join(', ')}\n`);

const errors = [];

function checkDepGroup(workspace, group, pkgDeps, lockDeps) {
  for (const [name, version] of Object.entries(pkgDeps || {})) {
    const lockVersion = lockDeps?.[name];
    if (lockVersion !== version) {
      const label = group === 'devDependencies' ? `${workspace} (dev)` : workspace;
      console.log(`❌ ${label}: ${name}`);
      console.log(`   package.json: ${version}`);
      console.log(`   lock file:    ${lockVersion || 'MISSING'}`);
      console.log('');
      errors.push(`${label}: ${name} → package.json=${version}, lock=${lockVersion || 'MISSING'}`);
    }
  }
}

for (const workspace of workspaces) {
  const workspacePkg = readJson(path.join(rootDir, workspace, 'package.json'));
  const lockWorkspace = lockFile.packages[workspace];

  if (!lockWorkspace) {
    console.log(`❌ ${workspace}: workspace missing from package-lock.json\n`);
    errors.push(`${workspace}: workspace entry missing in lock file`);
    continue;
  }

  checkDepGroup(workspace, 'dependencies', workspacePkg.dependencies, lockWorkspace.dependencies);
  checkDepGroup(workspace, 'devDependencies', workspacePkg.devDependencies, lockWorkspace.devDependencies);
}

console.log('='.repeat(80) + '\n');

if (errors.length > 0) {
  console.log('❌ VALIDATION FAILED\n');
  console.log('package-lock.json is OUT OF SYNC with one or more workspace package.json files.\n');
  console.log('Drift:');
  errors.forEach((e) => console.log(`  - ${e}`));
  console.log('\nThis makes `npm ci` fail in CI/CD with:\n');
  console.log('  npm error `npm ci` can only install packages when your package.json');
  console.log('  npm error and package-lock.json are in sync.\n');
  console.log('To fix: run `npm install` at the repo root and commit the updated package-lock.json.\n');
  process.exit(1);
}

console.log('✅ VALIDATION PASSED — all workspace dependencies are in sync with package-lock.json.\n');
process.exit(0);
