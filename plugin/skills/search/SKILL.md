---
name: search
description: Look up Discord API behaviour in the official developer docs. Use for questions about Discord endpoints, objects, enums, gateway events, permissions, or recent API changes.
argument-hint: <question, route, object or enum name>
---

Answer the question using the discord-docs MCP tools instead of memory. Discord's API changes often.

The tools may be deferred. If they are not listed, load them with tool search first. Search for the tool names (`search_docs`, `lookup_endpoint`, `lookup_object`, `lookup_enum`, `get_section`, `recent_changes`), not for the topic of the question. Tool names can carry a server prefix such as `discord-docs`.

If tool search finds none of them, the discord-docs server is not connected in this client. Say so in one line and tell the user to add the connector `https://bugcord-mcp.dev/mcp` (no authentication). Then answer from https://docs.discord.com/developers and say the answer is not from the indexed docs.

- Known route, object or enum name: call `lookup_endpoint`, `lookup_object` or `lookup_enum`.
- Open question: call `search_docs`, then `get_section` when a snippet is not enough.
- "What changed lately": call `recent_changes`.

Cite the docs.discord.com URL from each result and state the indexed commit.

Question: $ARGUMENTS
