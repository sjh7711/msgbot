# CoinTrade 일일 브리핑

`cointrade-daily-briefing.timer`는 매일 09:30 KST에 생성기를 시작한다. 생성기는
양쪽 09시 사이클, 사후 감사, pending, HALT, 리밸런싱 게이트를 확인하고 미완료면
10:00까지 5분 간격으로 재확인한다. 그때도 완료되지 않으면 정상 보고서 대신
incident 보고서를 저장한다.

결과는 다음 두 파일과 상태 파일에 원자적으로 기록한다.

- `reports/YYYY-MM-DD.json`: 모든 결정론적 수치와 원본 SHA-256
- `reports/YYYY-MM-DD.md`: 대시보드 밖에서도 읽을 수 있는 한국어 요약
- `state/daily_briefing_status.json`: 마지막 실행 상태

## 로컬 Qwen 설치

기본 설명 생성기는 `Qwen3.6-35B-A3B UD-Q5_K_M`(MoE, 토큰당 3B 활성)과 `llama.cpp` Vulkan backend다.
모델은 약 6.17GB이며 프로젝트나 Git 저장소가 아닌 사용자 전용 경로에 설치된다.
설치 스크립트는 고정된 파일 SHA-256을 검증한 뒤에만 파일을 활성화한다.

현재 Intel N150의 GPU ID `8086:46d4`는 Ubuntu 6.8 커널에서 바인딩되지 않으므로
HWE 6.17 커널과 Mesa Vulkan driver를 먼저 설치한다. BIOS의 고정 VRAM 크기는
변경하지 않아도 되며, iGPU는 시스템 메모리를 UMA로 공유한다.

```bash
sudo apt update
sudo apt install -y linux-generic-hwe-24.04 mesa-vulkan-drivers vulkan-tools
sudo usermod -aG render,video autotrader
sudo reboot
```

재부팅 후 `uname -r`, `ls -l /dev/dri/renderD128`, `vulkaninfo --summary`로 커널,
render device, GPU 장치를 확인한다.

> **2026-08-01 하드웨어 교체.** 아래 설치 절차와 벤치마크 중 일부는 구형
> Intel ADL-N iGPU 기준으로 작성된 것이다. 현재 서버는 **Ryzen 7 7840HS /
> Radeon 780M(UMA 1GB, GTT 확장) / DDR5 듀얼채널**이며 `vulkaninfo` 에도
> AMD 장치가 잡힌다. 모델도 9B 덴스 → 35B MoE 로 교체되어 메모리 요구량이
> 크게 늘었으므로, systemd 유닛의 `MemoryMax`·CPU 할당은 반드시 새 모델
> 크기(약 27GB)에 맞춰져 있어야 한다.

```bash
deploy/briefing/install-local-llm.sh
deploy/briefing/install-user-timer.sh
systemctl --user list-timers cointrade-daily-briefing.timer
```

설치 경로:

- llama.cpp: `/home/autotrader/.local/opt/llama.cpp/current`
- 모델: `/home/autotrader/.local/share/cointrade/models/Qwen3.6-35B-A3B-UD-Q5_K_M.gguf`

`cointrade-local-llm.service`는 부팅 시 시작되어 `192.168.0.55:18080`에만
바인딩되고 Bearer API 키를 요구한다. 5분 동안 추론 요청이 없으면 프로세스는
유지하되 모델과 KV cache를 메모리에서 해제하며, 다음 요청에서 자동으로 다시
적재한다. 모델 레이어를 iGPU로 offload한다. ⚠ CPU·메모리 제한값은 하드웨어와
모델 교체(2026-08-01) 이후 재확인이 필요하다 — 옛 값(2코어 / 최대 10GB)으로는
27GB 짜리 현재 모델이 적재되지 않는다. 자동 브리핑은 같은 내부망 endpoint와 키를 사용하고 모델에는
전체 보고서 파일이 아닌 약 3.4KB의 비밀 없는 핵심 팩트만 전달한다.

