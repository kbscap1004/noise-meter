# 핸드폰 소음측정 (Web PWA)

차량 주행 소음(Road Noise / Pattern Noise)을 핸드폰 브라우저로 측정하는 PWA.
외부 라이브러리 없이 순수 JS로 FFT/DSP를 직접 구현했습니다.

## 기능

| 구분 | 내용 |
|------|------|
| 기상 조건 | GPS 위치 기준 온도·날씨 (OpenWeatherMap). 온도로 음속 자동 보정 |
| 차량 속도 | GPS `coords.speed` → km/h. **이 속도가 Cavity 계산의 v로 자동 연동** |
| 타이어 Cavity | 타이어 규격 입력 → 회전분리 두 피크(CV1/CV2) 계산 (수정 가능) |
| Road Noise | Overall(20–500) / Booming(20–(CV1+8)) / Cavity((CV1+8)–(CV2+35)) / Rumble((CV2+35)–500) 대역 레벨 + Autopower 그래프 |
| Pattern Noise | 500–4000Hz RMS 값 + 1/3 옥타브 **라인** 그래프 |
| 레퍼런스 비교 | 첫 측정을 레퍼런스로 고정, 이후 측정마다 Δ(현재−레퍼런스) 표시 + 그래프 오버레이 |
| 단위 | ISO 음압레벨(dB re 20µPa) 환산: 풀스케일 기준(기본 120 dB SPL) + 교정 오프셋 |
| 신호처리 | Hanning window · Welch 평균 autopower · A/Z 가중 선택 · 교정 오프셋 |

**목표 속도 도달 → 측정 시작 버튼 → 10초 수집 → 결과 표시.**
버튼을 누른 **순간의 속도로 CV1/CV2가 고정**되어 10초 측정 내내 유지되며, 결과의 측정속도가 상태줄에 표시됩니다.

## 실행 (중요: HTTPS 필요)

마이크(`getUserMedia`)와 위치(`geolocation`)는 **보안 컨텍스트(HTTPS 또는 localhost)** 에서만 동작합니다.
그냥 `file://` 로 열면 마이크·GPS가 막힙니다.

### 방법 A. PC에서 로컬 테스트
```bash
# 이 폴더에서
python -m http.server 8000
# 브라우저에서 http://localhost:8000  (localhost 는 보안 컨텍스트로 허용)
```

### 방법 B. 핸드폰에서 실제 측정 (권장)
핸드폰 브라우저는 `localhost` 를 쓸 수 없으므로 HTTPS 호스팅이 필요합니다.

1. **GitHub Pages** (가장 간단·무료)
   - 이 폴더를 저장소에 올리고 Settings → Pages → 브랜치 지정
   - `https://<계정>.github.io/<repo>/` 접속 → 홈화면에 추가(PWA 설치)
2. **ngrok** 등 터널
   ```bash
   python -m http.server 8000
   ngrok http 8000      # 발급된 https 주소를 핸드폰에서 접속
   ```

접속 후 **마이크 / 위치 권한을 모두 허용**하세요.

## 사용 순서

1. ⚙️ 설정에서 **OpenWeatherMap API 키** 입력 (무료 발급: https://openweathermap.org/api)
2. **교정 오프셋(dB)** 입력 → 아래 "교정" 참고
3. 타이어 규격 입력 (예: `225/45R17`) → CV1/CV2 자동 계산 (필요 시 직접 수정)
4. **측정 시작(10초)** → Road / Pattern Noise 결과 확인

## 교정 (절대 dB(A) 표시)

핸드폰 마이크는 절대 음압을 보장하지 않으므로 **1회 교정**이 필요합니다.

1. 기준 소음계와 핸드폰을 같은 위치에 두고 일정한 소음(예: 핑크노이즈) 재생
2. 앱에서 교정 오프셋 `0` 으로 측정 → 앱의 Overall 값 확인
3. `오프셋 = 기준 소음계 dB(A) − 앱 원시값` 을 설정에 입력
4. 이후 측정값은 `원시값 + 오프셋` 으로 표시됨

> 상대 비교(대역 간, 조건 간)만 필요하면 오프셋 0(Linear/Z) 으로 사용해도 됩니다.

## Cavity 공명음 계산식

```
sidewall = width × (aspect/100)          # mm
rim_mm   = rim_inch × 25.4               # mm
OD       = rim_mm + 2 × sidewall         # 외경 mm
D_mean   = (rim_mm + OD) / 2             # 공동 centerline 평균지름 mm
L        = π × D_mean                    # Cavity centerline 유효둘레 (m)

CV1 = (c − v)/L                          # c=343m/s(음속), v=GPS속도, L=휠 중심 원주
CV2 = (c + v)/L
L   = π × D_mean,  D_mean = 림지름 + 사이드월높이   # 휠 중심(공동 centerline) 지름
```

예) 225/45R17, v=60km/h → L=1.675m → CV1=(343−16.67)/1.675=**194.9Hz**, CV2=(343+16.67)/1.675=**214.8Hz**
(CV1/CV2 값은 필드에서 직접 수정 가능)

