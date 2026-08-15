# Releasing

One tag produces one GitHub release with the `.vsix` attached, and — once the
tokens are configured — the same `.vsix` on the **VS Code Marketplace** and on
**Open VSX** (VSCodium, Theia, SAP Business Application Studio).

Everything mechanical lives in `.github/workflows/release.yml`; its header
comment is the reference. This file is the human checklist.

## How reversible is it?

A published version cannot be replaced, and deleting a single version is not
something either marketplace offers. What *is* possible is removing the
extension as a whole — `vsce unpublish abap2ui5.abap2ui5`, or the *Remove*
action on the Marketplace manage page — which takes every version with it and
is meant as an emergency exit, not as a correction.

The everyday correction is a new version: releasing `0.22.1` makes `0.22.0`
irrelevant, because everyone is updated automatically. What genuinely cannot
be taken back is the *publisher ID* — `abap2ui5` in `package.json` — so that
is the one thing worth getting right the first time.

The realistic failure mode is not "broken forever", it is "a bad version is
out for a few minutes". The fix is always the same: bump the patch version and
release again.

## One-time setup

**VS Code Marketplace**

1. Create the publisher `abap2ui5` on
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) —
   it must match `publisher` in `package.json` exactly, and cannot be renamed.
2. In Azure DevOps → *User settings* → *Personal Access Tokens*, create a token
   with **All accessible organizations** and the scope **Marketplace → Manage**.
3. Store it as the repository secret `VSCE_PAT`.

**Open VSX**

1. Sign in on [open-vsx.org](https://open-vsx.org) with GitHub, create an
   access token.
2. Claim the namespace once — publishing into a namespace that does not exist
   fails:
   ```sh
   npx ovsx create-namespace abap2ui5 -p <token>
   ```
3. Store the token as the repository secret `OVSX_PAT`.

Each publish step is skipped while its secret is unset, so a release works
before either account exists — it just stops at the GitHub release.

## Every release

1. Bump `version` in `package.json`.
2. Add the matching `## X.Y.Z` section to `CHANGELOG.md` — it becomes the
   release notes verbatim.
3. Either *Actions → Release → Run workflow* (the manifest decides the tag), or
   `git tag vX.Y.Z && git push origin vX.Y.Z`.

The workflow refuses to release when the tag and `package.json` disagree, so a
release is always reproducible from its tag.

Useful properties when something goes wrong:

- **Re-runs are safe.** An existing release gets its `.vsix` replaced rather
  than failing the run, and a tag already pointing at the same commit is
  treated as a retry — so a run that died on an expired token can simply be
  re-run once the secret is fixed.
- **A wrong tag is not a release.** Before the publish steps run,
  `git push --delete origin vX.Y.Z` undoes it completely.

## Before the first release

Build the package locally and look at what is in it:

```sh
npm ci
npm run lint
npm run vsix          # writes abap2ui5-X.Y.Z.vsix and prints the file list
code --install-extension abap2ui5-X.Y.Z.vsix
```

Installing that `.vsix` is exactly what a Marketplace user gets, so trying it
once in a clean window is the cheapest possible dress rehearsal.
