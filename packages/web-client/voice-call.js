/* 实时语音/视频通话 · 浏览器端（无依赖 ES module）
 *
 * 一条媒体流三种用途：分析流（VAD）、识别流（推给后端转写）、——原声不归档（隐私：音频不落盘）。
 * 即使机在说话，麦克风也继续听：用户一开口就 interrupt，机立刻停。
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

const MIC_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

export class VoiceCall {
  constructor({ url, video = false, on = {}, vad = {} } = {}) {
    this.url = url;
    this.wantVideo = video;
    this.on = on;
    this.vad = Object.assign({
      startHold: 3,        // 连续几块（~20ms/块）超阈值算开口
      endSilenceMs: 650,   // 静音多久算说完
      bargeInMs: 820,      // 正在播放正式回复时，持续开口多久才打断（防回声/误触；呼吸是短促的，真说话能撑过 0.8s）
      floor: 0.006,        // 最低噪声底
      gain: 3.2,           // 进入阈值 = max(floor, 噪声底 * gain)
      exitRatio: 0.62,     // 结束阈值 = 进入阈值 * 这个（双阈值，防止悬在临界卡住）
      speakingGain: 3.3,   // 机说话时再提高门槛，降低扬声器/呼吸误触
      watchdogMs: 1600,    // 这么久没有一块声音超过进入阈值 → 强制收尾（AGC 把环境音抬高也不会卡）
    }, vad);

    this.ws = null; this.ctx = null; this.stream = null; this.node = null; this.muted = false;
    this.mode = 'idle';      // idle | listening | thinking | speaking
    this.speaking = false;   // 用户在说
    this.playing = false;    // 机在说（扬声器）
    this.noise = 0.01; this._hot = 0; this._silenceSince = 0; this._hotSince = 0; this._lastHotAt = 0; this._speechMin = 1;
    this.generationId = null;
    this._queue = []; this._pending = new Map(); this._sources = []; this._playhead = 0;
    this.video = null; this._frameTimer = null; this.canvas = null;
    this.videoMode = 'live';   // live 每 5 秒一帧 / companion 陪伴模式每 20 秒一帧，核心只在离开/回来/小动作/太久没动静时通知回复端
    this.facing = 'user';          // 前置 user / 后置 environment
    this.callSessionId = null; this.stats = { turns: 0, firstAudioMs: null };
    this._turnSentAt = 0;
  }

  emit(ev, ...a) { try { this.on[ev] && this.on[ev](...a); } catch (e) { console.error(e); } }

  // ------------------------------------------------------------ 开始
  async start() {
    try {
      await this._start();
    } catch (e) {
      this._releaseMedia();          // 麦克风已经拿到、后面接不通：必须放掉，别让指示灯一直亮
      throw e;
    }
  }

  async _start() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    await this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: MIC_CONSTRAINTS,
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
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.node.port.onmessage = (e) => this._onCapture(e.data);
    this._attachMic(this.stream.getAudioTracks()[0]);
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
    if (this.video) this._startFrames();
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => reject(new Error('连不上通话服务'));
      ws.onclose = (e) => {
        this.ws = null;
        const wasLive = this.mode !== 'idle';
        this._releaseMedia();        // 连接没了就没有通话了：麦克风、摄像头、音频上下文一起关
        if (wasLive) { this._setMode('idle'); this.emit('closed', e); }
      };
      ws.onmessage = (e) => this._onMessage(e.data);
    });
  }

  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  _setMode(m) { if (this.mode !== m) { this.mode = m; this.emit('state', m); } }

  // ------------------------------------------------------------ 听（Listen 轨 + VAD）
  _onCapture({ pcm, rms }) {
    if (this.muted) { this.emit('level', 0); return; }
    if (pcm && this.ws && this.ws.readyState === 1) this.ws.send(pcm);   // 二进制 PCM16
    if (rms === undefined) return;
    this.emit('level', rms);

    const now = performance.now();
    // 噪声底：用户没说话时快跟；说话中也慢慢向观测到的最小值靠（AGC 抬底噪时不至于卡死）
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

  // ------------------------------------------------------------ 看（通话中随时开/关/翻转，和语音并行）
  /** 打开摄像头（走系统原生权限弹窗）。facing: 'user' 前置 / 'environment' 后置。必须在用户手势里调。 */
  async enableVideo(facing = this.facing) {
    if (!this.stream || !this.ctx) throw new Error('还没接通');
    let fresh;
    try {
      // iOS 对 ideal 常常不理，先 exact 强制指定前/后摄；没有那一路（比如电脑）再退回 ideal
      fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 640 }, height: { ideal: 480 } } });
    } catch (e) {
      if (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError') {
        fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } } });
      } else throw e;
    }
    const track = fresh.getVideoTracks()[0];
    if (!track) throw new Error('没拿到摄像头');
    this._stopVideoTracks();
    this.stream.addTrack(track);
    this.facing = facing;
    if (!this.video) {
      this.video = document.createElement('video');
      this.video.muted = true; this.video.playsInline = true; this.video.autoplay = true;
    }
    this.video.srcObject = new MediaStream([track]);
    await this.video.play().catch(() => {});
    this.wantVideo = true;
    this._startFrames();
    this._send({ type: 'video', on: true });
    if (this.videoMode !== 'live') this._send({ type: 'video_mode', mode: this.videoMode });
    this.emit('video', this.video);
    return this.video;
  }

  /** 关摄像头：停轨（指示灯灭）、停抽帧、告诉服务端。 */
  disableVideo() {
    this._stopVideoTracks();
    if (this._frameTimer) { clearInterval(this._frameTimer); this._frameTimer = null; }
    if (this.video) { try { this.video.pause(); this.video.srcObject = null; } catch { /* ignore */ } }
    this.wantVideo = false;
    this._send({ type: 'video', on: false });
    this.emit('video', null);
  }

  _startFrames() {
    if (this._frameTimer) clearInterval(this._frameTimer);
    this._frameTimer = setInterval(() => this._pushFrame(), this.videoMode === 'companion' ? 20000 : 5000);
  }

  /** 实时 / 陪伴 两种模式，通话中随时切，不用重开摄像头。 */
  setVideoMode(mode) {
    this.videoMode = mode === 'companion' ? 'companion' : 'live';
    if (this._frameTimer) this._startFrames();
    this._send({ type: 'video_mode', mode: this.videoMode });
    this.emit('videoMode', this.videoMode);
  }

  async flipCamera() {
    return this.enableVideo(this.facing === 'user' ? 'environment' : 'user');
  }

  _stopVideoTracks() {
    if (!this.stream) return;
    this.stream.getVideoTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } this.stream.removeTrack(t); });
  }

  /** 静音 = 真把音轨停掉（iOS 的麦克风指示灯只认这个）；取消静音时重新拿一次麦克风接回 worklet。 */
  async setMuted(yes) {
    this.muted = Boolean(yes);
    if (!this.stream) return;
    if (this.muted) {
      this.stream.getAudioTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } this.stream.removeTrack(t); });
      if (this._micSrc) { try { this._micSrc.disconnect(); } catch { /* ignore */ } this._micSrc = null; }
      return;
    }
    if (this.stream.getAudioTracks().some((t) => t.readyState === 'live')) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
      const track = fresh.getAudioTracks()[0];
      if (this.muted || !this.stream || !this.ctx) { track.stop(); return; }   // 等待期间又静音/挂断了
      this.stream.addTrack(track);
      this._attachMic(track);
    } catch (e) {
      this.emit('error', '麦克风没拿回来：' + (e.message || e));
    }
  }

  _attachMic(track) {
    if (!track || !this.ctx || !this.node) return;
    if (this._micSrc) { try { this._micSrc.disconnect(); } catch { /* ignore */ } }
    this._micSrc = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this._micSrc.connect(this.node);
  }

  /** 放掉所有本地媒体：麦克风、摄像头、音频上下文、抽帧定时器。挂断 / 连接关闭 / 接通失败共用。 */
  _releaseMedia() {
    if (this._frameTimer) { clearInterval(this._frameTimer); this._frameTimer = null; }
    if (this._micSrc) { try { this._micSrc.disconnect(); } catch { /* ignore */ } this._micSrc = null; }
    if (this.node) { try { this.node.disconnect(); } catch { /* ignore */ } }
    if (this.stream) this.stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
    if (this.video) { try { this.video.pause(); this.video.srcObject = null; } catch { /* ignore */ } }
    if (this.ctx) { this.ctx.close().catch(() => {}); }
    this.stream = null; this.node = null; this.video = null; this.ctx = null;
  }

  _speechStart() {
    this.speaking = true; this._speechMin = 1; this._lastHotAt = performance.now(); this._silenceSince = 0;
    this.emit('speech', true);
    // 只在听得到正式回复时打断；思考中、短提示音或误触都让机继续准备。
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
      case 'observation': this.emit('observation', msg); break;   // 机看到的画面描述：前端可选择显示或只留事件
      case 'video': this.emit('videoState', msg); break;
      case 'video_mode': this.emit('videoMode', msg.mode); break;
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
    if (!this.ctx) return;               // 已经挂断/释放：迟到的音频块直接丢
    let audio;
    try { audio = await this.ctx.decodeAudioData(buf.slice(0)); } catch (e) { console.warn('解码失败', e); return; }
    if (!this.ctx) return;
    if (!isAck && genId !== this.generationId) return;
    this._queue.push({ audio, genId, isAck });
    this._drain();
  }

  _drain() {
    if (!this.ctx) { this._queue.length = 0; return; }
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
    this._releaseMedia();
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.ws = null;
    this._setMode('idle');
  }
}

export default VoiceCall;
