/*
 * app.js — 화면 로직 / 오케스트레이션
 *   - 기상(OpenWeatherMap), GPS 속도, 타이어 Cavity 계산
 *   - 10초 측정 → autopower → Road/Pattern Noise 결과 + 그래프
 */
'use strict';

const $ = (id) => document.getElementById(id);
const LS = window.localStorage;
let deferredInstall = null;  // PWA 설치 프롬프트 보관

/* ================= 설정(로컬 저장) ================= */
const Settings = {
  get apiKey()   { return LS.getItem('owm_key') || ''; },
  set apiKey(v)  { LS.setItem('owm_key', v); },
  get offset()   { return parseFloat(LS.getItem('calib_offset') || '0') || 0; },
  set offset(v)  { LS.setItem('calib_offset', String(v)); },
  // ISO 음압레벨 환산 기준: 디지털 풀스케일(=0 dBFS)에 해당하는 dB SPL
  get fullScaleDb(){ const v = parseFloat(LS.getItem('fullscale_db')); return isNaN(v) ? 120 : v; },
  set fullScaleDb(v){ LS.setItem('fullscale_db', String(v)); },
  // 밴드별 미세보정(dB) — testlab 대비 편차 보정 (기본값=시험 편차)
  get calOverall(){ const v=parseFloat(LS.getItem('cal_overall')); return isNaN(v)? 2.1 : v; },
  set calOverall(v){ LS.setItem('cal_overall', String(v)); },
  get calBooming(){ const v=parseFloat(LS.getItem('cal_booming')); return isNaN(v)? 2.5 : v; },
  set calBooming(v){ LS.setItem('cal_booming', String(v)); },
  get calCavity(){ const v=parseFloat(LS.getItem('cal_cavity')); return isNaN(v)? 3.5 : v; },
  set calCavity(v){ LS.setItem('cal_cavity', String(v)); },
  get calRumble(){ const v=parseFloat(LS.getItem('cal_rumble')); return isNaN(v)? 0.8 : v; },
  set calRumble(v){ LS.setItem('cal_rumble', String(v)); },
  get calPattern(){ const v=parseFloat(LS.getItem('cal_pattern')); return isNaN(v)? -0.4 : v; },
  set calPattern(v){ LS.setItem('cal_pattern', String(v)); },
  get weighting(){ return LS.getItem('weighting') || 'A'; },   // 'A' | 'Z'
  set weighting(v){ LS.setItem('weighting', v); },
  get fftSize()  { return parseInt(LS.getItem('fft_size') || '16384', 10); },
  set fftSize(v) { LS.setItem('fft_size', String(v)); },
  // Cavity 분리 계산용 기준 속도(km/h)
  get refSpeed() { const v = parseFloat(LS.getItem('ref_speed')); return isNaN(v) ? 60 : v; },
  set refSpeed(v){ LS.setItem('ref_speed', String(v)); },
  // GPS 속도로 Cavity 계산 ON/OFF (기본 ON). OFF면 기준속도 사용
  get gpsCavity(){ return LS.getItem('gps_cavity') !== '0'; },
  set gpsCavity(v){ LS.setItem('gps_cavity', v ? '1' : '0'); },
  // 측정 조건
  get resHz()    { const v = parseFloat(LS.getItem('res_hz')); return isNaN(v) ? 2 : v; },
  set resHz(v)   { LS.setItem('res_hz', String(v)); },
  get overlap()  { const v = parseFloat(LS.getItem('overlap')); return isNaN(v) ? 0.75 : v; },
  set overlap(v) { LS.setItem('overlap', String(v)); },
  get averages() { const v = parseInt(LS.getItem('averages'), 10); return isNaN(v) ? 81 : v; },
  set averages(v){ LS.setItem('averages', String(v)); },
  // 샘플레이트: 'auto'(기기 기본) 또는 숫자(요청값)
  get sampleRate() { return LS.getItem('sample_rate') || 'auto'; },
  set sampleRate(v){ LS.setItem('sample_rate', String(v)); },
  // 자동저장
  get autoSave()    { return LS.getItem('auto_save') === '1'; },
  set autoSave(v)   { LS.setItem('auto_save', v ? '1' : '0'); },
  get autoSaveName(){ return LS.getItem('auto_name') || '측정_001'; },
  set autoSaveName(v){ LS.setItem('auto_name', v); },
  get tire()     { return LS.getItem('tire') || '225/45R17'; },
  set tire(v)    { LS.setItem('tire', v); }
};

/* ================= 상태 ================= */
const State = {
  lat: null, lon: null, tempC: null,
  gpsSpeed: null,          // 실시간 GPS 속도(km/h) 또는 null
  measureSpeed: null,      // 측정 시작 순간 고정된 속도(km/h)
  cv1: null, cv2: null, sos: 343.2,
  recorder: null, measuring: false,
  reference: null,         // 1차 측정(레퍼런스) — 고정
  current: null            // 최근 측정 — 갱신
};

/* ================= 타이어 / Cavity 계산 ================= */
// "225/45R17" → {width, aspect, rim}
function parseTire(str) {
  const m = String(str).match(/(\d{2,3})\s*[\/x]\s*(\d{2,3})\s*[rR]?\s*(\d{2}(?:\.\d)?)/);
  if (!m) return null;
  return { width: +m[1], aspect: +m[2], rim: +m[3] };
}

// 타이어 치수 → 휠 중심 원주 L, 회전분리 두 피크(CV1/CV2)
//   CV1 = (c - v)/L ,  CV2 = (c + v)/L
//   c: 음속(m/s), vKmh: GPS속도(km/h), L: 휠 중심 원주(m)
const C_SOUND = 343; // 음속 (m/s)
function cavityFrequencies(tireStr, cMs, vKmh) {
  const t = parseTire(tireStr);
  if (!t) return null;
  const sidewall = t.width * (t.aspect / 100);      // mm
  const rimMm = t.rim * 25.4;                        // mm (림 지름)
  const odMm = rimMm + 2 * sidewall;                // 외경 mm
  const dMean = (rimMm + odMm) / 2;                  // 휠 중심 지름 mm (림+사이드월)
  const L = Math.PI * dMean / 1000;                 // 휠 중심 원주 m
  const v = vKmh / 3.6;                              // m/s
  return {
    L, od: odMm, dMean,
    cv1: (cMs - v) / L,
    cv2: (cMs + v) / L
  };
}

