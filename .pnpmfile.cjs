// better-auth declares vitest as an optional peer for its own test suite. Because vitest exists
// in this workspace, pnpm resolves that peer and `pnpm deploy --prod` ships vitest and its whole
// chain in the API image (issue #281). pnpm 9 has no declarative way to skip a single optional
// peer: ignoredOptionalDependencies only reaches optionalDependencies, and
// resolve-peers-from-workspace-root does not stop workspace peers from being picked up. Removing
// the peer declaration before resolution is the only knob that keeps every other optional
// dependency untouched.
//
// Any edit to this file requires regenerating pnpm-lock.yaml in the same change: pnpm records its
// content in `pnpmfileChecksum` and every Docker install runs with --frozen-lockfile.
// Once better-auth stops declaring the peer, the hook is a silent no-op and can be deleted; the CI
// gate scripts/ci/verify-api-production-closure.mjs is what fails if the chain comes back. The four
// Dockerfiles copy this file so the frozen install can verify that checksum.
module.exports = {
  hooks: {
    readPackage (pkg) {
      if (pkg.name !== 'better-auth') return pkg
      if (pkg.peerDependencies) delete pkg.peerDependencies.vitest
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.vitest
      return pkg
    }
  }
}