2026-07-16 동일 조건 벤치마크 결과는 다음과 같다. (구 하드웨어: Intel ADL-N)

| backend | prompt 512 | generation 128 | 전체 측정 시간 |
| --- | ---: | ---: | ---: |
| CPU | 4.44 tok/s | 2.50 tok/s | 4분 46초 |
| Vulkan iGPU | 21.41 tok/s | 2.34 tok/s | 1분 52초 |

2026-08-01 측정 (7840HS / 780M, 프롬프트 2,917토큰 · 생성 198토큰 기준).
차분 측정이라 모델 적재 시간은 제외했다 — 5분 유휴 후 첫 호출은 적재에만
약 28초가 더 붙는다.

| 모델 | 프롬프트 처리 | 생성 | 실효 대역폭 |
| --- | ---: | ---: | ---: |
| Qwen3.5-9B Q4_K_M (구) | 942 tok/s | 13.9 tok/s | 78 GB/s (이론치의 87%) |
| Qwen3.6-35B-A3B UD-Q5_K_M | 787 tok/s | **24.0 tok/s** | — |

생성 속도는 토큰마다 읽어야 하는 가중치 양에 반비례한다. 35B MoE 는 총량이
4배지만 토큰당 3B 만 활성화되므로, 9B 덴스보다 읽는 양이 적어 오히려 빠르다.
DDR5 듀얼채널 대역폭이 상한이라 이 이상은 램 속도를 올려야 한다.

실제 브리핑은 1,894 입력 토큰과 502 출력 토큰을 323.3초에 처리했다. 메모리
최대치는 약 6.4GB, swap 사용량은 0이었다. 입력 처리가 긴 브리핑에서는 Vulkan이
유리하지만 생성 속도 자체는 CPU와 비슷하므로 SYCL 전환은 필수가 아니다.

수동 검증:

```bash
systemctl --user start cointrade-daily-briefing.service
journalctl --user -u cointrade-daily-briefing.service -n 50 --no-pager
journalctl --user -u cointrade-local-llm.service -n 50 --no-pager
```

로컬 응답은 llama.cpp의 JSON schema 제약과 애플리케이션의 타입·길이·필드 검증을
모두 통과해야 사용된다. 모델 시작, 추론, JSON 검증 중 하나라도 실패하면 보고서는
기존 결정론적 한국어 분석으로 정상 생성되며 거래 서비스와 readiness를 막지 않는다.

## 내부망 질의응답 API

API 기본 주소와 모델 ID는 다음과 같다.

- base URL: `http://192.168.0.55:18080/v1` (DHCP 예약 또는 고정 IP 필요)
- model: `qwen3.6-35b-a3b-ud-q5_k_m`
- API key file: `/home/autotrader/.config/cointrade-llm/api-keys` (`0600`)
- 동시 처리 slot: 1개

키는 서버 터미널에서 `less ~/.config/cointrade-llm/api-keys`로 확인해 클라이언트의
비밀 저장소에 복사한다. Git, 채팅, 보고서에는 넣지 않는다. 클라이언트에서는 키가
shell history에 남지 않도록 다음처럼 입력한다.

```bash
read -rsp "API key: " COINTRADE_LLM_API_KEY
echo
curl http://192.168.0.55:18080/v1/chat/completions \
  -H "Authorization: Bearer ${COINTRADE_LLM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-35b-a3b-ud-q5_k_m","messages":[{"role":"system","content":"한국어로 간결하게 답하세요. /no_think"},{"role":"user","content":"오늘 할 일을 정리해줘"}],"max_tokens":512,"stream":false,"chat_template_kwargs":{"enable_thinking":false}}'
unset COINTRADE_LLM_API_KEY
```

OpenAI 호환 클라이언트에는 위 base URL, model, API key를 그대로 설정한다. Chat
Completions의 동기·SSE streaming 요청을 지원한다. `/health`와 `/v1/models`는 상태와
모델 ID만 공개하지만 `/v1/chat/completions`를 포함한 추론 요청은 키가 없거나 틀리면
`401`을 반환한다.

