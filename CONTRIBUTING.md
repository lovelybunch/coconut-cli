# Contributing

Thanks for looking under the hood.

## This repository is a mirror

The source of this package lives in the Coconut monorepo, where it is developed and tested
alongside the API it talks to. Every release is exported here by an automated sync, as one
commit per release that names the monorepo commit it came from and lists the changes that
touched the package since the previous release. Nothing is hand-edited in this repository.

What that means for you:

- **Issues are welcome here.** Bug reports, questions and feature requests on this tracker
  reach the maintainers.
- **Pull requests are welcome too**, with one wrinkle: a maintainer ports the change into the
  monorepo with you credited as co-author, and it lands here with the next release. The pull
  request itself is closed with a reference rather than merged, because the next sync would
  overwrite a merge anyway.
- **Releases are cut upstream.** A `vX.Y.Z` tag on this repository publishes to npm, so
  only the sync creates them: the release workflow refuses a tag whose commit is not a sync
  commit, `v*` tags are protected, and write access is limited to the sync's deploy key.

## Working on the code

```bash
pnpm install --frozen-lockfile   # the lockfile pins what the monorepo reviewed
pnpm build        # tsc → dist/
pnpm test         # vitest, mock-fetch unit tests, no network
pnpm lint         # tsc --noEmit over src and tests
```

Node 20 or newer. Formatting follows the `.prettierrc.json` in this repository (Prettier with
a 100-column width); the monorepo's CI enforces it, so a ported change gets formatted there.
Every dependency is pinned to the exact version the monorepo resolved and `pnpm-lock.yaml`
carries the whole tree with integrity hashes; a change to dependencies is made upstream and
arrives with the next release, not by editing them here.

## License

Apache-2.0. By contributing you agree that your contribution is licensed the same way.
