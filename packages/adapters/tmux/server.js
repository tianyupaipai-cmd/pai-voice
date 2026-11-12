/** PaiVoice adapter for a user-controlled tmux terminal.
 *
 * This process receives a transcript, inserts it into a named tmux pane, then
 * waits for a companion hook or helper to POST the reply. It never assumes a
 * particular vendor CLI; the user explicitly controls the terminal command.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const port = Number(process.env.PAIVOICE_TMUX_PORT || 8791);
const session = process.env.PAIVOICE_TMUX_SESSION || 'pai-voice';
const token = process.env.PAIVOICE_ADAPTER_TOKEN || '';
const pending = new Map();

// Non-turn events from the realtime core (call start / dropped / resumed / end, camera, screen…).
// Every one of them is pasted into the terminal as a single line, so the agent always knows the call state.
function eventLine(e) {
  const id = e.call_session_id ? ` ${String(e.call_session_id).slice(0, 8)}` : '';
  switch (e.type) {
    case 'call_start': return `[PaiVoice${id}] Incoming call connected. Each sentence will arrive as "[PaiVoice call turn: …]"; reply with pai-voice-reply.`;
    case 'call_dropped': return `[PaiVoice${id}] The line dropped. If they reconnect within ${Math.round(Number(e.resume_s) || 60)}s it is the same call; otherwise a call_end follows.`;
    case 'call_resumed': return `[PaiVoice${id}] They reconnected after ${Number(e.gap_s) || 0}s — same call, carry on.`;
    case 'call_end': return `[PaiVoice${id}] Call ended (${e.reason || 'hangup'}).`;
    case 'camera': return `[PaiVoice${id}] Camera ${e.on ? 'on' : 'off'}${e.source ? ` (${e.source})` : ''}.`;
    default: return e.text ? `[PaiVoice${id} · ${e.type || 'event'}] ${String(e.text).slice(0, 1200)}` : null;
  }
}

function tmux(...args) { return spawnSync('tmux', args, { encoding: 'utf8', timeout: 5000 }); }
function json(response, code, body) { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }
function allowed(request) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}
function read(request) {
  return new Promise((resolve, reject) => { let body = ''; request.on('data', (part) => { body += part; }); request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } }); });
}
function inject(text) {
  if (tmux('has-session', '-t', session).status !== 0) throw new Error(`tmux session ${session} is not running`);
  const loaded = spawnSync('tmux', ['load-buffer', '-b', 'pai-voice', '-'], { input: text, encoding: 'utf8', timeout: 5000 });
  if (loaded.status !== 0) throw new Error('tmux load-buffer failed');
  if (tmux('paste-buffer', '-p', '-b', 'pai-voice', '-d', '-t', session).status !== 0) throw new Error('tmux paste-buffer failed');
  setTimeout(() => tmux('send-keys', '-t', session, 'Enter'), 250);
}

createServer(async (request, response) => {
  if (!allowed(request)) return json(response, 401, { error: 'Unauthorized' });
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true, session, pending: pending.size });
  try {
    const body = await read(request);
    if (request.method === 'POST' && request.url === '/turn') {
      const turnId = String(body.turn_id || '');
      const transcript = String(body.transcript || '').trim();
      if (!turnId || !transcript) return json(response, 400, { error: 'turn_id and transcript are required' });
      const callback = `pai-voice-reply --turn-id ${turnId} --text "<your final reply>"`;
      inject(`[PaiVoice call turn: ${turnId}]\n${transcript}\n\nWhen you have finished your reply, call:\n${callback}`);
      const reply = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(turnId); reject(new Error('terminal reply timeout')); }, 120000);
        pending.set(turnId, { resolve: (value) => { clearTimeout(timeout); resolve(value); } });
      });
      return json(response, 200, { reply });
    }
    if (request.method === 'POST' && request.url === '/event') {
      const line = eventLine(body);
      if (line) inject(line);
      return json(response, 200, { ok: true, injected: Boolean(line) });
    }
    if (request.method === 'POST' && request.url === '/reply') {
      const turnId = String(body.turn_id || ''); const item = pending.get(turnId);
      if (!item) return json(response, 404, { error: 'no pending turn' });
      pending.delete(turnId); item.resolve(String(body.reply || '').trim());
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: 'not found' });
  } catch (error) { return json(response, 500, { error: error.message }); }
}).listen(port, '127.0.0.1', () => console.log(`PaiVoice tmux adapter on http://127.0.0.1:${port}`));