이 endpoint는 TLS가 없는 내부망 HTTP이므로 공유 Wi-Fi나 외부 인터넷에 노출하지
않고 라우터 port forwarding도 설정하지 않는다. 브라우저 CORS는 localhost로 제한해
LAN 웹 페이지에서 직접 호출할 수 없고 CLI·서버 애플리케이션에서 사용한다. 파일,
shell, 웹 검색 도구는 활성화하지 않았으므로 모델은 전달받은 대화만 처리한다.

## 선택적 OpenAI 공급자

OpenAI 사용은 필수가 아니다. 필요할 때만 user unit drop-in에서
`BRIEFING_AI_PROVIDER=openai`와 모델을 지정하고, API 키는 거래 봇 `.env`가 아닌
별도 파일을 권한 `600`으로 제한해 systemd credential로 연결한다.

```ini
# ~/.config/systemd/user/cointrade-daily-briefing.service.d/credential.conf
[Service]
Environment=BRIEFING_AI_PROVIDER=openai
Environment=BRIEFING_AI_MODEL=gpt-5.6-terra
LoadCredential=openai_api_key:/home/autotrader/.config/cointrade-briefing/openai-api-key
```

적용은 `systemctl --user daemon-reload` 후 수동 실행으로 검증한다. API 키와 거래소
키는 보고서 JSON이나 로그에 기록하지 않는다.

# 안전한 URL 수집·요약 및 웹 검색 API

`cointrade-url-summary.service`는 공개 웹 문서를 제한적으로 수집하고 내부
Qwen3.6으로 요약한다. 거래 워커·웹 대시보드와 별도 프로세스로 실행되며
`192.168.0.55:18082`에만 바인딩한다. `/health/*` 외 endpoint는 내부 LLM과
동일한 Bearer API 키를 요구한다.

일반 Qwen 답변·URL 요약·웹 검색을 하나로 사용할 때는 `/v1/ask`를 호출한다.
이 endpoint가 경로를 선택하고 필요한 작업만 실행하며, Qwen 모델 자체에는
네트워크나 도구 실행 권한을 주지 않는다.

웹 검색은 별도 `cointrade-searxng.service`가 공개 검색엔진을 조회하고,
URL 요약 서비스가 결과 문서를 기존 SSRF 방어 경로로 다시 수집한 뒤 Qwen에
전달한다. SearXNG는 `127.0.0.1:18888`에만 바인딩하며 LAN·Nginx·인터넷에
직접 노출하지 않는다.

## 안전 경계

- `http`와 `https`, 표준 포트 80·443만 허용한다.
- DNS의 모든 결과가 공개 IP여야 하며, 선택한 IP를 curl `--resolve`로 고정한다.
- localhost, 사설망, link-local, multicast, reserved 주소와 `.local`,
  `.internal` 이름을 거부한다.
- 리다이렉트는 최대 3회이며 매 목적지를 다시 DNS 검사하고 고정한다.
- 환경 프록시는 사용하지 않고 TLS 인증서를 검증한다.
- HTML·일반 텍스트는 2MiB, PDF는 8MiB, PDF는 50페이지로 제한한다.
- HTML의 script·style·form·navigation 요소를 제거한다.
- PDF 추출은 CPU·메모리·파일 수가 제한된 별도 subprocess에서 실행한다.
- 추출 본문은 최대 64,000자이고 긴 문서는 최대 10개 chunk로 나눠 요약한다.
- 문서 안의 명령은 신뢰하지 않으며 제공된 본문 밖의 사실을 추측하지 않도록
  고정 system policy를 사용한다.
- URL 요약과 검색은 합쳐서 동시에 1개만 처리한다. 같은 IP·키 조합에서 URL
  요약은 15분당 10회, 웹 검색은 15분당 5회로 제한한다.
- `/v1/ask`도 선택된 작업과 같은 한도를 공유한다. 일반·URL 요청은 10회,
  검색은 5회에 포함되며 일반 답변 뒤 자동 검색으로 전환되면 양쪽 한도를
  각각 사용한다.
