# Release ALchemist

Prepare and ship a new release of the ALchemist VSCode extension. The GitHub Actions workflow (`.github/workflows/release.yml`) handles testing, packaging, publishing to the marketplace, and creating a GitHub release on tag push. Your job is prep + tag.

## Process

Follow these steps in order. Stop and ask the user before pushing the tag.

### 1. Determine version bump

Ask the user what kind of release this is:
- **patch** (0.1.0 → 0.1.1) — bug fixes only
- **minor** (0.1.0 → 0.2.0) — new features, backward compatible
- **major** (0.1.0 → 1.0.0) — breaking changes

If the user provided the version type as an argument (e.g., `/release minor`), use that without asking.

### 2. Gather changes since last release

```bash
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline
```

Categorize each commit:
- **Features** — commits starting with `feat:`
- **Fixes** — commits starting with `fix:`
- **Other** — `chore:`, `docs:`, `refactor:`, etc. (only if noteworthy)

### 3. Update CHANGELOG.md

Add a new section at the top (below the `# Changelog` header):

```markdown
## X.Y.Z (YYYY-MM-DD)

### Features
- Description of each feature (rewritten for users)

### Fixes
- Description of each fix

### Other
- Only if noteworthy (skip section if empty)
```

Write entries from the user's perspective, not the developer's. "Add hover tooltip showing captured variable values" not "feat: wire getCapturedValues into hoverProvider".

### 4. Update version in package.json

Change the `"version"` field to the new version.

### 5. Check if README.md needs updating

Compare README features table, commands table, settings table against current `package.json` and new features. Update any drift. Also update any hardcoded version in the VSIX install example (`code --install-extension alchemist-X.Y.Z.vsix`). Skip if nothing changed.

### 6. Run tests locally (fast fail before CI)

```bash
npm run test-compile && npx mocha out/test/suite/*.test.js
```

All tests must pass before proceeding.

### 7. Build production bundle (sanity check)

```bash
npx webpack --mode production
```

Must compile without errors.

### 8. Local VSIX sanity check

Build a VSIX locally and verify it doesn't contain dev-only files (`CLAUDE.md`, `.claude/`, `cobertura.xml`, source maps, etc.):

```bash
npx @vscode/vsce package --no-dependencies
```

If junk is shipped, add it to `.vscodeignore`, rebuild, and commit `.vscodeignore` before continuing. Delete the local VSIX — CI builds the one that ships.

### 9. Commit release changes

```bash
git add package.json CHANGELOG.md README.md
git commit -m "release: vX.Y.Z"
```

### 10. Push branch first, then tag (ask user before tag push)

Push the commit first so CI doesn't race against a missing commit:

```bash
git push origin master
```

Then ask the user to confirm before pushing the tag — **the tag push triggers marketplace publish**:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

### 11. Watch the workflow

```bash
gh run watch
```

Or open the Actions tab in GitHub. The workflow will:
1. Install deps and run tests
2. Package the VSIX
3. Publish to marketplace using `VSCE_PAT` secret
4. Create a GitHub release with the VSIX attached and auto-generated notes

### 12. Verify

After the workflow succeeds:
- Marketplace: https://marketplace.visualstudio.com/items?itemName=SShadowSdk.al-chemist
- GitHub release: https://github.com/SShadowS/ALchemist/releases/tag/vX.Y.Z

Report the published version and both URLs to the user.

## Fallback: manual publish

If CI fails on publish (expired `VSCE_PAT`, marketplace outage), trigger the workflow manually from the Actions tab with `dry_run: true` to download the VSIX artifact, then publish from a terminal:

```bash
npx @vscode/vsce publish --packagePath al-chemist-X.Y.Z.vsix
```

Fix the underlying issue (rotate PAT in repo secrets) so the next release goes through CI.