// CV 계산에 쓸 속도: (GPS 계산 ON & 속도 있음)→GPS, 아니면 기준속도(기본 60)
function effectiveRefSpeed() {
  return (Settings.gpsCavity && State.gpsSpeed != null) ? State.gpsSpeed : Settings.refSpeed;
}

function recomputeCavity() {
  const usingGps = (Settings.gpsCavity && State.gpsSpeed != null);
  const vKmh = effectiveRefSpeed();
  const src = usingGps ? 'GPS' : (Settings.gpsCavity ? '기본' : 'GPS OFF');
  const c = cavityFrequencies($('tire-input').value, C_SOUND, vKmh);
  if (!c) { $('cv-note').textContent = '타이어 규격 형식을 확인하세요 (예: 225/45R17)'; return; }
  $('cv-note').innerHTML =
    `휠 중심 원주 L=${c.L.toFixed(3)}m · 외경 ${c.od.toFixed(0)}mm · v=${vKmh.toFixed(1)}km/h(${src})<br>` +
    `CV1=(${C_SOUND}−v)/L = ${c.cv1.toFixed(1)}Hz · CV2=(${C_SOUND}+v)/L = ${c.cv2.toFixed(1)}Hz`;
  // 자동 채움 (GPS 연동 시 속도 변화에 따라 갱신)
  $('cv1-input').value = c.cv1.toFixed(1);
  $('cv2-input').value = c.cv2.toFixed(1);
  syncCV();
}

const CAV_LO_OFF = 8;   // Cavity 하한 = CV1 + 8
const CAV_HI_OFF = 35;  // Cavity 상한 = CV2 + 35

function syncCV() {
  State.cv1 = parseFloat($('cv1-input').value);
  State.cv2 = parseFloat($('cv2-input').value);
  const bLo = State.cv1 + CAV_LO_OFF;   // Booming/Cavity 경계 = CV1+8
  const bHi = State.cv2 + CAV_HI_OFF;   // Cavity/Rumble 경계 = CV2+35
  // Road noise 대역 라벨 갱신
  $('lbl-booming').textContent = `20–${bLo.toFixed(0)}Hz`;
  $('lbl-cavity').textContent  = `${bLo.toFixed(0)}–${bHi.toFixed(0)}Hz`;
  $('lbl-rumble').textContent  = `${bHi.toFixed(0)}–500Hz`;
}

