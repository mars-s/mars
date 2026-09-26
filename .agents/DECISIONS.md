# Decisions

Architecture decisions and their reasons. Append, do not rewrite. If a decision
is reversed, add a new entry that says so and link the old one.

Format: `## <n>. <decision>` then **Decision**, **Why**, **Cost**.

---

## 1. Revert the Mars fork instead of building on it

**Decision.** Restore the tree to upstream ZCode 3.14.3 (`29628c9`) and delete
the fork's `packages/mars-gateway` and `packages/mars-desktop`.

**Why.** The fork replaced the ZCode workbench UI with a separate thin Electron
client and a small Strands-backed gateway. It was 33 files and about 1,700
lines, and the owner rejected both the UI and the gateway as directions. Keeping
it would have meant maintaining a parallel client.

**Cost.** None. It was all still in git history at `be3382e`.

---

## 2. Remove Z.ai, do not rebrand it

**Decision.** Delete the Z.ai surfaces rather than renaming them to something
else.

**Why.** A rename keeps the shape and the import graph. The surfaces are
interleaved with the generic provider UI inside the same components, so renaming
preserves exactly the coupling that makes this hard.

**Cost.** More surgery now, in exchange for a smaller surface later.

---

## 3. Widen the provider type unions before removing anything

**Decision.** The first code change in the removal work converts
`ModelProviderFamilyId` and `BuiltinModelProviderId` from literal unions to
string types. Nothing else starts until that lands.

**Why.** Those two unions gate how much of the 113-file `packages/ui` surface can
be edited without cascading type errors. Widening them first removes the cascade
risk from every later step.

**Cost.** An hour up front. It buys a reliable estimate for the UI work, which
is otherwise the least predictable part of the project.

---

## 4. Keep the marketplace and the remote connect, drop only their Z.ai origins

**Decision.** The plugin marketplace stays, including the official marketplace
seed in name. The phone remote connect stays. Only the Z.ai CDN that supplies
remote assets and the official marketplace catalog is removed.

**Why.** Both are wanted. What is unwanted is the dependency on
`cdn-zcode.z.ai`. The marketplace already supports `source: "directory"` and
`source: "git"`, so nothing in the plugin engine has to change.

**Cost.** The official marketplace may show an empty catalog until it is
repointed. Local and git sources work regardless.

---

## 5. Verify by typecheck and by hand, not by test suite

**Decision.** Stage 0 and stage 1 are verified with `pnpm typecheck`, `pnpm lint`,
and manual runs. No new test suite is written during the removal.

**Why.** There is no test infrastructure at all. Building one is a project in
itself and would delay the de-Z.ai work the owner wants first. Note the honest
consequence below.

**Cost.** Refactoring 263 files with no automated safety net. If this decision
is revisited, the first thing to add is a smoke test that boots the app,
creates a session, and runs one tool call.

---

## 6. Agent-written plugins will not use ESM hot reload

**Decision.** When the plugin work starts, agent-written plugins are evaluated as
source strings in a `node:vm` realm with a capability facade. Developer-written
plugins may use ESM hot reload later, but that is a separate path.

**Why.** ESM hot reload requires reaching into Node's internal module loader to
delete cache entries across the module graph. That needs `--expose-internals`
(impractical in a shipped Electron app) or a compiled native addon rebuilt for
every target, and the internal API has two incompatible shapes across Node
versions. The Electron renderer cannot do it at all. A string in a `vm` realm
has no cache entry, so it is live by construction.

**Cost.** Agent-written plugins cannot `import`. They get a capability facade
instead, which is arguably the right trade for code a model wrote, but it does
mean they are self-contained.
