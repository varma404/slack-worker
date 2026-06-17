# Slack Worker for HubSpot Agent

Async worker to process Slack events with Claude AI and HubSpot integration.

## Deployment on Railway

1. Push this to GitHub
2. Go to https://railway.app
3. Click "New Project" → "Deploy from GitHub repo"
4. Select this repo
5. Add environment variables:
   - `ANTHROPIC_API_KEY`: Your Claude API key
   - `SLACK_BOT_TOKEN`: Your Slack bot token

6. Railway will automatically detect `Procfile` and deploy

## Usage

Main Vercel app POSTs to `https://your-railway-domain.railway.app/process` with:
```json
{
  "event": { /* Slack event object */ },
  "token": "xoxb-your-slack-token"
}
```

Worker responds immediately and processes async.
