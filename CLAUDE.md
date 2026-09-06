\# DevPulse



Developer observability dashboard.



\## Stack



\- Next.js 16 App Router

\- React 19

\- TypeScript

\- Tailwind CSS v4

\- Server Components by default



\## Working Rules



\- Work on one bounded task at a time.

\- Inspect only files relevant to the current task.

\- Prefer targeted search over repository-wide exploration.

\- Never inspect node\_modules, .next, dist, generated files, or lockfiles

&#x20; unless required.

\- Check git diff/status before rereading files already modified.

\- Do not use web search unless necessary.

\- Do not spawn subagents unless explicitly useful.

\- Do not refactor unrelated code.

\- Do not create abstractions until duplication justifies them.

\- Preserve existing working behavior.

\- Prefer minimal dependencies.

\- Run only relevant verification.

\- Stop when the requested task is complete.



\## Architecture



src/

&#x20; app/          Routes and layouts

&#x20; components/   Shared UI

&#x20; lib/          Utilities/services

&#x20; data/         Temporary mock data



\## UI



Minimal developer-tool aesthetic inspired by Linear, Claude and Vercel.



\- neutral palette

\- subtle borders

\- restrained radius

\- compact information density

\- whitespace

\- status colors only when meaningful

\- no gradients

\- no glassmorphism

\- no excessive cards/shadows

\- no decorative animations



\## Development



Each milestone:



inspect → implement → verify → git diff → report → stop



Do not automatically begin another milestone.



\## Completion Report



Return only:



\- Files changed

\- Implemented

\- Verification

\- Remaining issue

\- Recommended next task

