// Gateway wiring for the Pi host (docs/GATEWAY.md): which adapters start, the owner-only
// HTTP routes, the agent tool and the channel badge on conversation rows. server.mjs calls
// these; nothing here touches platform secrets except to pass them to an adapter.
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { ChannelDoc, createGateway } from './core.mjs';
import { createApiAdapter } from './adapters/api.mjs';
import { createTelegramAdapter } from './adapters/telegram.mjs';
import { createDiscordAdapter } from './adapters/discord.mjs';

const output = (value) => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });
const nativeId = (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+(\/|$)/;
/**
 * The gateway settings a staging or check host may use: only with MARS_GATEWAY_FAKE=1, and
 * each adapter only when its API base points at loopback. Everything else is dropped, so a
 * staged host can never reach real Telegram or Discord.
 */
export function loopbackGatewayEnv(env) {
  if (env.MARS_GATEWAY_FAKE !== '1') return {};
  const out = {};
  if (LOOPBACK.test(env.MARS_TELEGRAM_API ?? ''))
    for (const key of ['MARS_GATEWAY_TELEGRAM', 'MARS_TELEGRAM_TOKEN', 'MARS_TELEGRAM_API', 'MARS_TELEGRAM_OWNER']) if (env[key] !== undefined) out[key] = env[key];
  if (LOOPBACK.test(env.MARS_DISCORD_API ?? ''))
    for (const key of ['MARS_GATEWAY_DISCORD', 'MARS_DISCORD_TOKEN', 'MARS_DISCORD_API', 'MARS_DISCORD_OWNER', 'MARS_DISCORD_MESSAGE_CONTENT']) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

/**
 * Start the gateway with the HTTP API adapter, plus Telegram and Discord only when the
 * owner turned them on (MARS_GATEWAY_TELEGRAM=1 / MARS_GATEWAY_DISCORD=1) and a token exists.
 * Owner sender ids from MARS_TELEGRAM_OWNER / MARS_DISCORD_OWNER are allowed while they are
 * set: they are never stored, so removing one and restarting stops it.
 */
export async function startGateway({ harness, conversations, context, env = process.env, discordToken, log = console.error, ready, workersOf }) {
  const gateway = createGateway({ harness, conversations, context, log, ready, workersOf });
  const api = createApiAdapter({ store: { harness, context } });
  const configured = [];
  gateway.addAdapter(api);
  gateway.setOwners('api', ['owner']);
  if (env.MARS_GATEWAY_TELEGRAM === '1' && env.MARS_TELEGRAM_TOKEN) {
    gateway.addAdapter(createTelegramAdapter({ token: env.MARS_TELEGRAM_TOKEN, ...(env.MARS_TELEGRAM_API ? { baseUrl: env.MARS_TELEGRAM_API } : {}) }));
    configured.push('telegram');
  }
  if (env.MARS_GATEWAY_DISCORD === '1' && (env.MARS_DISCORD_TOKEN || discordToken)) {
    gateway.addAdapter(createDiscordAdapter({ token: env.MARS_DISCORD_TOKEN || discordToken, messageContent: env.MARS_DISCORD_MESSAGE_CONTENT === '1', ...(env.MARS_DISCORD_API ? { apiUrl: env.MARS_DISCORD_API } : {}) }));
    configured.push('discord');
  }
  for (const [channel, ids] of [['telegram', env.MARS_TELEGRAM_OWNER], ['discord', env.MARS_DISCORD_OWNER]])
    gateway.setOwners(channel, String(ids ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  await gateway.resume();
  const available = { telegram: configured.includes('telegram'), discord: configured.includes('discord') };
  return { gateway, api, available };
}

/** Owner-authenticated /api/gateway routes. Returns true when it handled the request. */
export async function gatewayRoute({ req, url, res, send, jsonBody, gateway, api, available }) {
  if (!url.pathname.startsWith('/api/gateway')) return false;
  if (url.pathname === '/api/gateway' && req.method === 'GET') {
    send(res, 200, { ...(await gateway.status()), available: { api: true, ...available } });
    return true;
  }
  if (url.pathname === '/api/gateway/pairings' && req.method === 'POST') {
    const { code, approve } = await jsonBody(req);
    if (typeof code !== 'string' || typeof approve !== 'boolean') throw Object.assign(Error('Send { code, approve }'), { status: 400 });
    send(res, 200, await gateway.decidePairing(code, approve));
    return true;
  }
  if (url.pathname === '/api/gateway/bindings/delete' && req.method === 'POST') {
    const { route } = await jsonBody(req);
    if (typeof route !== 'string' || !route) throw Object.assign(Error('Send { route }'), { status: 400 });
    await gateway.unbind(route);
    send(res, 200, { unbound: route });
    return true;
  }
  if (url.pathname === '/api/gateway/allow/delete' && req.method === 'POST') {
    const { channel, sender } = await jsonBody(req);
    if (typeof channel !== 'string' || !channel || typeof sender !== 'string' || !sender) throw Object.assign(Error('Send { channel, sender }'), { status: 400 });
    send(res, 200, await gateway.disallow(channel, sender));
    return true;
  }
  if (url.pathname === '/api/gateway/api/messages' && req.method === 'POST') {
    send(res, 202, await api.post(await jsonBody(req)));
    return true;
  }
  if (url.pathname === '/api/gateway/api/messages' && req.method === 'GET') {
    send(res, 200, await api.read({ chatId: url.searchParams.get('chatId') ?? '', after: url.searchParams.get('after') ?? 0 }));
    return true;
  }
  send(res, 404, { error: 'Not found' });
  return true;
}

/** Add `channel` to conversation rows that came from a chat platform, for the Recents badge. */
export async function withChannels(harness, context, rows) {
  return Promise.all(rows.map(async (row) => {
    const channel = (await harness.snapshot(ChannelDoc, nativeId(row.id), context))?.channel;
    return channel ? { ...row, channel } : row;
  }));
}

/** Agent tool: is the gateway up, which chats are bound, are pairings waiting. */
export function createGatewayExtension({ gateway }) {
  return defineExtension({
    name: 'mars-gateway',
    marsPlugin: { title: 'Gateway', version: '1.0.0', description: 'Reach Mars conversations from Telegram, Discord and the HTTP API.' },
    tools: [defineTool({
      name: 'gateway_status',
      description: `Show whether the owner can chat with Mars from Telegram, Discord or the HTTP API, and who is waiting for approval.
Use it for any question about chatting with Mars from another app: is the Telegram or Discord bot connected, which conversation a chat continues, is someone waiting to be approved. (discord_connection_status is different: it only covers reading a Discord server's channels.) Read-only. Approving a pairing is for the owner in Settings, Gateway; never approve one yourself. To send a message to a chat, answer in the linked conversation: replies there are delivered to the chat.
Example: const { adapters, bindings, pairings } = await tools.gateway_status({})`,
      parameters: Type.Object({}),
      structuredOutputSchema: Type.Object({
        adapters: Type.Array(Type.Object({
          channel: Type.String({ description: 'Chat app: "api", "telegram" or "discord".' }),
          state: Type.String({ description: '"running", "starting", "failed" or "stopped".' }),
          detail: Type.String({ description: 'Bot name, or why it is not running.' }),
          failures: Type.Integer({ description: 'Times it has crashed and restarted since the host started.' }),
        }), { description: 'Each chat app the host runs.' }),
        bindings: Type.Array(Type.Object({
          route: Type.String({ description: 'The chat, as channel:bot:type:chat.' }),
          channel: Type.String({ description: 'Chat app.' }),
          conversationId: Type.String({ description: 'Conversation this chat continues.' }),
          title: Type.String({ description: 'Its title.' }),
        }), { description: 'Chats linked to conversations.' }),
        pairings: Type.Array(Type.Object({
          code: Type.String({ description: 'Pairing code the sender was given.' }),
          channel: Type.String({ description: 'Chat app.' }),
          sender: Type.String({ description: 'Sender id on that app.' }),
          name: Type.String({ description: 'Sender name, if known.' }),
          expiresAt: Type.String({ description: 'When the code expires (ISO time).' }),
        }), { description: 'Senders waiting for the owner to approve them.' }),
        outbox: Type.Integer({ description: 'Reply chunks still waiting to be sent.' }),
      }, { additionalProperties: true }),
      replay: 'safe',
      deferred: true,
      execute: async () => {
        const { adapters, bindings, pairings, outbox } = await gateway().status();
        return output({ adapters, bindings, pairings, outbox });
      },
    })],
  });
}
