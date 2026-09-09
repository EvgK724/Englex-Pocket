// MP3 playback stays inside the click handler to preserve mobile user activation.
// Each request owns its media element, so late events cannot affect a newer card.
export class RecordedSpeech {
  constructor(createAudio = () => new Audio(), clock = globalThis) {
    this.createAudio = createAudio;
    this.clock = clock;
    this.job = null;
  }
  stop() {
    const job = this.job;
    if (!job) return;
    this.job = null;
    this.clock.clearTimeout(job.timer);
    job.audio.onplaying = job.audio.onended = job.audio.onerror = null;
    try { job.audio.pause(); job.audio.removeAttribute('src'); job.audio.load(); } catch {}
    job.onFinish();
  }
  play(src, {rate = .9, onStart = () => {}, onFinish = () => {}, onError = () => {}} = {}) {
    this.stop();
    const audio = this.createAudio();
    const job = {audio, onFinish, timer: null};
    this.job = job;
    const fail = error => {
      if (this.job !== job) return;
      this.stop();
      onError(error);
    };
    audio.preload = 'auto';
    audio.src = src;
    audio.playbackRate = Math.min(1.15, Math.max(.65, rate));
    audio.preservesPitch = true;
    if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
    audio.onplaying = () => {
      if (this.job !== job) return;
      this.clock.clearTimeout(job.timer);
      job.timer = this.clock.setTimeout(() => fail(new Error('Playback stalled')),
        Math.max(15000, (Number.isFinite(audio.duration) ? audio.duration : 15) * 1000 / audio.playbackRate + 8000));
      onStart();
    };
    audio.onended = () => { if (this.job === job) this.stop(); };
    audio.onerror = () => fail(new Error('Recording unavailable'));
    job.timer = this.clock.setTimeout(() => fail(new Error('Recording load timed out')), 12000);
    try {
      const started = audio.play();
      if (started && typeof started.catch === 'function') started.catch(fail);
    } catch (error) { fail(error); }
  }
}