/* ================= GPS ================= */
function startGPS() {
  if (!navigator.geolocation) { $('speed-val').textContent = '미지원'; return; }
  navigator.geolocation.watchPosition((pos) => {
    State.lat = pos.coords.latitude;
    State.lon = pos.coords.longitude;
    const spd = pos.coords.speed; // m/s or null
    if (spd == null || isNaN(spd)) {
      State.gpsSpeed = null;
      $('speed-val').textContent = '--';
    } else {
      State.gpsSpeed = spd * 3.6;         // km/h
      $('speed-val').textContent = State.gpsSpeed.toFixed(1);
    }
    // 측정 중에는 CV를 고정(측정 시작 속도 유지) — 표시만 갱신
    if (!State.measuring) recomputeCavity(); // 속도 변화 → CV1/CV2 자동 갱신
    // 위치 확보 시 날씨 자동 조회(최초 1회)
    if (!State._wxFetched) { State._wxFetched = true; fetchWeather(); }
  }, (err) => {
    State.gpsSpeed = null;
    $('speed-val').textContent = '--';
    $('wx-desc').textContent = 'GPS 권한 필요: ' + err.message;
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
}

/* ================= 날씨 (Open-Meteo, API 키 불필요) ================= */
async function fetchWeather() {
  if (State.lat == null) { $('wx-desc').textContent = 'GPS 위치 확보 중…'; return; }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${State.lat}` +
      `&longitude=${State.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,` +
      `weather_code,wind_speed_10m&timezone=auto`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const c = d.current;
    State.tempC = c.temperature_2m;
    const wc = wmo(c.weather_code);
    $('wx-temp').textContent = c.temperature_2m.toFixed(1) + '℃';
    $('wx-icon').textContent = wc.emoji;
    $('wx-desc').textContent = `${wc.desc} · 습도 ${Math.round(c.relative_humidity_2m)}% · ` +
      `체감 ${c.apparent_temperature.toFixed(0)}℃ · 바람 ${c.wind_speed_10m.toFixed(0)}km/h`;
    $('wx-loc').textContent = `${State.lat.toFixed(3)}, ${State.lon.toFixed(3)} · Open-Meteo`;
    State.weatherStr = `${wc.desc} ${c.temperature_2m.toFixed(1)}℃ 습도${Math.round(c.relative_humidity_2m)}%`;
  } catch (e) {
    $('wx-desc').textContent = '날씨 조회 실패: ' + e.message;
  }
}

// WMO weather code → 설명/이모지
function wmo(code) {
  const m = {
    0:['맑음','☀️'],1:['대체로 맑음','🌤️'],2:['구름 조금','⛅'],3:['흐림','☁️'],
    45:['안개','🌫️'],48:['상고대 안개','🌫️'],
    51:['약한 이슬비','🌦️'],53:['이슬비','🌦️'],55:['짙은 이슬비','🌦️'],
    56:['어는 이슬비','🌧️'],57:['짙은 어는 이슬비','🌧️'],
    61:['약한 비','🌧️'],63:['비','🌧️'],65:['강한 비','🌧️'],
    66:['어는 비','🌧️'],67:['강한 어는 비','🌧️'],
    71:['약한 눈','❄️'],73:['눈','❄️'],75:['강한 눈','❄️'],77:['싸락눈','❄️'],
    80:['약한 소나기','🌦️'],81:['소나기','🌦️'],82:['강한 소나기','🌧️'],
    85:['약한 눈소나기','❄️'],86:['강한 눈소나기','❄️'],
    95:['뇌우','⛈️'],96:['우박 동반 뇌우','⛈️'],99:['강한 우박 뇌우','⛈️']
  };
  return { desc: (m[code] ? m[code][0] : '—'), emoji: (m[code] ? m[code][1] : '🌡️') };
}

/* ================= 측정 ================= */
async function measure() {
  if (State.measuring) return;
  State.measuring = true;
  const btn = $('measure-btn');
  btn.disabled = true;
  $('result-section').classList.add('measuring');

  // ▶ 측정 시작 순간의 속도로 CV1/CV2 고정 (10초 동안 유지)
  State.measureSpeed = effectiveRefSpeed();
  const cFrozen = cavityFrequencies($('tire-input').value, C_SOUND, State.measureSpeed);
  if (cFrozen) {
    $('cv1-input').value = cFrozen.cv1.toFixed(1);
    $('cv2-input').value = cFrozen.cv2.toFixed(1);
    syncCV();
  }

  try {
    // 샘플레이트 설정이 바뀌었으면 레코더 재생성
    const wantRate = Settings.sampleRate;
    if (State.recorder && State.recorderRate !== wantRate) {
      State.recorder.close(); State.recorder = null;
    }
    if (!State.recorder) {
      State.recorder = new NoiseRecorder();
      await State.recorder.init(wantRate === 'auto' ? null : wantRate);
      State.recorderRate = wantRate;
    }
    // 측정 조건으로부터 필요한 녹음 시간 계산
    const fs = State.recorder.sampleRate;
    const N = Math.round(fs / Settings.resHz);
    const hop = Math.max(1, Math.round(N * (1 - Settings.overlap)));
    const dur = (N + (Settings.averages - 1) * hop) / fs; // 목표 평균 횟수 확보
    // 카운트다운
    const spdSrc = (State.gpsSpeed != null) ? 'GPS' : '수동';
    setStatus(`측정 중… (${State.measureSpeed.toFixed(0)}km/h ${spdSrc} 고정)`);
    const { samples, sampleRate } = await State.recorder.record(dur, (p) => {
      const remain = Math.ceil(dur * (1 - p));
      $('countdown').textContent = remain;
      $('progress-bar').style.width = (p * 100) + '%';
    });
    $('countdown').textContent = '';
    $('progress-bar').style.width = '0%';
    setStatus('분석 중…');
    // 한 프레임 양보 후 분석(UI 갱신)
    await new Promise(requestAnimationFrame);
    analyze(samples, sampleRate);
    setStatus(`완료 · 측정속도 ${State.measureSpeed.toFixed(0)}km/h · fs=${sampleRate}Hz · ${(samples.length/sampleRate).toFixed(1)}s`);
  } catch (e) {
    setStatus('오류: ' + e.message);
    console.error(e);
  } finally {
    State.measuring = false;
    btn.disabled = false;
    $('result-section').classList.remove('measuring');
  }
}

function setStatus(t) { $('status').textContent = t; }

// 측정 조건 요약 + 소요시간 (fs 무관: dur=(1/res)*(1+(avg-1)*(1-ov)))
function measureDuration() {
  return (1 / Settings.resHz) * (1 + (Settings.averages - 1) * (1 - Settings.overlap));
}
function updateCondBadge() {
  const dur = measureDuration();
  const el = $('cond-badge');
  if (el) el.textContent =
    `분해능 ${Settings.resHz}Hz · 오버랩 ${(Settings.overlap*100).toFixed(0)}% · 평균 ${Settings.averages}회 · 측정 ${dur.toFixed(1)}초`;
  const md = $('measure-dur');
  if (md) md.textContent = `(${dur.toFixed(1)}초)`;
}

// 현재 유지 중인 교정 오프셋을 화면에 표시
function updateCalibBadge() {
  const o = Settings.offset;
  const el = $('calib-badge');
  if (!el) return;
  if (o === 0) {
    el.textContent = '교정값 미적용 (0 dB)';
    el.classList.remove('on');
  } else {
    el.textContent = `교정 ${o >= 0 ? '+' : ''}${o.toFixed(1)} dB 유지 중`;
    el.classList.add('on');
  }
}

/* ================= 분석 ================= */
const PN_LO = 500, PN_HI = 4000;  // Pattern Noise 대역

function analyze(samples, fs) {
  const weightFn = (Settings.weighting === 'A') ? DSP.aWeightGain : null;
  // ISO SPL 환산: 풀스케일 기준 + 교정 오프셋
  const offset = Settings.offset + Settings.fullScaleDb;

  // 입력 신호 레벨(dBFS) — 무음이면 결과가 큰 음수가 되므로 점검
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const inRms = samples.length ? Math.sqrt(sumSq / samples.length) : 0;
  const inDbfs = 20 * Math.log10(inRms + 1e-30);
  const lowSignal = inRms < 3e-4;  // ≈ -70 dBFS 이하 → 사실상 무음/미세신호
  // 측정 조건: 분해능 / 오버랩 / 평균
  const { gxx, df, segments } =
    DSP.autopowerRes(samples, fs, Settings.resHz, Settings.overlap, Settings.averages);

  syncCV();
  const cv1 = State.cv1, cv2 = State.cv2;
  const bLo = cv1 + CAV_LO_OFF;   // Cavity 하한 = CV1+8
  const bHi = cv2 + CAV_HI_OFF;   // Cavity 상한 = CV2+35

  // Road Noise 대역 레벨 (+ 밴드별 미세보정: testlab 편차)
  const overall = DSP.bandLevel(gxx, df, 20, 500, weightFn, offset);
  const booming = DSP.bandLevel(gxx, df, 20, bLo, weightFn, offset);
  const cavity  = DSP.bandLevel(gxx, df, bLo, bHi, weightFn, offset);
  const rumble  = DSP.bandLevel(gxx, df, bHi, 500, weightFn, offset);
  overall.level += Settings.calOverall;
  booming.level += Settings.calBooming;
  cavity.level  += Settings.calCavity;
  rumble.level  += Settings.calRumble;
  // Pattern Noise RMS (500–4000Hz) + 1/3 옥타브
  const patternRms = DSP.bandLevel(gxx, df, PN_LO, PN_HI, weightFn, offset);
  patternRms.level += Settings.calPattern;
  const bands = DSP.thirdOctaveBands(gxx, df, PN_LO, PN_HI, weightFn, offset);

  $('seg-note').innerHTML =
    (lowSignal ? '<b style="color:#f87171">⚠ 마이크 입력이 매우 낮습니다(무음?) — 권한/마이크 가림/입력장치 확인</b><br>' : '') +
    `Δf=${df.toFixed(1)}Hz · 오버랩 ${(Settings.overlap*100).toFixed(0)}% · 평균 ${segments}회 · Hanning · ` +
    `${Settings.weighting==='A'?'A-weighting':'Linear'} · 기준 ${Settings.fullScaleDb}dB · 입력 ${inDbfs.toFixed(0)}dBFS`;

  // 측정 음원(WAV) 보관 — 재생/저장/IndexedDB
  const nowIso = new Date().toISOString();
  const audioName = 'noise_' + nowIso.replace(/[-:T]/g, '').slice(0, 13);
  AudioX.setFromSamples(samples, fs, audioName);
  idbPut(nowIso, AudioX.wavBlob).catch(() => {});
  enableAudioUI(true);

  // 결과 객체 (저장/비교 공통)
  const result = {
    time: nowIso, audioId: nowIso,
    tempC: State.tempC, weather: $('wx-desc').textContent, location: $('wx-loc').textContent,
    speedKmh: State.measureSpeed, speedSrc: (State.gpsSpeed != null) ? 'GPS' : 'manual',
    tire: $('tire-input').value, cv1, cv2, cavLoOff: CAV_LO_OFF, cavHiOff: CAV_HI_OFF,
    weighting: Settings.weighting, offset: Settings.offset, fullScaleDb: Settings.fullScaleDb,
    resHz: Settings.resHz, overlap: Settings.overlap, averages: segments, sampleRate: fs,
    inputDbfs: +inDbfs.toFixed(1),
    roadNoise: {
      overall: overall.level, booming: booming.level,
      cavity: cavity.level, rumble: rumble.level
    },
    patternRms: patternRms.level,
    thirdOctave: bands.map(b => ({ fc: b.fc, level: b.level })),
    // Autopower 스펙트럼 데이터(20–500Hz) — 저장/내보내기용
    spectrum: buildSpectrumData(gxx, df, 20, 500, weightFn, offset)
  };
  State.lastResult = result;

  // 그래프 재사용을 위해 스펙트럼 보관(메모리)
  const snap = { result, gxx, df, weightFn, offset, cv1, cv2, bands };
  State.current = snap;
  if (!State.reference) State.reference = snap; // 첫 측정 → 레퍼런스 고정

  renderComparison();
  $('save-btn').disabled = false;

  // 자동저장
  if (Settings.autoSave) saveCurrentResult(true);
}

// 스펙트럼 데이터 {fLo, df, L:[레벨...]} — 그대로 재구성/CSV 가능
function buildSpectrumData(gxx, df, fLo, fHi, weightFn, offset) {
  const kLo = Math.max(1, Math.ceil(fLo / df));
  const kHi = Math.min(gxx.length - 1, Math.floor(fHi / df));
  const L = [];
  for (let k = kLo; k <= kHi; k++) {
    const g = weightFn ? Math.pow(weightFn(k * df), 2) : 1;
    L.push(+(10 * Math.log10(gxx[k] * g + 1e-30) + offset).toFixed(2));
  }
  return { fLo: kLo * df, df: df, L };
}

/* 레퍼런스 vs 현재 비교 렌더링 */
function renderComparison() {
  const cur = State.current, ref = State.reference;
  if (!cur) return;
  const unit = (cur.result.weighting === 'A') ? ' dB(A)' : ' dB';
  const isRef = (!ref || cur === ref);

  // 레퍼런스 안내
  if (!ref) {
    $('ref-info').textContent = '레퍼런스 없음 — 다음 측정이 기준이 됩니다';
  } else {
    const rt = new Date(ref.result.time);
    const rts = `${rt.getMonth()+1}/${rt.getDate()} ${String(rt.getHours()).padStart(2,'0')}:${String(rt.getMinutes()).padStart(2,'0')}`;
    $('ref-info').textContent = (cur === ref)
      ? `레퍼런스 = 이번(1차) 측정 · ${(ref.result.speedKmh??0).toFixed(0)}km/h`
      : `레퍼런스(1차) ${rts} · ${(ref.result.speedKmh??0).toFixed(0)}km/h  vs  현재 ${(cur.result.speedKmh??0).toFixed(0)}km/h`;
  }

  // Road Noise 셀 (현재값 + Δ vs 레퍼런스)
  const cells = [['overall','rn-overall'],['booming','rn-booming'],['cavity','rn-cavity'],['rumble','rn-rumble']];
  for (const [key, id] of cells) {
    const cv = cur.result.roadNoise[key];
    $(id).textContent = cv.toFixed(1) + unit;
    setDelta($(id + '-d'), isRef ? null : cv - ref.result.roadNoise[key]);
  }
  // Pattern Noise RMS
  $('pn-rms').textContent = cur.result.patternRms.toFixed(1) + unit;
  setDelta($('pn-rms-d'), isRef ? null : cur.result.patternRms - ref.result.patternRms);

  // 그래프: 레퍼런스(회색) + 현재(색). 첫 측정이면 현재만.
  // CV1/CV2 라인 숨김(marks=null), Road Noise Y축 하단 25 고정
  const refSpec = isRef ? null : ref;
  drawSpectrum($('autopower-canvas'), cur, refSpec, 20, 500, null, 25);
  drawThirdOctaveLine($('pattern-canvas'), cur, refSpec);
}

function setDelta(el, d) {
  if (!el) return;
  if (d == null) { el.textContent = '기준(REF)'; el.className = 'rn-delta ref'; return; }
  const s = (d >= 0 ? '+' : '') + d.toFixed(1);
  el.textContent = 'Δ ' + s;
  el.className = 'rn-delta ' + (d > 0.05 ? 'up' : d < -0.05 ? 'down' : '');
}

function setReferenceToCurrent() {
  if (State.current) { State.reference = State.current; renderComparison(); setStatus('현재 측정을 레퍼런스로 설정'); }
}
function clearReference() {
  State.reference = null;   // 다음 측정이 새 레퍼런스가 됨
  renderComparison();
  setStatus('레퍼런스 해제 — 다음 측정이 새 기준이 됩니다');
}

/* ================= 그래프 (canvas) ================= */
function prepCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const w = Math.max(300, rect.width), h = cv.clientHeight || 220;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceRange(min, max) {
  if (!isFinite(min) || !isFinite(max) || min === max) return { lo: (min||0)-10, hi: (max||0)+10 };
  const pad = (max - min) * 0.1 || 5;
  return { lo: Math.floor((min - pad) / 5) * 5, hi: Math.ceil((max + pad) / 5) * 5 };
}
// 눈금이 6~8개가 되도록 적응형 간격
function gridStep(range) {
  for (const s of [2, 5, 10, 20, 50, 100]) if (range / s <= 8) return s;
  return 200;
}

// gxx(또는 저장된 curve) → 레벨(dB) 배열
function specLevels(snap, fLo, fHi) {
  if (snap.curve) return snap.curve.filter(p => p.f >= fLo && p.f <= fHi);
  const { gxx, df, weightFn, offset } = snap;
  const kLo = Math.max(1, Math.ceil(fLo / df));
  const kHi = Math.min(gxx.length - 1, Math.floor(fHi / df));
  const out = [];
  for (let k = kLo; k <= kHi; k++) {
    const g = weightFn ? Math.pow(weightFn(k * df), 2) : 1;
    out.push({ f: k * df, L: 10 * Math.log10(gxx[k] * g + 1e-30) + offset });
  }
  return out;
}

// 선 스펙트럼: 현재(cur) + 레퍼런스(ref, 회색) 오버레이. yFloor 지정 시 Y축 하단 고정
function drawSpectrum(cv, cur, ref, fLo, fHi, marks, yFloor) {
  const { ctx, w, h } = prepCanvas(cv);
  const padL = 46, padR = 10, padT = 12, padB = 26;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const curL = specLevels(cur, fLo, fHi);
  const refL = ref ? specLevels(ref, fLo, fHi) : null;
  let ymin = Infinity, ymax = -Infinity;
  const scan = (arr) => arr.forEach(p => { if (p.L < ymin) ymin = p.L; if (p.L > ymax) ymax = p.L; });
  scan(curL); if (refL) scan(refL);
  let yr;
  if (yFloor != null) {
    const hi = Math.ceil((ymax + 3) / 5) * 5;
    yr = { lo: yFloor, hi: Math.max(hi, yFloor + 10) };
  } else {
    if (ymax - ymin > 80) ymin = ymax - 80; // 표시 동적범위 80dB 제한
    yr = niceRange(ymin, ymax);
  }
  const x = (f) => padL + ((f - fLo) / (fHi - fLo)) * plotW;
  const y = (L) => padT + (1 - (L - yr.lo) / (yr.hi - yr.lo)) * plotH;

  ctx.font = '11px system-ui, sans-serif';
  ctx.strokeStyle = 'rgba(128,128,128,.25)';
  ctx.fillStyle = 'rgba(140,140,150,.9)';
  ctx.lineWidth = 1;
  const stepS = gridStep(yr.hi - yr.lo);
  for (let gy = Math.ceil(yr.lo / stepS) * stepS; gy <= yr.hi; gy += stepS) {
    ctx.beginPath(); ctx.moveTo(padL, y(gy)); ctx.lineTo(w - padR, y(gy)); ctx.stroke();
    ctx.fillText(gy.toString(), 6, y(gy) + 3);
  }
  for (const gf of [50, 100, 200, 300, 400, 500]) {
    if (gf < fLo || gf > fHi) continue;
    ctx.beginPath(); ctx.moveTo(x(gf), padT); ctx.lineTo(x(gf), h - padB); ctx.stroke();
    ctx.fillText(gf + '', x(gf) - 8, h - 8);
  }

  if (marks) for (const m of marks) {
    if (m.f < fLo || m.f > fHi) continue;
    ctx.strokeStyle = 'rgba(255,120,60,.9)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x(m.f), padT); ctx.lineTo(x(m.f), h - padB); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,120,60,1)';
    ctx.fillText(m.label + ' ' + m.f.toFixed(0), x(m.f) + 2, padT + 10);
  }

  const line = (arr, color, dash) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.setLineDash(dash || []);
    ctx.beginPath();
    arr.forEach((p, i) => { const px = x(p.f), py = y(p.L); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke(); ctx.setLineDash([]);
  };
  if (refL) line(refL, 'rgba(160,160,170,.8)', [4, 3]); // 레퍼런스 회색 점선
  line(curL, '#3b82f6');                                 // 현재 파랑
  drawLegend(ctx, w, padR, !!refL);

  ctx.fillStyle = 'rgba(140,140,150,.9)';
  ctx.fillText('Hz', w - padR - 16, h - 8);
}

// 1/3 옥타브 라인 (현재 + 레퍼런스), 로그 X
function drawThirdOctaveLine(cv, cur, ref) {
  const { ctx, w, h } = prepCanvas(cv);
  const padL = 40, padR = 10, padT = 12, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const cb = cur.bands;
  if (!cb || !cb.length) return;
  const rb = ref ? ref.bands : null;

  let ymin = Infinity, ymax = -Infinity;
  const scan = (bs) => bs && bs.forEach(b => { if (b.level < ymin) ymin = b.level; if (b.level > ymax) ymax = b.level; });
  scan(cb); scan(rb);
  if (ymax - ymin > 80) ymin = ymax - 80;
  const yr = niceRange(ymin, ymax);
  const fLo = cb[0].fc, fHi = cb[cb.length - 1].fc;
  const lx = (fc) => padL + (Math.log2(fc / fLo) / Math.log2(fHi / fLo)) * plotW;
  const y = (L) => padT + (1 - (L - yr.lo) / (yr.hi - yr.lo)) * plotH;

  ctx.font = '10px system-ui, sans-serif';
  ctx.strokeStyle = 'rgba(128,128,128,.25)';
  ctx.fillStyle = 'rgba(140,140,150,.9)';
  const stepS = gridStep(yr.hi - yr.lo);
  for (let gy = Math.ceil(yr.lo / stepS) * stepS; gy <= yr.hi; gy += stepS) {
    ctx.beginPath(); ctx.moveTo(padL, y(gy)); ctx.lineTo(w - padR, y(gy)); ctx.stroke();
    ctx.fillText(gy.toString(), 6, y(gy) + 3);
  }
  // x 라벨
  cb.forEach(b => { ctx.fillText(fmtFc(b.fc), lx(b.fc) - 8, h - 8); });

  const line = (bs, color, dash) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash(dash || []);
    ctx.beginPath();
    bs.forEach((b, i) => { const px = lx(b.fc), py = y(b.level); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke(); ctx.setLineDash([]);
    // 포인트
    ctx.fillStyle = color;
    bs.forEach(b => { ctx.beginPath(); ctx.arc(lx(b.fc), y(b.level), 2.2, 0, 2 * Math.PI); ctx.fill(); });
  };
  if (rb) line(rb, 'rgba(160,160,170,.8)', [4, 3]);
  line(cb, '#10b981');
  drawLegend(ctx, w, padR, !!rb);
}

function drawLegend(ctx, w, padR, hasRef) {
  if (!hasRef) return;
  ctx.font = '10px system-ui, sans-serif';
  const x = padR + 8, yb = 12;
  ctx.strokeStyle = 'rgba(160,160,170,.8)'; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(w - 78, yb); ctx.lineTo(w - 62, yb); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(140,140,150,.95)'; ctx.fillText('Ref', w - 58, yb + 3);
}

function fmtFc(fc) {
  return fc >= 1000 ? (fc / 1000) + 'k' : String(fc);
}

/* ================= 결과 저장 / 내보내기 ================= */
const TO_COLS = [500,630,800,1000,1250,1600,2000,2500,3150,4000];

function getSaved() {
  try { return JSON.parse(LS.getItem('saved_results') || '[]'); } catch (e) { return []; }
}
function setSaved(arr) { LS.setItem('saved_results', JSON.stringify(arr)); }

// 이름 끝의 숫자를 1 증가 (자리수 유지). 숫자 없으면 _2 부착
function incrementName(name) {
  const m = String(name).match(/^(.*?)(\d+)(\s*)$/);
  if (m) {
    const w = m[2].length;
    const n = String(parseInt(m[2], 10) + 1).padStart(w, '0');
    return m[1] + n + m[3];
  }
  return name + '_2';
}

function saveCurrentResult(auto) {
  if (!State.lastResult) return;
  const name = ($('autosave-name').value || '측정_001').trim();
  State.lastResult.name = name;
  const arr = getSaved();
  arr.unshift(State.lastResult);
  setSaved(arr);
  renderSaved();
  // 다음 이름으로 자동 증가
  const next = incrementName(name);
  Settings.autoSaveName = next;
  $('autosave-name').value = next;
  setStatus((auto ? '자동저장' : '저장') + `: ${name} (${arr.length}건)`);
}

function deleteSaved(idx) {
  const arr = getSaved();
  const r = arr[idx];
  if (r && r.audioId) idbDel(r.audioId).catch(() => {});
  arr.splice(idx, 1);
  setSaved(arr);
  renderSaved();
}

function clearSaved() {
  if (!confirm('저장된 모든 결과를 삭제할까요? (음원 포함)')) return;
  setSaved([]);
  idbClear().catch(() => {});
  renderSaved();
}

function renderSaved() {
  const arr = getSaved();
  const list = $('saved-list');
  $('saved-count').textContent = arr.length;
  $('export-btn').disabled = arr.length === 0;
  $('spec-btn').disabled = arr.length === 0;
  $('clear-btn').disabled = arr.length === 0;
  if (arr.length === 0) { list.innerHTML = '<div class="muted center">저장된 결과 없음</div>'; return; }
  const unit = (w) => w === 'A' ? 'dB(A)' : 'dB';
  list.innerHTML = arr.map((r, i) => {
    const t = new Date(r.time);
    const ts = `${t.getMonth()+1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    return `<div class="saved-item">
      <div class="saved-main clickable" data-view="${i}" title="눌러서 결과 보기">
        <b>${r.name || ts}</b> <span class="muted">${ts} · ${(r.speedKmh??0).toFixed(0)}km/h · ${r.tire||''}</span>
        <div class="muted">OA ${r.roadNoise.overall.toFixed(1)} / Bo ${r.roadNoise.booming.toFixed(1)} / Ca ${r.roadNoise.cavity.toFixed(1)} / Ru ${r.roadNoise.rumble.toFixed(1)} / PN ${(r.patternRms??0).toFixed(1)} ${unit(r.weighting)}</div>
      </div>
      <button class="del-btn" data-idx="${i}">✕</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.del-btn').forEach(b =>
    b.addEventListener('click', () => deleteSaved(parseInt(b.dataset.idx, 10))));
  list.querySelectorAll('.saved-main[data-view]').forEach(el =>
    el.addEventListener('click', () => viewSaved(parseInt(el.dataset.view, 10))));
}

// 저장된 결과 → 스냅(그래프 재구성용)
function snapFromSaved(r) {
  const curve = (r.spectrum && r.spectrum.L)
    ? r.spectrum.L.map((L, i) => ({ f: +(r.spectrum.fLo + i * r.spectrum.df).toFixed(1), L }))
    : [];
  const bands = (r.thirdOctave || []).map(b => ({ fc: b.fc, level: b.level }));
  return { result: r, curve, bands, cv1: r.cv1, cv2: r.cv2 };
}

// 저장된 결과 보기 (Road/Pattern Noise + 그래프 재현)
function viewSaved(idx) {
  const arr = getSaved();
  const r = arr[idx];
  if (!r) return;
  State.current = snapFromSaved(r);
  renderComparison();
  const t = new Date(r.time);
  const ts = `${t.getMonth()+1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
  $('seg-note').innerHTML =
    `📁 저장결과: <b>${r.name || ''}</b> · ${ts} · ${(r.speedKmh??0).toFixed(0)}km/h · ${r.tire||''} · ` +
    `${r.weighting==='A'?'A-weighting':'Linear'}` + (r.weather ? ` · ${r.weather}` : '');
  setStatus(`저장결과 보기: ${r.name || ''} (${ts})`);
  // 저장된 음원 로드 (있으면 재생/저장 가능)
  AudioX.clear(); enableAudioUI(false);
  if (r.audioId) {
    idbGet(r.audioId).then(blob => {
      if (blob) { AudioX.setFromBlob(blob, r.name || 'saved').then(() => enableAudioUI(true)); }
    }).catch(() => {});
  }
  const rs = $('result-section');
  if (rs && rs.scrollIntoView) rs.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function exportCsv() {
  const arr = getSaved();
  if (!arr.length) return;
  const head = ['name','time','tempC','weather','location','speedKmh','speedSrc','tire',
    'cv1','cv2','cavLoOff','cavHiOff','weighting','offset_dB','fullScaleDb','resHz','overlap','averages','sampleRate','input_dBFS',
    'RN_overall','RN_booming','RN_cavity','RN_rumble','PN_RMS_500_4000',
    ...TO_COLS.map(f => 'TO_' + f + 'Hz')];
  const rows = arr.map(r => {
    const toMap = {}; (r.thirdOctave || []).forEach(b => toMap[b.fc] = b.level);
    const esc = (v) => {
      const s = (v == null) ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [
      r.name || '', r.time, r.tempC, r.weather, r.location, fmt(r.speedKmh), r.speedSrc, r.tire,
      fmt(r.cv1), fmt(r.cv2), r.cavLoOff, r.cavHiOff, r.weighting, fmt(r.offset), fmt(r.fullScaleDb), r.resHz, r.overlap, r.averages, r.sampleRate, fmt(r.inputDbfs),
      fmt(r.roadNoise.overall), fmt(r.roadNoise.booming), fmt(r.roadNoise.cavity), fmt(r.roadNoise.rumble), fmt(r.patternRms),
      ...TO_COLS.map(f => toMap[f] != null ? toMap[f].toFixed(2) : '')
    ].map(esc).join(',');
  });
  const csv = '﻿' + head.join(',') + '\n' + rows.join('\n'); // BOM(엑셀 한글)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  a.href = url;
  a.download = `noise_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Autopower 스펙트럼 CSV: 1열=주파수, 이후 측정별 레벨(dB)
function exportSpectrumCsv() {
  const arr = getSaved().filter(r => r.spectrum && r.spectrum.L);
  if (!arr.length) { alert('저장된 스펙트럼 데이터가 없습니다.'); return; }
  // 공통 주파수 그리드(첫 측정 기준)
  const base = arr[0].spectrum;
  const freqs = base.L.map((_, i) => +(base.fLo + i * base.df).toFixed(1));
  const names = arr.map((r, i) => (r.name || ('m' + i)));
  const rows = [['Freq_Hz', ...names].join(',')];
  for (let i = 0; i < freqs.length; i++) {
    const cols = arr.map(r => (r.spectrum.L[i] != null ? r.spectrum.L[i] : ''));
    rows.push([freqs[i], ...cols].join(','));
  }
  downloadCsv(rows.join('\n'), 'spectrum');
}

function downloadCsv(body, prefix) {
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const n = new Date();
  a.href = url;
  a.download = `${prefix}_${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}${String(n.getDate()).padStart(2,'0')}_${String(n.getHours()).padStart(2,'0')}${String(n.getMinutes()).padStart(2,'0')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fmt(v) { return (v == null || isNaN(v)) ? '' : (+v).toFixed(2); }

/* ================= 음원 (WAV 저장 / 재생) ================= */
const AudioX = {
  ctx: null, src: null, buffer: null, wavBlob: null, rate: 48000, name: 'measure', peak: 1,
  getCtx() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); return this.ctx; },
  setFromSamples(samples, rate, name) {
    const s = Float32Array.from(samples);
    const buf = this.getCtx().createBuffer(1, s.length, rate);
    buf.copyToChannel(s, 0);
    this.buffer = buf; this.rate = rate; this.name = name || 'measure';
    this.wavBlob = encodeWav(s, rate);
    let pk = 0; for (let i = 0; i < s.length; i++) { const a = Math.abs(s[i]); if (a > pk) pk = a; }
    this.peak = pk || 1;
  },
  async setFromBlob(blob, name) {
    const arr = await blob.arrayBuffer();
    this.buffer = await this.getCtx().decodeAudioData(arr.slice(0));
    this.rate = this.buffer.sampleRate; this.name = name || 'measure'; this.wavBlob = blob;
    const ch = this.buffer.getChannelData(0);
    let pk = 0; for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > pk) pk = a; }
    this.peak = pk || 1;
  },
  stop() { if (this.src) { try { this.src.stop(); } catch (e) {} this.src = null; } updatePlayUI(); },
  async play(centerFreq, q) {
    if (!this.buffer) return;
    this.stop();
    const ctx = this.getCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createBufferSource(); src.buffer = this.buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(20, 0.9 / this.peak); // 재생 정규화(원시신호가 작아 들리게)
    let node = src;
    if (centerFreq) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = centerFreq; bp.Q.value = q || 8;
      src.connect(bp); node = bp;
    }
    node.connect(gain); gain.connect(ctx.destination);
    src.onended = () => { if (this.src === src) { this.src = null; updatePlayUI(); } };
    src.start(); this.src = src; updatePlayUI();
  },
  clear() { this.stop(); this.buffer = null; this.wavBlob = null; },
  download() {
    if (!this.wavBlob) return;
    const url = URL.createObjectURL(this.wavBlob);
    const a = document.createElement('a'); a.href = url;
    a.download = (this.name || 'measure').replace(/[\\/:*?"<>|]/g, '_') + '.wav';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

// Float32 → 16bit PCM WAV Blob
function encodeWav(samples, rate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) { let s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

// IndexedDB: 측정별 WAV 보관
function idb(fn) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('noiseAudio', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('wav')) r.result.createObjectStore('wav'); };
    r.onsuccess = () => fn(r.result, res, rej);
    r.onerror = () => rej(r.error);
  });
}
function idbPut(id, blob) { return idb((db, res, rej) => { const tx = db.transaction('wav', 'readwrite'); tx.objectStore('wav').put(blob, id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
function idbGet(id) { return idb((db, res, rej) => { const tx = db.transaction('wav', 'readonly'); const g = tx.objectStore('wav').get(id); g.onsuccess = () => res(g.result || null); g.onerror = () => rej(g.error); }); }
function idbDel(id) { return idb((db, res, rej) => { const tx = db.transaction('wav', 'readwrite'); tx.objectStore('wav').delete(id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
function idbClear() { return idb((db, res, rej) => { const tx = db.transaction('wav', 'readwrite'); tx.objectStore('wav').clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }

function enableAudioUI(on) {
  ['play-full', 'play-band', 'wav-save'].forEach(id => { const b = $(id); if (b) b.disabled = !on; });
  const info = $('audio-info');
  if (info) info.textContent = on ? `${(AudioX.buffer ? AudioX.buffer.duration : 0).toFixed(1)}초 · ${AudioX.rate}Hz` : '측정 후 사용 가능';
  updatePlayUI();
}
function updatePlayUI() {
  const s = $('play-stop'); if (s) s.disabled = !(AudioX.src);
}
function bandFreqPreset(kind) {
  const f = (kind === 'cv1') ? State.cv1 : (kind === 'cv2') ? State.cv2 : (State.cv1 + State.cv2) / 2;
  if (f && isFinite(f)) $('band-freq').value = f.toFixed(0);
}

/* ================= 초기화 / 이벤트 ================= */
function init() {
  // 설정값 복원
  $('tire-input').value = Settings.tire;
  $('refspeed-input').value = Settings.refSpeed;
  $('gps-cavity-toggle').checked = Settings.gpsCavity;
  $('api-key').value = Settings.apiKey;
  $('calib-offset').value = Settings.offset;
  $('fullscale-input').value = Settings.fullScaleDb;
  $('cal-overall').value = Settings.calOverall;
  $('cal-booming').value = Settings.calBooming;
  $('cal-cavity').value = Settings.calCavity;
  $('cal-rumble').value = Settings.calRumble;
  $('cal-pattern').value = Settings.calPattern;
  $('weighting-sel').value = Settings.weighting;
  $('res-input').value = Settings.resHz;
  $('overlap-input').value = Math.round(Settings.overlap * 100);
  $('avg-input').value = Settings.averages;
  $('sr-sel').value = Settings.sampleRate;
  $('autosave-toggle').checked = Settings.autoSave;
  $('autosave-name').value = Settings.autoSaveName;
  updateCalibBadge();
  updateCondBadge();
  renderSaved();

  recomputeCavity();
  startGPS();

  // 이벤트
  $('measure-btn').addEventListener('click', measure);
  $('tire-input').addEventListener('change', (e) => { Settings.tire = e.target.value; recomputeCavity(); });
  $('refspeed-input').addEventListener('change', (e) => { Settings.refSpeed = parseFloat(e.target.value) || 0; recomputeCavity(); });
  $('gps-cavity-toggle').addEventListener('change', (e) => { Settings.gpsCavity = e.target.checked; recomputeCavity(); });
  $('cv1-input').addEventListener('change', syncCV);
  $('cv2-input').addEventListener('change', syncCV);
  $('wx-refresh').addEventListener('click', fetchWeather);

  $('api-key').addEventListener('change', (e) => { Settings.apiKey = e.target.value.trim(); fetchWeather(); });
  $('calib-offset').addEventListener('change', (e) => {
    Settings.offset = parseFloat(e.target.value) || 0;
    e.target.value = Settings.offset;   // 정규화된 값으로 표시(유지 확인)
    updateCalibBadge();
  });
  $('fullscale-input').addEventListener('change', (e) => {
    Settings.fullScaleDb = parseFloat(e.target.value) || 0;
    e.target.value = Settings.fullScaleDb;
  });
  const calBind = (id, setter) => $(id).addEventListener('change', (e) => {
    const v = parseFloat(e.target.value) || 0; setter(v); e.target.value = v;
  });
  calBind('cal-overall', v => Settings.calOverall = v);
  calBind('cal-booming', v => Settings.calBooming = v);
  calBind('cal-cavity',  v => Settings.calCavity  = v);
  calBind('cal-rumble',  v => Settings.calRumble  = v);
  calBind('cal-pattern', v => Settings.calPattern = v);
  $('weighting-sel').addEventListener('change', (e) => { Settings.weighting = e.target.value; });
  $('res-input').addEventListener('change', (e) => { Settings.resHz = parseFloat(e.target.value) || 2; updateCondBadge(); });
  $('overlap-input').addEventListener('change', (e) => {
    let p = parseFloat(e.target.value); if (isNaN(p)) p = 75; p = Math.min(95, Math.max(0, p));
    Settings.overlap = p / 100; e.target.value = p; updateCondBadge();
  });
  $('avg-input').addEventListener('change', (e) => { Settings.averages = parseInt(e.target.value, 10) || 81; updateCondBadge(); });
  $('sr-sel').addEventListener('change', (e) => {
    Settings.sampleRate = e.target.value;
    if (State.recorder) { State.recorder.close(); State.recorder = null; } // 다음 측정에 재생성
    setStatus('샘플레이트 변경: ' + (e.target.value === 'auto' ? '기기 기본' : e.target.value + 'Hz'));
  });

  // 결과 저장 / 내보내기
  $('save-btn').addEventListener('click', () => saveCurrentResult(false));
  $('export-btn').addEventListener('click', exportCsv);
  $('spec-btn').addEventListener('click', exportSpectrumCsv);
  $('clear-btn').addEventListener('click', clearSaved);
  $('autosave-toggle').addEventListener('change', (e) => { Settings.autoSave = e.target.checked; });
  $('autosave-name').addEventListener('change', (e) => { Settings.autoSaveName = e.target.value.trim(); });

  // 레퍼런스 제어
  $('ref-reset').addEventListener('click', clearReference);
  $('ref-set').addEventListener('click', setReferenceToCurrent);

  // 음원 재생 / 저장
  $('play-full').addEventListener('click', () => AudioX.play());
  $('play-band').addEventListener('click', () => {
    const f = parseFloat($('band-freq').value);
    const q = parseFloat($('band-q').value) || 8;
    if (f > 0) AudioX.play(f, q);
  });
  $('play-stop').addEventListener('click', () => AudioX.stop());
  $('wav-save').addEventListener('click', () => AudioX.download());
  document.querySelectorAll('#audio-card .chip').forEach(c =>
    c.addEventListener('click', () => bandFreqPreset(c.dataset.f)));
  enableAudioUI(false);

  $('settings-toggle').addEventListener('click', () => {
    $('settings-panel').classList.toggle('open');
  });

  // 서비스워커 등록 (네트워크 우선 → 항상 최신 + 오프라인 + PWA 설치 가능)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // PWA 설치 버튼
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    const b = $('install-btn'); if (b) b.style.display = '';
  });
  $('install-btn').addEventListener('click', async () => {
    if (!deferredInstall) {
      alert('브라우저 메뉴(⋮) → "앱 설치" 또는 "홈 화면에 추가"를 눌러 설치하세요.');
      return;
    }
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('install-btn').style.display = 'none';
  });
  window.addEventListener('appinstalled', () => {
    const b = $('install-btn'); if (b) b.style.display = 'none';
    setStatus('앱이 설치되었습니다');
  });
}

document.addEventListener('DOMContentLoaded', init);
