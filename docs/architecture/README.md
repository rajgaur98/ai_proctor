# Architecture diagrams

| Diagram | Editable source | Preview |
|---|---|---|
| System architecture (HLD) | [ai-proctor-hld.drawio](ai-proctor-hld.drawio) | [ai-proctor-hld.png](ai-proctor-hld.png) |
| Component view (LLD) | [ai-proctor-lld.drawio](ai-proctor-lld.drawio) | [ai-proctor-lld.png](ai-proctor-lld.png) |

Both show today's pilot deployment: one Supabase project in US East.

## Editing

- Open a `.drawio` file at [app.diagrams.net](https://app.diagrams.net) (File › Open from › Device), in the draw.io desktop app, or in VS Code with the *Draw.io Integration* extension.
- Icons are embedded in the file, so it opens offline with nothing missing.
- After editing, export a new preview with File › Export as › PNG (zoom 200%, border 40) and commit both files together.

State machines, the sync protocol, API contracts and the schema are in [../architecture-lld.html](../architecture-lld.html).
