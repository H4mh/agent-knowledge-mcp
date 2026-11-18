# agent-knowledge-mcp

**English | [简体中文](README.zh-CN.md)**

A multi-agent knowledge-sharing MCP service for teams — let every coding agent on your team (Claude Code, Cursor, Trae, etc.) share the same "lessons-learned library".

A pit one agent falls into, no other agent needs to fall into again.

## The Problem It Solves

Coding agents repeatedly solve the same classes of problems (framework pitfalls, dependency conflicts, database dialect quirks...), but that experience usually dies with the session. This project provides an MCP service deployed on a team server, where all agents read and write the same knowledge base through a unified tool protocol:

- **Capture**: after an agent solves a problem, it saves the symptom/solution to the knowledge base for the whole team to reuse
- **Reuse**: before picking up a new task, agents search first and get a previously verified solution directly
- **Governance**: knowledge has status (draft / verified / deprecated), freshness (use count and last-used time), and ages — long-unused verified entries automatically fall back to draft

## Features

### 9 MCP Tools

| Tool | Purpose |
|------|---------|
| `search_knowledge` | Search knowledge (keyword + trigram scoring, results carry `use_count` / `last_used_at` freshness fields) |
| `save_knowledge` | Save new knowledge (with hard rejection of secrets + customer-data redaction checks) |
| `update_knowledge` | Update an existing entry |
| `mark_used` | Mark a piece of knowledge as used (updates use_count / last_used_at, feeding the aging governance) |
| `get_context` | Get kickoff context by scope + module |
| `save_skill` | Save a reusable operational skill (the SKILL.md install entry is assembled automatically; saved as draft) |
| `search_skills` | Search the team skill library for reusable operational skills |
| `get_skill` | Fetch a skill's assembled SKILL.md + attachment files with install guidance (write them into your local skills directory); each fetch counts usage and feeds draft→verified promotion |
| `update_skill` | Update an existing skill (author or admin; replacing `files` wholesale is the only way to remove attachment files) |

No destructive MCP tools are provided — to avoid accidental deletion by agents. Deletion and forced status changes are admin-only, via the admin CLI.

### Vector Semantic Search (optional, disabled by default)

Enabled by configuring an intranet embedding model via environment variables (supports OpenAI-compatible / Ollama / custom protocols, see [docs/deploy.md](docs/deploy.md)):

- Saved/updated entries get embeddings stored in pgvector automatically; search blends in a semantic score, so entries with zero keyword overlap but related meaning can still be recalled
- Degrades gracefully to keyword-only search when the embedding service is down — save/update/search main flows are never affected
- The admin `embed` command backfills vectors for existing entries in one shot

### Zero-Touch Onboarding

- **Open self-registration**: put your identity name in the Bearer token and the first tool call registers you — the server mints a random access token (`identity_token`) and returns it once in that response; write it back into the config and it becomes your credential (the name is just a signature afterwards); optional `AKM_JOIN_SECRET` team passphrase blocks name-squatting; disabled identities are permanently banned, preventing spoofing of registered usernames
- **Auto scope registration**: scope uses the git repo name (last segment of `git remote get-url origin`), auto-registered on first save with its creator recorded — preventing knowledge-base fragmentation from agents inventing arbitrary strings
- **One-command onboarding scripts**: `integration/` ships Claude Code global/project install scripts (bash + PowerShell); a SessionStart hook injects the knowledge-base usage rules and this project's scope automatically
- **Knowledge aging**: the admin `decay` command demotes long-unused verified entries back to draft (inspired by Mem0/Zep memory decay), so stale knowledge doesn't keep wearing its "verified" halo forever

### Browser Knowledge Portal

- Static SPA on the same port (`http://<server>:3000/`); login uses the same identity token as MCP; the portal never registers new identities
- Standalone `/login` page: protected areas (upload/edit, admin console) redirect there with a `?redirect=` round-trip; a mid-session 401 (token revoked) auto-redirects and returns you to where you were after signing in
- Search / browse by scope / detail with mark_used / create & edit (with dedup precheck) / stats dashboard / admin console (status transitions, deletion, scopes, users) — all anonymously browsable; only writes need sign-in
- Skills: search & browse / detail / upload & edit (entry points redirect to the login page when not signed in); the same skill data is exposed via REST (`/api/skills`) and the MCP skill tools. Attachments: up to 20 files, 64KB each, 256KB total (plain-text `{path, content}` manifests)

### Safety Rails

- Hard rejection of secrets: private key blocks, API tokens, database connection strings with passwords, etc.
- Customer-data checks: national ID / bank card number regex hits are rejected until redacted
- Per-token rate limiting to keep a runaway agent loop from hammering queries; anonymous (token-less) requests are rate-limited per IP
- Read-only API endpoints (`GET /api/knowledge`, `GET /api/stats`, `GET /api/skills`) are anonymously accessible for browsing the portal; every write and all admin operations require a Bearer token
- Scope soft-isolation for entries: visible across projects but weighted toward the same project — fits "one team, several related projects"

