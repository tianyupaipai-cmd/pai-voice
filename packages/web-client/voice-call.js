/* 实时语音/视频通话 · 浏览器端（无依赖 ES module）
 *
 * 一条媒体流三种用途：分析流（VAD）、识别流（推给后端转写）、——原声不归档（隐私：音频不落盘）。
 * 即使机在说话，麦克风也继续听：她一开口就 interrupt，他立刻停。
 *
 * 用法：
 *   const call = new VoiceCall({ url: 'wss://your-pai-voice.example/voice/ws', video: false, on: {...} });
 *   await call.start();   // 必须在用户点击里调用（iOS 需要手势解锁 AudioContext）
 *   call.hangup();
 */

const WORKLET_SRC = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.len = 0; this.acc = 0; this.ratio = sampleRate / 16000; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // 线性抽样到 16k（AEC/NS 已在 getUserMedia 做过）
    const out = [];
    for (let i = 0; i < ch.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) { this.acc -= this.ratio; out.push(ch[i]); }
    }
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    const i16 = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) { const v = Math.max(-1, Math.min(1, out[i])); i16[i] = v < 0 ? v * 32768 : v * 32767; }
    this.buf.push(i16); this.len += i16.length;
    if (this.len >= 1024) {                       // ~64ms @16k
      const all = new Int16Array(this.len); let o = 0;
      for (const b of this.buf) { all.set(b, o); o += b.length; }
      this.buf = []; this.len = 0;
      this.port.postMessage({ pcm: all.buffer, rms }, [all.buffer]);
    } else {
      this.port.postMessage({ rms });
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export class VoiceCall {
  constructor({ url, video = false, on = {}, vad = {} } = {}) {
    this.url = url;
    this.wantVideo = video;
    this.on = on;
    this.vad = Object.assign({
      startHold: 3,        // 连续几块（~20ms/块）超阈值算开口
      endSilenceMs: 650,   // 静音多久算说完
      bargeInMs: 560,      // 正在播放正式回复时，持续开口多久才打断（防回声/误触）
      floor: 0.006,        // 最低噪声底
      gain: 3.2,           // 进入阈值 = max(floor, 噪声底 * gain)
      exitRatio: 0.62,     // 结束阈值 = 进入阈值 * 这个（双阈值，防止悬在临界卡住）
      speakingGain: 2.8,   // 机说话时再提高门槛，降低扬声器误触
      watchdogMs: 1600,    // 这么久没有一块声音超过进入阈值 → 强制收尾（AGC 把环境音抬高也不会卡）
    }, vad);

    this.ws = null; this.ctx = null; this.stream = null; this.node = null;
    this.mode = 'idle';      // idle | listening | thinking | speaking
    this.speaking = false;   // 她在说
    this.playing = false;    // 他在说（扬声器）
    this.noise = 0.01; this._hot = 0; this._silenceSince = 0; this._hotSince = 0; this._lastHotAt = 0; this._speechMin = 1;
    this.generationId = null;
    this._queue = []; this._pending = new Map(); this._sources = []; this._playhead = 0;
    this.video = null; this._frameTimer = null; this.canvas = null;
    this.callSessionId = null; this.stats = { turns: 0, firstAudioMs: null };
    this._turnSentAt = 0;
  }

  emit(ev, ...a) { try { this.on[ev] && this.on[ev](...a); } catch (e) { console.error(e); } }

  // ------------------------------------------------------------ 开始
  async start() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    await this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: this.wantVideo ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
    });
    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.outGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.outGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this._ampBuf = new Uint8Array(this.analyser.fftSize);
    const ampLoop = () => {
      if (!this.ctx || this.ctx.state === 'closed') return;
      if (this.playing && this.analyser) {
        this.analyser.getByteTimeDomainData(this._ampBuf);
        let sum = 0;
        for (let i = 0; i < this._ampBuf.length; i++) { const v = (this._ampBuf[i] - 128) / 128; sum += v * v; }
        this.emit('himLevel', Math.sqrt(sum / this._ampBuf.length));
      }
      requestAnimationFrame(ampLoop);
    };
    requestAnimationFrame(ampLoop);
    const src = this.ctx.createMediaStreamSource(new MediaStream([this.stream.getAudioTracks()[0]]));
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.node.port.onmessage = (e) => this._onCapture(e.data);
    src.connect(this.node);
    // worklet 不接到 destination，避免自己听见自己

    if (this.wantVideo && this.stream.getVideoTracks().length) {
      this.video = document.createElement('video');
      this.video.muted = true; this.video.playsInline = true; this.video.autoplay = true;
      this.video.srcObject = new MediaStream([this.stream.getVideoTracks()[0]]);
      await this.video.play().catch(() => {});
      this.emit('video', this.video);
    }

    await this._connect();
    this._send({ type: 'start', video: this.wantVideo, sample_rate: 16000 });
    this._setMode('listening');
    if (this.video) this._frameTimer = setInterval(() => this._pushFrame(), 5000);
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => reject(new Error('连不上通话服务'));
      ws.onclose = (e) => { this.ws = null; if (this.mode !== 'idle') { this._setMode('idle'); this.emit('closed', e); } };
      ws.onmessage = (e) => this._onMessage(e.data);
    });
  }

  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  _setMode(m) { if (this.mode !== m) { this.mode = m; this.emit('state', m); } }

  // ------------------------------------------------------------ 听（Listen 轨 + VAD）
  _onCapture({ pcm, rms }) {
    if (pcm && this.ws && this.ws.readyState === 1) this.ws.send(pcm);   // 二进制 PCM16
    if (rms === undefined) return;
    this.emit('level', rms);

    const now = performance.now();
    // 噪声底：她没说话时快跟；说话中也慢慢向观测到的最小值靠（AGC 抬底噪时不至于卡死）
    if (!this.speaking) this.noise = this.noise * 0.97 + rms * 0.03;
    else { this._speechMin = Math.min(this._speechMin, rms); this.noise = Math.min(this.noise * 1.0015, Math.max(this.noise, this._speechMin)); }
    let enter = Math.max(this.vad.floor, this.noise * this.vad.gain);
    if (this.playing) enter *= this.vad.speakingGain;
    const exit = enter * this.vad.exitRatio;

    if (rms > enter) this._lastHotAt = now;

    if (!this.speaking) {
      if (rms > enter) {
        this._hot += 1;
        if (!this._hotSince) this._hotSince = now;
        if (this._hot >= this.vad.startHold) {
          const needed = (this.playing && this.mode === 'speaking') ? this.vad.bargeInMs : 0;
          if (now - this._hotSince >= needed) this._speechStart();
        }
      } else { this._hot = 0; this._hotSince = 0; }
      return;
    }
    // 说话中：低于结束阈值持续 endSilenceMs → 收尾；或者看门狗——太久没有真正的语音峰值也收尾
    if (rms < exit) {
      if (!this._silenceSince) this._silenceSince = now;
      else if (now - this._silenceSince >= this.vad.endSilenceMs) { this._speechEnd(); return; }
    } else {
      this._silenceSince = 0;
    }
    if (this._lastHotAt && now - this._lastHotAt >= this.vad.watchdogMs) this._speechEnd();
  }

  _speechStart() {
    this.speaking = true; this._speechMin = 1; this._lastHotAt = performance.now(); this._silenceSince = 0;
    this.emit('speech', true);
    // 只在听得到正式回复时打断；思考中、短提示音或误触都让他继续准备。
    const barge = this.playing && this.mode === 'speaking';
    if (barge) {
      this._stopPlayback();
      this._send({ type: 'interrupt', turn_id: 'new' });
    }
    this._send({ type: 'speech_start', barge });
  }

  _speechEnd() {
    this.speaking = false; this._silenceSince = 0;
    this.emit('speech', false);
    this._turnSentAt = performance.now();
    this._send({ type: 'speech_end' });
    this._setMode('thinking');
  }

  /** 不用麦克风也能试：直接发文字 */
  sendText(text) {
    this._stopPlayback();
    this._turnSentAt = performance.now();
    this._send({ type: 'text', text });
    this._setMode('thinking');
  }

  // ------------------------------------------------------------ 收
  async _onMessage(data) {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    switch (msg.type) {
      case 'state':
        if (msg.call_session_id) this.callSessionId = msg.call_session_id;
        if (msg.tts) this.emit('info', msg);
        if (msg.mode) this._setMode(msg.mode === 'speaking' && !this.playing ? 'thinking' : msg.mode);
        break;
      case 'transcript': this.stats.turns += 1; this.emit('transcript', msg); break;
      case 'prosody': this.emit('prosody', msg); break;
      case 'reply_text':
        if (msg.generation_id !== this.generationId) { this.generationId = msg.generation_id; }
        this.emit('reply', msg); break;
      case 'audio': this._onAudio(msg); break;
      case 'audio_sentence_end': this._flushSentence(msg.generation_id); break;
      case 'generation_end': this._flushSentence(msg.generation_id); this._pending.delete(msg.generation_id); break;
      case 'interrupted': this._stopPlayback(); this.emit('interrupted', msg); break;
      case 'nothing_heard': this.emit('nothingHeard', msg); break;
      case 'observation': this.emit('observation', msg); break;
      case 'error': this.emit('error', msg.error); break;
      default: break;
    }
  }

  _onAudio(msg) {
    if (msg.kind === 'ack') {
      if (!this.playing && this._queue.length === 0) this._decodeAndQueue(msg.data, msg.generation_id, true);
      return;
    }
    if (!this.generationId || msg.generation_id >= this.generationId) this.generationId = msg.generation_id;
    if (msg.generation_id !== this.generationId) return;          // 旧轮的丢掉
    const key = msg.generation_id;
    if (!this._pending.has(key)) this._pending.set(key, []);
    this._pending.get(key).push(msg.data);
  }

  _flushSentence(genId) {
    const parts = this._pending.get(genId);
    if (!parts || !parts.length) return;
    this._pending.set(genId, []);
    const bins = parts.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const total = bins.reduce((n, b) => n + b.length, 0);
    const all = new Uint8Array(total); let o = 0;
    for (const b of bins) { all.set(b, o); o += b.length; }
    this._decodeAndQueue(all.buffer, genId, false);
  }

  async _decodeAndQueue(dataOrB64, genId, isAck) {
    let buf = dataOrB64;
    if (typeof dataOrB64 === 'string') buf = Uint8Array.from(atob(dataOrB64), (c) => c.charCodeAt(0)).buffer;
    let audio;
    try { audio = await this.ctx.decodeAudioData(buf.slice(0)); } catch (e) { console.warn('解码失败', e); return; }
    if (!isAck && genId !== this.generationId) return;
    this._queue.push({ audio, genId, isAck });
    this._drain();
  }

  _drain() {
    const now = this.ctx.currentTime;
    if (this._playhead < now) this._playhead = now + 0.02;
    while (this._queue.length) {
      const { audio, genId } = this._queue.shift();
      const src = this.ctx.createBufferSource();
      src.buffer = audio; src.connect(this.outGain || this.ctx.destination);
      src.start(this._playhead);
      this._playhead += audio.duration;
      this._sources.push(src);
      src.onended = () => {
        this._sources = this._sources.filter((s) => s !== src);
        if (!this._sources.length) { this.playing = false; this.emit('playing', false); if (this.mode === 'speaking') this._setMode('listening'); }
      };
      if (!this.playing) {
        this.playing = true; this.emit('playing', true);
        if (this._turnSentAt && this.stats.firstAudioMs === null) this.stats.firstAudioMs = Math.round(performance.now() - this._turnSentAt);
        if (this._turnSentAt) { this.emit('latency', Math.round(performance.now() - this._turnSentAt)); this._turnSentAt = 0; }
      }
      if (genId === this.generationId) this._setMode('speaking');
    }
  }

  _stopPlayback() {
    for (const s of this._sources) { try { s.onended = null; s.stop(); } catch { /* ignore */ } }
    this._sources = []; this._queue = []; this._pending.clear();
    this._playhead = 0;
    if (this.playing) { this.playing = false; this.emit('playing', false); }
  }

  // ------------------------------------------------------------ 看（Phase 2）
  _pushFrame() {
    if (!this.video || !this.ws || this.ws.readyState !== 1 || this.video.videoWidth === 0) return;
    if (!this.canvas) this.canvas = document.createElement('canvas');
    const w = 480, h = Math.round(this.video.videoHeight * (w / this.video.videoWidth));
    this.canvas.width = w; this.canvas.height = h;
    this.canvas.getContext('2d').drawImage(this.video, 0, 0, w, h);
    const dataUrl = this.canvas.toDataURL('image/jpeg', 0.6);
    this._send({ type: 'frame', data: dataUrl.split(',')[1], ts: Date.now() });
  }

  // ------------------------------------------------------------ 挂断
  hangup() {
    this._send({ type: 'hangup' });
    this._stopPlayback();
    if (this._frameTimer) clearInterval(this._frameTimer);
    if (this.node) { try { this.node.disconnect(); } catch { /* ignore */ } }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.ws = null; this.stream = null; this.node = null; this.video = null;
    this._setMode('idle');
  }
}

export default VoiceCall;
