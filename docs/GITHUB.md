# Pushing to GitHub through Composio

This machine has no working GitHub login for git (the gh token is invalid and there is no
SSH key). Mars pushes through the owner's Composio account instead: the agent tool
`github_push` replays local commits on GitHub with the Git Data API, sending every
request through `composio proxy <url> --toolkit github`. Composio adds the owner's
GitHub credentials. git never sees a token and Mars stores none.

## Owner setup (once)

The Composio CLI 0.4.5 is already installed for the `bot` user at
`~/.composio/composio` (entry point `~/.local/bin/composio`). It was installed with
shell setup and agent plugins turned off:

    curl -fsSL https://composio.dev/install | COMPOSIO_INSTALL_SHELL=none COMPOSIO_INSTALL_PLUGINS=0 sh

Two steps remain. Only the owner can do them, in a terminal on this machine:

1. `~/.local/bin/composio login` signs in to Composio.
2. `~/.local/bin/composio link github` connects GitHub. Approve the account that can push
   to the repository (for Mars, `mars-s/mars`).

Check with `~/.local/bin/composio proxy https://api.github.com/user --toolkit github </dev/null`.
Until both are done, `github_push` returns `status: "needs_setup"` with these steps in
`ownerSteps`.

## Using it

    await tools.github_push({ repoPath: "/home/bot/ChatGPT/mars", branch: "main", remote: "mars-s/mars" })

`branch` defaults to the checked-out branch and `remote` to the `origin` URL. Results:

- `pushed`: `pushed` commits went up and GitHub's branch now equals the local branch. A
  local remote-tracking ref for the same repository (e.g. `origin/main`) is updated too.
- `up_to_date`: nothing to push. Running it again is always safe.
- `needs_pull`: GitHub has commits this checkout lacks, or the branches diverged. Fetch
  (public repositories fetch over https without a login), rebase or merge, then push again.
- `needs_setup`: give the owner `ownerSteps`.

It throws for signed commits, an empty GitHub repository, API refusals, and any SHA that
differs from the local one.

## How it works (packages/pi-host/github-sync.mjs)

1. Read GitHub's branch (`GET /repos/{o}/{r}/git/ref/heads/{branch}`). It must be an
   ancestor of the local branch (`git merge-base --is-ancestor`); otherwise refuse. For a
   new branch, the repository's default branch is the base.
2. `git rev-list --reverse --topo-order local ^base` lists the commits to send. Each is
   read with `git cat-file commit` and refused up front if it has a signature, an
   encoding or other header GitHub cannot recreate, or non UTF-8 text.
3. Per commit, `git diff-tree -r --raw -z` against the first parent gives the changes.
   Changed contents become blobs (base64); modes 100644, 100755, 120000 (symlink) and
   160000 (submodule) are kept; deletions are sent as `sha: null`. A tree is created
   with `base_tree` set to the parent's tree, and its SHA must equal the local tree.
4. The commit is created with the same message, tree, parents (merges included), author
   and committer names, emails and dates with their timezone offset. GitHub's SHA must
   equal the local SHA.
5. Only after every commit matches, the branch is moved: `PATCH .../git/refs/heads/{branch}`
   with `force: false` (fast-forward only) or `POST .../git/refs` for a new branch.

If anything fails, the GitHub branch is not moved. Objects already created are harmless
and are reused on the next run.

The Composio adapter passes request bodies on stdin (`-d -`), never on the command line.
The CLI prints the response body on stdout and `Status: N` in its log; when the status
line is missing, a GitHub error body (`{ message }`) counts as a failure.
`MARS_COMPOSIO_BIN` overrides where the CLI is found (otherwise `PATH`, then
`~/.local/bin`, then `~/.composio`).

## Tests

`check-github-sync.mjs` runs without network against `github-fake.mjs`, a fake Git Data
API built on a local bare repository with `git hash-object`, `git mktree`,
`git commit-tree` and `git update-ref`, so equal SHAs prove an exact replay. It covers
adds, edits, deletes, executable and symlink changes, unicode and binary files, several
commits, a merge, new branches, refusal when GitHub is ahead or diverged, a re-run with
nothing to push, a timezone-dropping server (SHA mismatch, branch unmoved), signed commit
refusal, an empty repository, and the real CLI adapter through
`github-fake-composio.mjs` (including signed-out and unlinked accounts).

Not yet proven against the real GitHub: that GitHub keeps the exact timezone offset and
message bytes. The SHA check stops the push safely if it does not.