## Tech Stack

- TypeScript + official MCP SDK (Streamable HTTP, stateless, multi-instance friendly)
- PostgreSQL 17 + pgvector (keyword/trigram scoring as the core, vector semantic search optional)
- Fastify 5 + Docker Compose deployment

## Quick Start

### Deploy the Server

```bash
# On your server (Docker required)
cd /opt/agent-knowledge-mcp
AKM_DB_PASSWORD='<strong-password>' AKM_APP_PORT=3000 docker compose up -d --build

# Create the admin account
docker exec akm-app node dist/scripts/admin.js adduser admin --token '<admin-token>' --role admin
```

Full steps (TLS recommendations, backups, upgrades, git mirroring) in [docs/deploy.md](docs/deploy.md).

> ⚠️ **Security note**: writes and admin operations require a Bearer token; read-only API endpoints are anonymously accessible (IP rate-limited) for portal browsing — restrict the MCP port's source IPs in your cloud security group; never allow 0.0.0.0/0.

### Agent Onboarding

`integration/` ships ready-made onboarding materials:

```bash
# Claude Code global setup (one config, works for all projects on this machine)
bash integration/setup-akm-global.sh          # macOS / Linux
pwsh integration/setup-akm-global.ps1         # Windows

# Or per-project setup
bash integration/setup-akm.sh
```

Other clients that support Streamable HTTP MCP (Cursor, Trae, etc.), configure manually:

```json
{
  "mcpServers": {
    "team-knowledge": {
      "type": "http",
      "url": "http://<your-server>:3000/mcp",
      "headers": { "Authorization": "Bearer <your-name; swap in your identity_token after registering>" }
    }
  }
}
```

The first tool call registers you; the server mints a random access token (`identity_token`) and returns it once — **write it back into `Authorization: Bearer <token>` and restart the session immediately** (the token is shown only once; if lost, an admin must `reset-token`). Your name is just a signature afterwards.

Details and FAQ in [integration/使用教程.md](integration/使用教程.md) (Chinese; CLI samples are copy-paste friendly).

### Admin Cheat Sheet

```bash
docker exec akm-app node dist/scripts/admin.js <command>

adduser <name> --token <token> [--role admin]   # create account (optional under open registration)
listusers | listusers --legacy                  # user management; --legacy lists accounts still using their username as token
reset-token <name>                              # mint a new random access token (plaintext shown once, deliver out-of-band)
disable <name> | enable <name>                  # disable/enable identities
list-scopes | delete-scope <scope>               # scope management
delete-knowledge <id> | set-status <id> <draft|verified|deprecated>
history <id> | history --skill <name>            # revision history (latest 50)
delete-skill <name> | set-skill-status <name> <draft|verified|deprecated>   # skill management
decay [--days 90] [--dry-run]                    # aging: demote stale verified entries to draft
embed                                            # backfill embeddings (requires an embedding model)
export <dir>                                     # export all entries as frontmatter markdown
```

An `import-markdown` script batch-imports seed knowledge from a frontmatter markdown directory (see `scripts/seed-example/`).

## Project Structure

```
src/
  index.ts            # entry point, starts the HTTP server
  app.ts              # Fastify + MCP routes, tool registration
  auth.ts             # Bearer auth, open self-registration, rate limiting
  config.ts           # environment configuration
  db.ts               # Postgres connection and migrations
  tools/              # save / search / update / markUsed / context / skill
  search/             # tokenization, tag aliases, scored search (knowledge + skills)
  admin/              # admin service shared by CLI and REST
  api/                # REST routes and queries for the web portal (knowledge + skills)
scripts/
  admin.ts            # admin CLI
  import-markdown.ts  # batch markdown import
  seed-example/       # seed knowledge example
migrations/           # SQL migrations (idempotent, run at startup)
integration/          # client onboarding scripts and tutorial
web/                  # Vue 3 + Ant Design Vue portal SPA
tests/                # vitest tests (incl. e2e)
docs/deploy.md        # deployment guide
```

## Development

```bash
npm install
# Spin up a local test database (port 5433)
docker run -d --name akm-test-db -e POSTGRES_USER=akm -e POSTGRES_PASSWORD=akm -e POSTGRES_DB=akm_test -p 5433:5432 postgres:17
TEST_DATABASE_URL="postgresql://akm:akm@localhost:5433/akm_test" npm test
```

Tests use a real Postgres (trigram indexes and Chinese tokenization can't be simulated in-memory); `fileParallelism: false` keeps the shared test database clean.

## License

MIT