- 요청 본문은 인증·JSON 파싱 전에 16KiB로 제한한다. 검색 문서 수집은
  75초 예산과 문서당 12초 timeout, 검색 답변 LLM 호출은 180초 timeout을
  적용해 단일 처리 slot이 무기한 점유되지 않게 한다.
- 감사 로그에는 query string을 제거한 URL, 크기, SHA-256, 처리 결과와 시간만
  기록하고 본문·요약·API 키는 기록하지 않는다.
- 검색 질의 원문·검색 snippet·종합 답변은 감사 로그에 남기지 않는다. 프로세스
  임시 salt를 쓴 질의 HMAC-SHA256과 길이, 수집 성공·실패 수, query string을
  제거한 출처만 기록한다.
- `.env`, 거래 state, SSH·백업·LLM 평문 키 경로는 systemd sandbox에서 가린다.
- SearXNG는 전용 Unix 사용자와 별도 venv로 실행하고 RFC1918·link-local
  목적지로의 네트워크 접근을 systemd에서 차단한다.

검색 API는 한 페이지의 일반 검색 결과만 사용하고 기본 3개, 최대 5개 문서를
수집한다. 각 결과 URL은 공개 IP·표준 포트·리다이렉트 규칙을 다시 통과해야
출처가 된다. 전체 근거 본문은 12,000자로 제한한다. Qwen은 `[S1]` 형식으로
실제 수집 출처를 인용해야 하며, 없는 출처 ID나 임의 URL을 만들면 응답을
실패 처리한다. 일부 문서만 수집되면 `partial=true`, 전부 실패하면 근거 없는
모델 답변 대신 오류를 반환한다.

로그인, 쿠키, 사용자 지정 header, JavaScript 렌더링 페이지, 50페이지를 넘는
PDF는 지원하지 않는다. URL에 인증 token이나 개인정보를 넣지 않는다.

## 설치

SearXNG는 CoinTrade virtualenv와 섞지 않는다. 설치 스크립트는 공식 저장소의
고정 커밋 `8892414dc38dd57728b7f62f33152ea80e3b305f`를
`/opt/cointrade-searxng`의 독립 venv에 설치하고 전용
`cointrade-search` 사용자로 실행한다. 먼저 검색 백엔드, 다음으로 API
서비스를 설치한다.

```bash
sudo deploy/systemd/install-searxng-service.sh
.venv/bin/pip install -r requirements-linux-py312.lock
sudo deploy/systemd/install-url-summary-service.sh
```

SearXNG 설치에는 Ubuntu 패키지와 Python 의존성을 받기 위한 인터넷 연결이
필요하다. 설치 후에는 다음 조건을 확인한다.

```bash
systemctl status cointrade-searxng.service --no-pager
ss -ltnp | grep 18888
curl -X POST http://127.0.0.1:18888/search \
  -d 'q=SearXNG' -d 'format=json' -d 'categories=general'
```

`18888`은 반드시 `127.0.0.1`에만 보여야 한다. UFW·라우터·Nginx에는 이
포트를 열지 않는다.

UFW가 활성 상태이면 설치 스크립트가 `192.168.0.0/24`에서
`192.168.0.55:18082/tcp`로 들어오는 연결만 허용한다.

## API

상태 확인에는 인증이 필요하지 않다.

```bash
curl http://192.168.0.55:18082/health/live
curl http://192.168.0.55:18082/health/ready
```

API 키는 shell history에 남기지 않고 입력한다.

```bash
read -rsp "API key: " COINTRADE_LLM_API_KEY
echo
```

### 통합 질문

일반 질문, URL 요약, 웹 검색을 자동으로 선택하려면 다음처럼 호출한다.

```bash
curl http://192.168.0.55:18082/v1/ask \
  -H "Authorization: Bearer ${COINTRADE_LLM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "query":"현재 SearXNG 안정 버전의 주요 변경점을 알려줘",
    "mode":"auto",
    "summary_style":"detailed",
    "language":"ko",
    "max_results":3,
    "time_range":"month"
  }'
```

