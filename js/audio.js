/*
 * audio.js — 마이크 원시 PCM(Float32) 수집
 *
 * AudioWorklet 로 입력 샘플을 메인 스레드로 전달받아 지정 시간(초)만큼
 * 누적한다. AGC/노이즈억제/에코제거는 모두 끄고(측정 정확도),
 * 채널 1개(mono)로 캡처한다.
 *
 * 사용:
 *   const rec = new NoiseRecorder();
 *   await rec.init();                       // 마이크 권한 요청
 *   const { samples, sampleRate } = await rec.record(10, onProgress);
 *   rec.close();
 */

'use strict';

// AudioWorklet 프로세서 소스 (Blob URL 로 로드 → 외부 파일 불필요)
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // 입력 프레임을 복사해서 메인 스레드로 전달
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

class NoiseRecorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sampleRate = 0;
    this._chunks = [];
    this._collecting = false;
  }

  // desiredRate: 숫자면 해당 샘플레이트 요청, 아니면 기기 기본
  async init(desiredRate) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('이 브라우저는 마이크 입력을 지원하지 않습니다.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      },
      video: false
    });

    const AC = window.AudioContext || window.webkitAudioContext;
    const rate = (desiredRate && !isNaN(desiredRate)) ? +desiredRate : null;
    try {
      this.ctx = rate ? new AC({ sampleRate: rate }) : new AC();
    } catch (e) {
      this.ctx = new AC(); // 지원 안 하면 기본값으로
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;

    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor');
    this.node.port.onmessage = (e) => {
      if (this._collecting) this._chunks.push(e.data);
    };
    this.source.connect(this.node);
    // 출력으로 보내지 않기 위해 이득 0 로 연결(일부 브라우저는 sink 필요)
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
  }

  /**
   * durationSec 동안 수집. onProgress(0~1) 콜백 호출.
   * 반환: { samples: Float32Array, sampleRate }
   */
  record(durationSec, onProgress) {
    return new Promise((resolve) => {
      this._chunks = [];
      this._collecting = true;
      const start = performance.now();
      const total = durationSec * 1000;

      const tick = () => {
        const elapsed = performance.now() - start;
        if (onProgress) onProgress(Math.min(1, elapsed / total));
        if (elapsed >= total) {
          this._collecting = false;
          resolve({ samples: this._merge(), sampleRate: this.sampleRate });
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  _merge() {
    let len = 0;
    for (const c of this._chunks) len += c.length;
    const out = new Float32Array(len);
    let off = 0;
    for (const c of this._chunks) { out.set(c, off); off += c.length; }
    this._chunks = [];
    return out;
  }

  close() {
    try { if (this.source) this.source.disconnect(); } catch (e) {}
    try { if (this.node) this.node.disconnect(); } catch (e) {}
    try { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { if (this.ctx) this.ctx.close(); } catch (e) {}
    this.ctx = this.stream = this.source = this.node = null;
  }
}

window.NoiseRecorder = NoiseRecorder;
