# Releasing

This package is published to npm as [`@pendle/boros-mcp`](https://www.npmjs.com/package/@pendle/boros-mcp) by GitHub Actions. Local `npm publish` is not used.

## Workflows

| Workflow | Trigger | Effect |
| --- | --- | --- |
| `ci.yml` | PR + push to `main` | Typecheck + build. No secrets. |
| `release.yml` | Push to `main` | If pending changesets exist, opens / updates a "Releasing vX" PR. When that PR merges, publishes to npm with the `latest` tag. |
| `snapshot-release.yml` | `workflow_dispatch` or `workflow_call` | Publishes a snapshot version (`X.Y.Z-<branch>-<sha>`) to npm under the `snapshot` dist-tag. |
| `comment-snapshot-release.yml` | Comment `/snapshot-release` on a PR | Calls `snapshot-release.yml` against the PR branch. Restricted to repo OWNER / MEMBER / COLLABORATOR. |

## Author flow

1. Make changes on a feature branch.
2. Run `yarn changeset` — pick bump type + describe the change.
3. Commit the generated `.changeset/*.md` file with your PR.
4. (Optional) Comment `/snapshot-release` on the PR to publish a snapshot for testing. The workflow replies with the published version.
5. Merge to `main`. `release.yml` opens or updates the **Releasing** PR.
6. Merge the Releasing PR. CI publishes to npm with provenance.

## Required GitHub setup (one-time, by repo admin)

These cannot live in workflow files — set them in the GitHub UI.

### 1. Create environment `npm-registry`

`Settings → Environments → New environment → npm-registry`

- **Required reviewers**: add the Pendle release team (individuals or a team). Every publish job will block here until a reviewer approves.
- **Deployment branches and tags**: restrict to `main` (and snapshot branches if desired).
- **Environment secret `NPM_PUBLISH_TOKEN`**: an npm automation token scoped to `@pendle/boros-mcp`. Use a granular access token, publish-only, with no other package permissions.

### 2. Branch protection on `main`

`Settings → Branches → Add rule → main`

- Require pull request reviews (≥1) before merging.
- Require status checks to pass: `build` (from `ci.yml`).
- Require linear history.
- Block force pushes.
- Restrict who can push to `main` (Pendle team only).
- Do **not** allow bypass for admins on production releases.

### 3. Repository settings

`Settings → Actions → General`

- **Fork pull request workflows from outside collaborators**: "Require approval for first-time contributors" (or stricter).
- **Workflow permissions**: "Read repository contents and packages permissions" (default). Per-job `permissions:` blocks elevate where needed.
- **Allow GitHub Actions to create and approve pull requests**: enabled (changesets/action needs this).

## Defense-in-depth (already wired in workflow files)

- `if: github.repository == 'pendle-finance/boros-mcp'` on every privileged job — forks copying these workflows can't run them.
- `environment: npm-registry` on every publish job — required-reviewer gate, secrets scoped to env.
- Minimal `permissions:` per job (`contents: read` default).
- `id-token: write` only on publish jobs — enables npm provenance via `--provenance`.
- Comment trigger checks `author_association` ∈ {OWNER, MEMBER, COLLABORATOR} before reacting or releasing.
- `concurrency:` groups prevent racing publishes.

## npm provenance

Every published version is signed via GitHub OIDC. The npm page shows a "Built and signed on GitHub Actions" badge linking to the exact workflow run + commit. Verifiable with `npm audit signatures`.

## Rotating the npm token

1. npm: revoke old token under the `@pendle` org's automation tokens.
2. Create a new granular token (publish-only, scoped to `@pendle/boros-mcp`).
3. GitHub: `Settings → Environments → npm-registry → NPM_PUBLISH_TOKEN` → update.

## Manual snapshot release

If the comment trigger is unavailable, use `workflow_dispatch`:

`Actions → Release snapshot package → Run workflow → pick branch`.
