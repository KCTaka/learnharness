# Work log: held-result notice, agent health check, teaching profile

Branch `feat/nonlocally-and-claude`, 2026-10-30. Three independent changes, one commit each.

## 1. Held-result notice (commit "say a finished agent result is held…")

**Observation:** a finished figure/demo/research job did not appear until a pending client-side question was answered.

**Finding:** intended. `waitForIdle` (`src/server/jobs.ts`) blocks result delivery while a dangling client-side question exists (`findPendingToolCall`, `src/core/pending.ts`), so the steer message can't interleave with an unanswered question. Delivery is unchanged.

**Change:** `DispatchCard` shows "· the result|the notice will appear after you answer the question" while the job's delivery is `pending` and a question is pending. `ChatActionsContext` gained `questionPending`. Test in `tests/render-cards.test.tsx`.

## 2. Agent health check (commit "add live health check…")

Settings → Agent → **Test agents** runs the research, demo and figure agents on small real tasks and reports pass/fail, duration, cost and the failure reason.

- `src/agent/subagents/health-check.ts`: per-kind checks with evidence-based pass criteria and `HEALTH_TIMEOUT_MS`.
- `src/server/agent-health.ts`: same engine resolution (`resolveRoleSpec`/`piEngineForSpec`), key gate and search seam as the job runner, read fresh per run; cost via `jobCost`.
- `app/api/agents/health/route.ts`: `POST {kind}`, 400 on a bad kind, forwards `req.signal`.
- `components/settings/agent-health.tsx`, mounted in `agent-section.tsx`.
- Contracts in `src/core/contracts/jobs.ts` (`AGENT_HEALTH_KINDS`, `AgentHealthResult`). Tests: `tests/agent-health.test.ts` (10).

Not run against real models by the author: click **Test agents** once.

## 3. Teaching profile (commit "learn how to teach each user…")

One global, user-editable profile (`data/profile.json`) with optional per-subject notes.

- **Read path:** the teacher calls the read-only tool `read_teaching_profile` (`src/agent/tools/profile.ts`); prompt fragment `prompts/teacher/45-teaching-profile.md`.
- **Learn path:** `src/agent/subagents/profile-learner.ts` (strong slot, `profileLearner` role) updates the profile from check results and an end-of-session reflection. Triggered after 20 min idle (`armProfileIdle`) or via **Wrap up session…** (`app/api/chats/[id]/wrap-up`, `components/wrap-up-dialog.tsx`).
- **Edit path:** Settings → Teaching profile (`components/settings/profile-section.tsx`, `app/api/profile`: GET/POST/PUT/DELETE, `?all=true` clears).
- Layering: pure ops in `src/core/teaching-profile.ts`; `ProfileStore` port, store `src/store/profile.ts` is the sole writer; wired only in `src/server/stores.ts`. Tests: `tests/teaching-profile.test.ts` (34).

### Decisions made without explicit sign-off (review these)

- `profileLearner` is slot-only on the strong tier; not in the per-role override list.
- The learner may not edit or remove manual entries.
- A blank wrap-up doesn't force a run (still needs ≥1 answered check and a changed transcript); a non-empty reflection always runs.
- Practice sessions are excluded; wrap-up item hidden for them.
- Clear profile keeps the learned-session fingerprints (old sessions aren't re-learned).
- The learner sees at most the newest 120,000 characters of a transcript.
- The learning pass does no subscription consent/catalog refresh.

### Known gaps

- Live model behaviour (learning pass, teacher using the tool) and the new UI in a browser are unverified.
- Learning-pass model spend isn't recorded in a usage ledger.
- Deleting a session leaves its idle timer; it fires, finds no chat, and skips.
- `tests/render-sidebar.test.tsx:84` ("awaiting meta keeps the existing date") failed before these changes too (pre-existing, per the sub-agent).

## Integration and install

- Rebased the three commits onto `origin/feat/nonlocally-and-claude` (which had merged upstream 0.4.0); no conflicts. `npm install` was needed for new upstream deps; `tsc --noEmit` is clean.
- Built the Windows NSIS installer per `docs/desktop-release.md` (`next build` → `build-server` → `smoke-server --electron` → `electron-builder --win --x64`). The first smoke run timed out on a cold start; the retry passed.
- Installed `LearnHarness-0.4.0-x64-setup.exe` silently over the existing per-user install. JSON data under `%APPDATA%\LearnHarness` (chats, graph, jobs, settings, auth) was md5-identical before and after.
- `next.config.ts` (an uncommitted `allowedDevOrigins` edit) and `.claude/` were deliberately left out of the commits.
