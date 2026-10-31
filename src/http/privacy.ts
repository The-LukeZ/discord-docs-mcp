// OPERATOR: this is the legal text of the privacy page. Edit it freely (it is static HTML and nothing here is
// escaped or templated). Keep the facts accurate: the tests only check that "no accounts", "IP",
// "CC-BY-SA 4.0" and "not affiliated with Discord" still appear.
export const privacyHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy - Discord Docs MCP</title>
<style>
  body { font: 16px/1.55 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; color: #1b1b1f; }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; }
  @media (prefers-color-scheme: dark) { body { background: #17171a; color: #e6e6ea; } a { color: #8ab4ff; } }
</style>
</head>
<body>
<h1>Privacy</h1>
<p>This is a free, public MCP server that lets AI assistants search and read Discord's developer documentation.</p>

<h2>What we collect</h2>
<ul>
  <li>There are no accounts and no sign-in.</li>
  <li>We do not store personal data.</li>
  <li>Our logs record which tool was called and the query text that was sent to it. They do not contain IP addresses, user agents or any other identifier of the client.</li>
  <li>The only state we keep is a global usage counter (calls per minute and per day) that is not tied to any caller, and a cache of documentation responses.</li>
</ul>

<h2>Cloudflare</h2>
<p>The server runs on Cloudflare. Cloudflare processes IP addresses transiently in order to deliver requests. We do not receive, log or store them.</p>

<h2>Content and licence</h2>
<p>The documentation served comes from Discord's public developer documentation (<a href="https://github.com/discord/discord-api-docs">discord/discord-api-docs</a>) and is licensed under CC-BY-SA 4.0. Every result links to its source page on docs.discord.com.</p>
<p>This project is not affiliated with Discord, and is not endorsed by Discord.</p>

<h2>Source</h2>
<p><a href="https://github.com/The-LukeZ/discord-docs-mcp">github.com/The-LukeZ/discord-docs-mcp</a></p>
</body>
</html>
`;
