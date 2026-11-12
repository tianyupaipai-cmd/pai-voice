/** PaiVoice file adapter — for setups that cannot type into the agent's terminal.
 *
 * Instead of pasting into tmux, every turn and every call event is appended as one JSON line to an inbox file.
 * The terminal agent watches that file itself (e.g. Claude Code's Monitor on `tail -F inbox.jsonl`) and answers
 * with the same `pai-voice-reply --turn-id … --text …` helper as the tmux adapter (it POSTs to /reply here).
 * Trade-off: no permission to drive the terminal is needed, but the watcher is the agent's own job — if it
 * stops watching (some tools expire a background watch after a while), the call goes unheard until it re-arms.
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.env.PAIVOICE_FILE_PORT || 8791);
const inbox = process.env.PAIVOICE_INBOX || '/tmp/pai-voice-inbox.jsonl';
const token = process.env.PAIVOICE_ADAPTER_TOKEN || '';
const pending = new Map();

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const allowed = (req) => !token || req.headers.authorization === `Bearer ${token}`;
const read = (req) => new Promise((ok, no) => { let b = ''; req.on('data', (p) => { b += p; }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } }); });
const write = (record) => appendFileSync(inbox, JSON.stringify({ ts: Date.now(), ...record }) + '\n');

createServer(async (req, res) => {
  if (!allowed(req)) return json(res, 401, { error: 'Unauthorized' });
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, inbox, pending: pending.size });
  try {
    const body = await read(req);
    if (req.method === 'POST' && req.url === '/turn') {
      const turnId = String(body.turn_id || ''); const transcript = String(body.transcript || '').trim();
      if (!turnId || !transcript) return json(res, 400, { error: 'turn_id and transcript are required' });
      write({ type: 'turn', turn_id: turnId, transcript, ...(body.observation ? { observation: body.observation } : {}),
        reply_with: `pai-voice-reply --turn-id ${turnId} --text "<your reply>"` });
      const reply = await new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(turnId); reject(new Error('terminal reply timeout')); }, 120000);
        pending.set(turnId, { resolve: (v) => { clearTimeout(t); resolve(v); } });
      });
      return json(res, 200, { reply });
    }
    if (req.method === 'POST' && req.url === '/event') { write(body); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && req.url === '/reply') {
      const turnId = String(body.turn_id || ''); const item = pending.get(turnId);
      if (!item) return json(res, 404, { error: 'no pending turn' });
      pending.delete(turnId); item.resolve(String(body.reply || '').trim());
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) { return json(res, 500, { error: error.message }); }
}).listen(port, '127.0.0.1', () => console.log(`PaiVoice file adapter on http://127.0.0.1:${port} → ${inbox}`));
