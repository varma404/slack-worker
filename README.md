# Slack Worker for HubSpot Agent

Slack bot answering HubSpot CRM questions via Claude AI, running in Slack Socket Mode.

## Architecture

A single Node process connects to Slack over Socket Mode (`@slack/bolt`) — there is no public webhook for Slack events, so no inbound URL needs to be reachable or configured in Slack's Event Subscriptions. Express serves only two maintenance/health HTTP routes (`GET /health`, `POST /clear-history`); it does not receive Slack events.

## Slack App Setup

At [api.slack.com/apps](https://api.slack.com/apps), for this app:

1. **Enable Socket Mode** (Settings → Socket Mode) and generate an app-level token (`xapp-...`) → `SLACK_APP_TOKEN`.
2. **Install the app to your workspace** and copy the Bot User OAuth Token (`xoxb-...`) → `SLACK_BOT_TOKEN`.
3. **Subscribe to bot events**: `app_mention`, `message.im`.
4. **Event Subscriptions → Request URL must be empty/unset.** Socket Mode delivers events over the WebSocket connection, not a Request URL — if a Request URL is also configured (e.g. left over from an old deployment), Slack will dispatch every event to both places, producing duplicate/conflicting responses.
5. Ensure the required bot scopes are granted for: `chat:write`, `chat:write.public` (if posting outside channels the bot is in), `files:write` (file uploads), `reactions:write`, `assistant:write` (Agents & Assistants features — rotating status and step-trace streaming).

## Environment Variables

**Required** (enforced by a fail-fast startup check — the process exits immediately if any are missing):

| Variable | Purpose |
|---|---|
| `SLACK_APP_TOKEN` | App-level token for the Socket Mode connection |
| `SLACK_BOT_TOKEN` | Bot OAuth token for all Slack Web API calls |
| `ANTHROPIC_API_KEY` | Claude API access |
| `HUBSPOT_PRIVATE_APP_TOKEN` | HubSpot API access |

**Optional**:

| Variable | Purpose |
|---|---|
| `SLACK_SIGNING_SECRET` | Basic Information → App Credentials. Not required in Socket Mode (Bolt only enforces it for the default HTTP receiver's signature verification), but harmless to set if you have it |
| `PORT` | HTTP port for `/health` and `/clear-history` (defaults to 3000; Railway sets this automatically) |
| `CLAUDE_MODEL` | Override the Claude model id (defaults to `claude-sonnet-4-6`) |
| `LOG_CHANNEL_ID` | Slack channel ID for Q&A audit logging and failure escalation |
| `BUSINESS_CONTEXT` | Free-text addendum appended to the system prompt |
| `WORKER_SECRET` | Shared secret for `x-worker-secret` header auth on `POST /clear-history` — a general admin-endpoint secret, not worker-to-worker auth |

## Railway Deployment

1. Push this repo to GitHub.
2. In [Railway](https://railway.app), open the project and service for this bot, or create one via "New Project" → "Deploy from GitHub repo".
3. Set all required environment variables above (and any optional ones you need).
4. Railway auto-detects `Procfile` (`web: npm start`) and deploys.

## HTTP Endpoints

- `GET /health` — returns uptime, last invocation timestamp, active thread count, thread history count, and boolean flags for which required credentials are present. Used for Railway health checks.
- `POST /clear-history` — admin maintenance route that clears the in-memory thread history cache. Requires the `x-worker-secret` header to match `WORKER_SECRET` if that variable is set; if unset, the endpoint is unauthenticated — always set `WORKER_SECRET` in production.