- 회전(속도 v)에 의한 앞뒤/상하 모드 분리를 `(c∓v)/L` 로 계산합니다.
- **v = 실시간 GPS 속도**로 자동 연동됩니다. GPS 속도를 못 받는 경우(정지/실내/미지원)에는 화면의 **기준속도(km/h)** 수동값을 사용합니다.
- **CV1/CV2 보정(Hz)** 은 화면에서 조정할 수 있습니다. 실측 피크에 맞춰 값을 보정하거나 CV1/CV2 를 직접 수정하세요.

### Road Noise 대역

```
Overall :  20 ~ 500 Hz
Booming :  20 ~ (CV1 + 8)
Cavity  : (CV1 + 8) ~ (CV2 + 35)
Rumble  : (CV2 + 35) ~ 500 Hz
```

## 신호처리 상세

- **측정 조건**(화면 설정): 분해능 2Hz · 오버랩 75% · 평균 81회 → 소요시간 자동 계산(≈10.5초)
  - 소요시간 = `(1/분해능)·(1+(평균−1)·(1−오버랩))` (샘플레이트 무관)
- **autopower**: Welch 오버랩 + Hanning. `Gxx[k] = 2|X[k]|²/(N·Σw²)` (단측, RMS² 보존)
  → 임의 대역 합 = 그 대역의 mean-square, `√` 하면 RMS.
- **정확한 분해능**: 블록 N=`round(fs/분해능)` (예 48kHz·2Hz→24000, 2의 거듭제곱 아님).
  radix-2 FFT 만으로 임의 N DFT 를 계산하는 **Bluestein 알고리즘**을 구현해 Δf=2Hz 를 정확히 달성.
  (numpy 대비 오차 ~1e-15, 사인·잡음 RMS 보존 검증 완료)
- **레벨**: `L = 10·log10(ΣGxx) + offset` [dB / dB(A)]
- **A-weighting**: IEC 61672 이득을 주파수영역에서 `|H(f)|²` 로 곱함
- **1/3 옥타브**: IEC 선호 중심주파수, 대역 경계 `fc·2^(±1/6)`

## 결과 저장

- 측정 후 **이 결과 저장** → 브라우저(localStorage)에 누적 저장 (기기 재방문해도 유지)
- **자동저장**: 토글 ON + 최초 이름 입력 → 이후 측정마다 이름 끝 숫자가 자동 증가하며 자동 저장 (예: `측정_001` → `측정_002` …)
- **결과 CSV**: 저장된 모든 측정 (이름·시간·날씨·속도·타이어·CV1/CV2·측정조건·Road Noise 4대역·Pattern RMS·1/3옥타브 10밴드). 엑셀 한글 BOM 포함
- **스펙트럼 CSV**: Autopower 스펙트럼 데이터(20–500Hz, 2Hz 간격 241점) — 1열 주파수 + 측정별 레벨(dB) 열. Excel에서 바로 겹쳐 그리기 가능
- 개별 삭제(✕) / 전체 삭제 지원

## 교정 (측정 예시)

Siemens Testlab 대비 이 폰의 측정 오프셋은 약 **−19.7 dB** (전체 대역 평균):
즉 **0 dBFS ≈ 100.3 dB SPL**. 설정에서 **풀스케일 기준 = 100.3**(오프셋 0) 또는 **오프셋 = −19.7**(풀스케일 120)로 입력.
대역별로 편차 존재(Cavity ≈ −21.8, Booming ≈ −18.0) — 폰 마이크 주파수응답 비평탄. 필요 시 대역별 교정 가능.

## 파일 구조

```
index.html               화면
css/styles.css           스타일 (다크)
js/dsp.js                FFT · 창 · A-weighting · autopower · 1/3옥타브
js/audio.js              AudioWorklet 마이크 수집 (AGC/NS/EC off)
js/app.js                GPS · 날씨 · Cavity · 측정 오케스트레이션 · 그래프
manifest.webmanifest     PWA 매니페스트
sw.js                    오프라인 서비스워커
icons/                   앱 아이콘
```

## 한계 / 주의

- 핸드폰 마이크 주파수 응답은 평탄하지 않아 저역(부밍/공명) 정확도에 한계가 있습니다. 교정과 상대비교 위주로 활용하세요.
- 브라우저에 따라 샘플레이트가 44.1/48kHz 로 다를 수 있습니다(자동 반영).
- 측정 중 손·바람·핸들링 소음(핸들링 노이즈)에 주의하세요.
