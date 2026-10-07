#!/usr/bin/env node
/** Send one completed CLI reply back to the local PaiVoice tmux adapter.
 * Install as `pai-voice-reply` on the same machine as the tmux session.
 */
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : ''; };
const turnId = value('--turn-id');
const text = value('--text');
const base = process.env.PAIVOICE_TMUX_ADAPTER_URL || 'http://127.0.0.1:8791';
const token = process.env.PAIVOICE_ADAPTER_TOKEN || '';

if (!turnId || !text) {
  console.error('Usage: pai-voice-reply --turn-id <id> --text <reply>');
  process.exit(2);
}
const response = await fetch(base.replace(/\/$/, '') + '/reply', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ turn_id: turnId, reply: text }),
});
if (!response.ok) {
  console.error(`PaiVoice reply failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}
