# Examples

Reference projects showing what an rsct-managed codebase looks like.

| Example | State | Notes |
|---|---|---|
| `java-spring/` | Populated | Pre-dates F0 (the knowledge-graph milestone) — `documentation/knowledge/` and `documentation/infrastructure.md` are not yet shown. The §A–§H protocol, decisions, modules, and impact analyses are current. For the full M1 shape (knowledge graph + infrastructure), see the rsct-framework repo itself, which is the working dogfood. |
| `react-ts/` | Skeleton only | README placeholder. Will be filled when v1 lands. |

For a tour of the companion MCP server, see
[`../mcp-server/README.md`](../mcp-server/README.md) — the M1
(Recall), M2 (Enforcement), and M3 (V phase + L4 phase machine +
L3 personas + Tutor + issue capture) surfaces all live there. As of
`v1.0.0` the server ships 30 tools and 5
resources, including the §C-gated commit/push/merge ops, the
SessionStart sanitizer hook, the full R→S→V→C→T phase cycle, the
6 personas, and bilingual (EN + pt-BR) keyword heuristics for
`rsct_classify_task` and `rsct_auto_persona`.
