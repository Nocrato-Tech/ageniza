const digestPattern = /^ghcr\.io\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*@sha256:[a-f0-9]{64}$/;

export const isImmutableGhcrImage = (value) => typeof value === 'string' && digestPattern.test(value);

export const assertImmutableGhcrImage = (name, value) => {
  if (!isImmutableGhcrImage(value)) {
    throw new Error(`${name} must be ghcr.io/<lowercase-repository>@sha256:<64 lowercase hex characters>.`);
  }
};

if (process.argv[1] && new URL(`file:${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url) {
  const [name = 'image', value] = process.argv.slice(2);
  try {
    assertImmutableGhcrImage(name, value);
    console.log(`${name}: immutable GHCR digest accepted`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
