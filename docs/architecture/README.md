# Architecture diagrams

| Diagram | Editable source | Preview |
|---|---|---|
| System architecture (HLD) | [ai-proctor-hld.drawio](ai-proctor-hld.drawio) | [ai-proctor-hld.png](ai-proctor-hld.png) |
| Component view (LLD) | [ai-proctor-lld.drawio](ai-proctor-lld.drawio) | [ai-proctor-lld.png](ai-proctor-lld.png) |
| Tech stack (5 pages) | [ai-proctor-tech-stack.drawio](ai-proctor-tech-stack.drawio) | [overview](ai-proctor-tech-stack-1-overview.png) · [desktop agent](ai-proctor-tech-stack-2-desktop-agent.png) · [dashboard & shared](ai-proctor-tech-stack-3-dashboard-shared.png) · [backend](ai-proctor-tech-stack-4-backend.png) · [delivery, ops & CI/CD](ai-proctor-tech-stack-5-delivery-ops-cicd.png) |

All three show today's pilot deployment: one Supabase project in US East.

## Editing

- Open a `.drawio` file at [app.diagrams.net](https://app.diagrams.net) (File › Open from › Device), in the draw.io desktop app, or in VS Code with the *Draw.io Integration* extension.
- Icons are embedded in the file, so it opens offline with nothing missing.
- The tech stack file has five pages; switch between them with the page tabs at the bottom of the editor.
- After editing, export a new preview with File › Export as › PNG (zoom 200%, border 40) and commit both files together.

State machines, the sync protocol, API contracts and the schema are in [../architecture-lld.html](../architecture-lld.html).
