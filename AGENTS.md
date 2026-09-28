<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Flows v2 runs live in flow_runs/flow_versions/flow_run_events and execute only via src/lib/flow-engine.server.ts (minute tick in flow-worker + webhook reply hook); legacy event flows keep flows/flow_steps/scheduled_sends — why: v2 must never change how existing store flows behave.
- Merchant-owned third-party accounts (Google, Razorpay for flows) live in workspace_connections with secrets only in Vault via service-role RPCs — why: secrets must never reach client-readable tables.
- Flows v2 HTTP-step header values live only in flow_http_secrets/Vault (bound to the step's scheme+host+path) and the graph keeps a secret_id; exports/imports carry header names only — why: flow_versions is readable by every member.
