# Release ALchemist

Prepare and publish a new release of the ALchemist VSCode extension to the marketplace.

## Process

Follow these steps in order. Stop and ask the user before publishing.

### 1. Determine version bump

Ask the user what kind of release this is:
- **patch** (0.1.0 → 0.1.1) — bug fixes only
- **minor** (0.1.0 → 0.2.0) — new features, backward compatible
- **major** (0.1.0 → 1.0.0) — breaking changes

If the user provided the version type as an argument (e.g., `/release minor`), use that without asking.

### 2. Gather changes since last release

```bash
# Find the last version tag (or use first commit if no tags)
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline
```

Categorize each commit as:
- **Features** — commits starting with `feat:`
- **Fixes** — commits starting with `fix:`
- **Other** — `chore:`, `docs:`, `refactor:`, etc. (include only if noteworthy)

### 3. Update CHANGELOG.md

Add a new section at the top (below the `# Changelog` header) with:

```markdown
## X.Y.Z (YYYY-MM-DD)

### Features
- Description of each feature (from commit messages, rewritten for users)

### Fixes
- Description of each fix

### Other
- Only if noteworthy (skip section if empty)
```

Write entries from the user's perspective, not the developer's. "Add hover tooltip showing captured variable values" not "feat: wire getCapturedValues into hoverProvider".

### 4. Update version in package.json

Change the `"version"` field to the new version number.

### 5. Check if README.md needs updating

Read README.md and compare against the current feature set. If new features were added that aren't reflected in the README features table, update it. If nothing changed feature-wise, skip this step.

### 6. Run tests

```bash
npm run test-compile && npx mocha out/test/suite/*.test.js
```

All tests must pass before proceeding. If any fail, stop and fix them first.

### 7. Build production bundle

```bash
npx webpack --mode production
```

Must compile without errors.

### 8. Commit release changes

```bash
git add package.json CHANGELOG.md README.md
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
```

### 9. Push to GitHub

```bash
git push origin master --tags
```

### 10. Package and publish

```bash
npx @vscode/vsce package --no-dependencies
```

Show the user the VSIX contents and size, then ask for confirmation before publishing:

```bash
npx @vscode/vsce publish
```

### 11. Confirm

After publishing, verify the extension page:
```
https://marketplace.visualstudio.com/items?itemName=SShadowSdk.al-chemist
```

Report the published version and marketplace URL to the user.
