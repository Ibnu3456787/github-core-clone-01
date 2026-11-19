# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ibnu3456787/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ibnu3456787/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process, zero dependencies: git smart HTTP
(protocol v0 and v2, native packfile read/write), REST v3 (repos, branches, commits,
contents, issues, labels, pull requests, squash merges), GraphQL v4 (the documents
`gh` and `github-mcp-server` send, plus introspection and cursor pagination), and an
MCP endpoint (modern `server/discover` plus the legacy `initialize` handshake). The
store is fully in-memory for speed; every timestamp comes from `MAKEFUN_TRIAL_NOW`
and every id is sequential, so two runs on one instance leave identical state.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
Node built-ins (`node:http`, `node:zlib`, `node:crypto`) and its own modules
only, and the trial has no package manager and no internet.

`main.ts` is the entry ↔ env lifecycle (bind an ephemeral port, register with
`$MAKEFUN_ENV_URL`, poll `/done`); `app.ts` builds the HTTP server; `src/`
holds the forge: `objects.ts` (git object model + packfiles), `store.ts`
(in-memory store), `git.ts` (smart HTTP), `rest.ts` (REST v3), `graphql.ts`
(GraphQL v4 executor), `mcp.ts` (MCP endpoint), `forge.ts` (contents commits,
diffs, merges), `diff.ts` (tree/line diffs, merge-base, conflict detection).

---

<sub>Entered on [make.fun](https://make.fun/?ref=zq0xe8tm&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