`mode`의 의미:

- `auto`: URL이 있으면 URL 요약, 최신 정보나 명시적 검색 요청이면 웹 검색,
  나머지는 일반 Qwen 답변으로 처리한다. 일반 답변 단계에서 Qwen이 외부 근거가
  필요하다고 선언하면 검색을 한 번 실행한다.
- `chat`: 일반 Qwen만 호출하며 자동 검색하지 않는다.
- `url`: 질문에서 첫 번째 `http` 또는 `https` URL을 찾아 요약한다.
- `search`: 입력을 검색어로 사용해 SearXNG 검색과 근거 종합을 강제한다.

응답의 `route`는 실제 사용한 `chat`, `url_summary`, `web_search` 중 하나이며,
`route_reason`, `searched`, `fallback_used`, `sources`, 모델 token 사용량을
함께 반환한다. 자동 검색 fallback이 실행되면 모델이 정리한 검색어도
`search.query`에서 확인할 수 있다.

`auto`와 `search` 질문은 외부 검색엔진으로 전송될 수 있다. API 키·개인정보·
비공개 거래정보가 포함된 질문은 반드시 `mode=chat`으로 고정한다.

### 단일 URL 요약

기존 전용 endpoint도 계속 사용할 수 있다.

```bash
curl http://192.168.0.55:18082/v1/url-summaries \
  -H "Authorization: Bearer ${COINTRADE_LLM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/","summary_style":"brief","language":"ko"}'
```

응답에는 요청 ID, 요청·최종 URL, 제목, 수집 시각, MIME, byte 수, 원문
SHA-256, 리다이렉트·페이지 수, 요약, 잘림 여부, chunk 수, 모델과 token
사용량이 포함된다.

### 웹 검색 강제

검색하고 근거 문서를 종합하려면 다음 endpoint를 사용한다. 검색어는 외부
검색엔진으로 전달되므로 API 키·개인정보·비공개 거래정보를 입력하지 않는다.

```bash
curl http://192.168.0.55:18082/v1/web-search \
  -H "Authorization: Bearer ${COINTRADE_LLM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "query":"SearXNG JSON API 보안 설정",
    "summary_style":"detailed",
    "language":"ko",
    "max_results":3,
    "time_range":"month"
  }'
```

작업이 끝나면 shell 변수에서 API 키를 제거한다.

```bash
unset COINTRADE_LLM_API_KEY
```

`time_range`는 생략하거나 `day`, `month`, `year` 중 하나를 쓴다. 응답에는
Qwen의 `answer`, `[S1]`과 연결되는 실제 `sources`, 검색·수집 수,
부분 성공 여부, 모델과 token 사용량이 포함된다. 검색 결과가 없으면 빈 출처와
결정론적인 “검색 결과 없음”을 반환하며 Qwen을 호출하지 않는다.

`/health/ready`의 전체 `status`는 API 키와 URL 요약 서비스 준비 상태를 뜻한다.
`web_search.available`은 loopback SearXNG TCP 연결 여부를 별도로 표시하므로,
전체 상태가 `ready`여도 이 값이 `false`이면 검색 endpoint는 사용할 수 없다.

감사 로그:

```bash
sudo tail -n 20 /var/lib/cointrade-url-summary/audit.jsonl
journalctl -u cointrade-url-summary.service --since today
journalctl -u cointrade-searxng.service --since today
```

SearXNG가 중단돼도 `/v1/url-summaries`는 계속 사용할 수 있다.
`/v1/web-search`와 `/v1/ask`의 검색 경로만 503을 반환한다. `/v1/ask`의
`chat`·`url` 경로는 계속 사용할 수 있다. 롤백할 때는 검색 서비스를 먼저
비활성화하고 URL 요약 unit에서 `URL_SUMMARY_SEARCH_*`와
`cointrade-searxng.service` 의존성을 제거한 뒤 URL 요약 서비스를
재시작한다.
