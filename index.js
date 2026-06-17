/**
 * Slack Worker - Process events asynchronously
 */

const express = require('express');
const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Initialize Claude client
const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Process Slack event
 * Called by main Vercel app when an event arrives
 */
app.post('/process', async (req, res) => {
  try {
    console.log('[WORKER] Processing event:', req.body.event?.type);
    
    const { event, token } = req.body;
    
    if (!event || !token) {
      return res.status(400).json({ error: 'Missing event or token' });
    }

    // Respond immediately so caller knows we got it
    res.status(200).json({ queued: true });

    // Now process async
    processEvent(event, token).catch(error => {
      console.error('[WORKER ERROR]', error.message);
    });

  } catch (error) {
    console.error('[WORKER] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Process the event asynchronously
 */
async function processEvent(event, slackToken) {
  try {
    console.log('[PROCESS] Starting for event type:', event.type);

    const slack = new SlackClient(slackToken);

    // Only process mentions and DMs
    const isMention = event.type === 'app_mention';
    const isDM = event.type === 'message' && event.channel_type === 'im';

    if (!isMention && !isDM) {
      console.log('[PROCESS] Ignoring event type:', event.type);
      return;
    }

    // Extract question
    const question = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!question) {
      console.log('[PROCESS] No question text');
      return;
    }

    console.log('[PROCESS] Question:', question);

    // Add hourglass reaction
    await slack.addReaction(event.channel, event.ts, 'hourglass_flowing_sand').catch(() => {});

    // Call Claude to generate response
    console.log('[PROCESS] Calling Claude...');
    const response = await claude.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 500,
      system: 'You are a helpful HubSpot assistant for Saras Analytics. Answer questions about CRM data concisely.',
      messages: [
        { role: 'user', content: question }
      ]
    });

    const answer = response.content[0]?.type === 'text' ? response.content[0].text : 'No response generated';
    console.log('[PROCESS] Got response from Claude');

    // Post response to Slack
    await slack.postMessage(
      event.channel,
      [{ type: 'section', text: { type: 'mrkdwn', text: answer } }],
      { thread_ts: event.thread_ts || event.ts }
    );

    console.log('[PROCESS] Posted response to Slack');

    // Remove hourglass
    await slack.addReaction(event.channel, event.ts, '-hourglass_flowing_sand').catch(() => {});

    console.log('[PROCESS] Complete');
  } catch (error) {
    console.error('[PROCESS ERROR]', error.message);
  }
}

/**
 * Simple Slack client
 */
class SlackClient {
  constructor(token) {
    this.token = token;
  }

  async postMessage(channel, blocks, options = {}) {
    const payload = {
      channel,
      blocks,
      thread_ts: options.thread_ts,
      reply_broadcast: options.reply_broadcast || false,
      text: 'Message from HubSpot Agent'
    };

    return this.request('/chat.postMessage', payload);
  }

  async addReaction(channel, timestamp, emoji) {
    const payload = {
      channel,
      timestamp,
      name: emoji.replace(/:/g, '')
    };

    return this.request('/reactions.add', payload);
  }

  async request(endpoint, payload) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);

      const options = {
        hostname: 'slack.com',
        port: 443,
        path: `/api${endpoint}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.ok) {
              reject(new Error(`Slack error: ${parsed.error}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`[WORKER] Listening on port ${PORT}`);
});
