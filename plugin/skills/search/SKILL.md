---
name: search
description: Look up Discord API behaviour in the official developer docs. Use for questions about Discord endpoints, objects, enums, gateway events, permissions, or recent API changes.
argument-hint: <question, route, object or enum name>
---

Answer the question using the discord-docs MCP tools instead of memory. Discord's API changes often.

- Known route, object or enum name: call `lookup_endpoint`, `lookup_object` or `lookup_enum`.
- Open question: call `search_docs`, then `get_section` when a snippet is not enough.
- "What changed lately": call `recent_changes`.

Cite the docs.discord.com URL from each result and state the indexed commit.

Question: $ARGUMENTS
