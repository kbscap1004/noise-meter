/*
 * dsp.js — 순수 JS 신호처리 모듈 (외부 라이브러리 없음)
 *
 * 제공 기능
 *  - fft(re, im)                : in-place radix-2 Cooley-Tukey FFT
 *  - hanningWindow(N)           : Hanning(Hann) 창함수
 *  - aWeightGain(f)             : IEC 61672 A-weighting 선형 이득
 *  - autopower(sig, fs, N, ov)  : Welch 평균 오토파워(단측, RMS² 보존)
 *  - bandLevel(gxx, df, lo, hi) : 대역 파워/레벨(dB) 계산
 *  - thirdOctaveBands(...)      : 1/3 옥타브 대역 레벨
 *  - speedOfSound(tempC)        : 온도별 음속(m/s)
 *
 * 레벨 정의: L = 10*log10( Σ Gxx ) + offset  [dB 또는 dB(A)]
 *   Gxx[k] 는 bin k 의 평균제곱(RMS²) 기여도이므로, 임의 대역의 합은
 *   그 대역의 mean-square 이고 sqrt 하면 RMS 가 된다. (Parseval 기반)
 */

'use strict';

/* ---------------- FFT (radix-2, in-place) ---------------- */
function fft(re, im) {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = i + k + half;
        const xr = re[b] * cwr - im[b] * cwi;
        const xi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr;        im[a] += xi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = ncwr;
      }
    }
  }
}

/* ---------------- 창함수 ---------------- */
function hanningWindow(N) {
  const w = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
  }
  return w;
}

/* ---------------- A-weighting (IEC 61672) ---------------- */
function aWeightGain(f) {
  if (f <= 0) return 0;
  const f2 = f * f;
  const c20 = 20.598997 * 20.598997;
  const c107 = 107.65265 * 107.65265;
  const c737 = 737.86223 * 737.86223;
  const c122 = 12194.217 * 12194.217;
  const ra = (c122 * f2 * f2) /
    ((f2 + c20) * Math.sqrt((f2 + c107) * (f2 + c737)) * (f2 + c122));
  const aDb = 20 * Math.log10(ra) + 2.00;
  return Math.pow(10, aDb / 20); // 선형 진폭 이득
}

/* ---------------- Welch 오토파워 ----------------
 * 반환: { gxx: Float64Array(N/2+1), df }
 *   gxx[k] = bin k 의 평균제곱(RMS²) 기여도 (단측, 창 파워 보정 완료)
 *   overlap: 0~0.9 (기본 0.5)
 */
function autopower(signal, fs, N, overlap) {
  overlap = (overlap == null) ? 0.5 : overlap;
  const hop = Math.max(1, Math.floor(N * (1 - overlap)));
  const w = hanningWindow(N);
  let sumW2 = 0;
  for (let i = 0; i < N; i++) sumW2 += w[i] * w[i];

  const half = N >> 1;
  const acc = new Float64Array(half + 1);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let segs = 0;

  for (let start = 0; start + N <= signal.length; start += hop) {
    for (let i = 0; i < N; i++) { re[i] = signal[start + i] * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= half; k++) {
      const mag2 = re[k] * re[k] + im[k] * im[k];
      const scale = (k === 0 || k === half) ? 1 : 2; // 단측 보정
      acc[k] += (scale * mag2) / (N * sumW2);        // 창 파워 정규화 → RMS² 보존
    }
    segs++;
  }
  if (segs > 0) for (let k = 0; k <= half; k++) acc[k] /= segs;
  return { gxx: acc, df: fs / N, segments: segs };
}

/* ---------------- 대역 레벨 ----------------
 * weightFn: null(선형/Z) 또는 aWeightGain
 * 반환: { power, rms, level }  level = 10log10(power)+offset
 */
function bandLevel(gxx, df, fLo, fHi, weightFn, offset) {
  offset = offset || 0;
  let power = 0;
  const kLo = Math.max(1, Math.ceil(fLo / df));
  const kHi = Math.min(gxx.length - 1, Math.floor(fHi / df));
  for (let k = kLo; k <= kHi; k++) {
    const g = weightFn ? Math.pow(weightFn(k * df), 2) : 1;
    power += gxx[k] * g;
  }
  return {
    power,
    rms: Math.sqrt(power),
    level: 10 * Math.log10(power + 1e-30) + offset
  };
}

/* ---------------- 1/3 옥타브 대역 ----------------
 * centers 미지정 시 IEC 선호 중심주파수 사용 (fLo~fHi 범위 내)
 * 반환: [{ fc, fLo, fHi, level }, ...]
 */
const THIRD_OCTAVE_CENTERS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315,
  400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000
];

function thirdOctaveBands(gxx, df, fLo, fHi, weightFn, offset) {
  const lo2 = Math.pow(2, -1 / 6);
  const hi2 = Math.pow(2, 1 / 6);
  const out = [];
  for (const fc of THIRD_OCTAVE_CENTERS) {
    if (fc < fLo || fc > fHi) continue;
    const bl = bandLevel(gxx, df, fc * lo2, fc * hi2, weightFn, offset);
    out.push({ fc, fLo: fc * lo2, fHi: fc * hi2, level: bl.level, power: bl.power });
  }
  return out;
}

