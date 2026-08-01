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