/* ---------------- Bluestein 임의 길이 DFT ----------------
 * radix-2 FFT 만으로 임의 N 의 DFT 를 계산(정확한 주파수 분해능 지원).
 * makeBluestein(N) 은 커널을 1회 사전계산하고, powerInto(block,out) 로
 * 매 블록의 |X[k]|² (k=0..N/2) 를 out 에 채운다.
 */
function nextPow2(n) { let m = 1; while (m < n) m <<= 1; return m; }

function makeBluestein(N) {
  const M = nextPow2(2 * N - 1);
  const cosw = new Float64Array(N);
  const sinw = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const ang = Math.PI * ((n * n) % (2 * N)) / N;
    cosw[n] = Math.cos(ang);
    sinw[n] = Math.sin(ang);
  }
  // 커널 B 와 그 FFT(FB) 사전계산
  const Bre = new Float64Array(M);
  const Bim = new Float64Array(M);
  for (let n = 0; n < N; n++) {
    Bre[n] = cosw[n]; Bim[n] = sinw[n];
    if (n > 0) { Bre[M - n] = cosw[n]; Bim[M - n] = sinw[n]; }
  }
  fft(Bre, Bim); // 이후 Bre,Bim 은 FB (읽기전용 재사용)

  const Are = new Float64Array(M);
  const Aim = new Float64Array(M);
  const half = N >> 1;

  return {
    N, M, half,
    // block: Float64Array(N) (창 적용됨) → out[k]=|X[k]|², k=0..half
    powerInto(block, out) {
      Are.fill(0); Aim.fill(0);
      for (let n = 0; n < N; n++) {
        Are[n] = block[n] * cosw[n];
        Aim[n] = -block[n] * sinw[n];
      }
      fft(Are, Aim);
      for (let i = 0; i < M; i++) {          // A * FB
        const xr = Are[i], xi = Aim[i], yr = Bre[i], yi = Bim[i];
        Are[i] = xr * yr - xi * yi;
        Aim[i] = xr * yi + xi * yr;
      }
      for (let i = 0; i < M; i++) Aim[i] = -Aim[i]; // ifft = conj·fft·conj/M
      fft(Are, Aim);
      const invM = 1 / M;
      for (let k = 0; k <= half; k++) {
        const cr = Are[k] * invM, ci = -Aim[k] * invM;   // conv[k]
        const Xr = cosw[k] * cr + sinw[k] * ci;
        const Xi = cosw[k] * ci - sinw[k] * cr;
        out[k] = Xr * Xr + Xi * Xi;
      }
    }
  };
}

/* ---------------- 분해능 기반 Welch 오토파워 ----------------
 * resHz: 주파수 분해능(Hz) → 블록 N=round(fs/resHz), Δf=fs/N
 * overlap: 0~0.95, maxAvg: 최대 평균 횟수
 * 반환: { gxx, df, segments, N }   (gxx[k]=RMS² 기여, 단측)
 */
function autopowerRes(signal, fs, resHz, overlap, maxAvg) {
  const N = Math.round(fs / resHz);
  const hop = Math.max(1, Math.round(N * (1 - overlap)));
  const w = hanningWindow(N);
  let S2 = 0; for (let i = 0; i < N; i++) S2 += w[i] * w[i];
  const half = N >> 1;
  const bs = makeBluestein(N);
  const acc = new Float64Array(half + 1);
  const mag2 = new Float64Array(half + 1);
  const block = new Float64Array(N);
  const nyqUnique = (N % 2 === 0);
  let segs = 0;

  for (let start = 0; start + N <= signal.length && segs < maxAvg; start += hop) {
    for (let i = 0; i < N; i++) block[i] = signal[start + i] * w[i];
    bs.powerInto(block, mag2);
    for (let k = 0; k <= half; k++) {
      const scale = (k === 0) ? 1 : (k === half && nyqUnique) ? 1 : 2;
      acc[k] += scale * mag2[k] / (N * S2);
    }
    segs++;
  }
  if (segs > 0) for (let k = 0; k <= half; k++) acc[k] /= segs;
  return { gxx: acc, df: fs / N, segments: segs, N };
}

/* ---------------- 온도별 음속 ---------------- */
function speedOfSound(tempC) {
  const T = (tempC == null || isNaN(tempC)) ? 20 : tempC;
  return 331.3 * Math.sqrt(1 + T / 273.15); // m/s
}

/* 브라우저 전역으로 노출 */
window.DSP = {
  fft, hanningWindow, aWeightGain, autopower, autopowerRes,
  makeBluestein, nextPow2, bandLevel,
  thirdOctaveBands, speedOfSound, THIRD_OCTAVE_CENTERS
};
