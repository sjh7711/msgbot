# Messenger Bot — API2 레퍼런스 (상세판)

> 출처: [kbotdocs.dev — API2 Reference](https://kbotdocs.dev/reference/api2)
> 각 객체별 하위 문서에서 메서드 시그니처·파라미터·반환형을 추출해 정리한 문서다.

**API2**는 레거시 API보다 체계적인 구조의 내장 API로, JavaScript(RhinoJS/GraalJS) 기반 카카오톡 봇 작성의 표준 인터페이스다.

**시그니처 표기 규약**
- `param?: Type` → 선택적 인자 / `= 값` → 기본값
- `String | BigInt` → 둘 중 하나 허용
- 별도 표기가 없으면 객체의 메서드는 **static**(예: `BotManager.getBot(...)`), `Bot`/인자 객체(Message 등)는 **인스턴스 멤버**다.

---

## 목차

- [전역 함수](#전역-함수)
- [Bot — 봇 핵심](#bot--봇-핵심)
- [BotManager](#botmanager)
- [App](#app)
- [이벤트 인자 객체](#이벤트-인자-객체) — `Message` · `Command` · `Author` · `Image` · `SessionManager`
- [MediaSender — 미디어 전송](#mediasender--미디어-전송)
- [데이터 / 저장소](#데이터--저장소) — `Database` · `FileStream` · `AppData` · `Broadcast`
- [로깅](#로깅) — `Log` · `GlobalLog` · `console`
- [시스템 / 유틸](#시스템--유틸) — `Device` · `Http` · `Security`
- [이벤트](#이벤트) — `Event` 상수 + 콜백 인자
- [호환성](#호환성)

---

## 전역 함수

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `setTimeout(func, delay?, ...args)` | `Number` (id) | 지정 시간(ms) 경과 후 `func`를 1회 비동기 실행. |
| `setInterval(func, delay?, ...args)` | `Number` (id) | 지정 간격(ms)마다 `func`를 반복 비동기 실행. |
| `clearTimeout(id)` | `void` | `setTimeout()`이 반환한 id의 타임아웃을 취소. |
| `clearInterval(id)` | `void` | `setInterval()`이 반환한 id의 반복 작업을 취소. |
| `require(path)` | `Object` | 모듈 또는 `.json` 파일을 불러온다. |

> `func`는 `Function`, `delay`는 `Number`(ms), `...args`는 `func`에 전달할 인자다.

---

## Bot — 봇 핵심

카카오톡 봇을 추상화한 객체. **직접 생성 불가**, `BotManager.getCurrentBot()`으로 획득한다.

```js
const bot = BotManager.getCurrentBot();
```

### 메시지 전송 / 읽음

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `send(room: String \| BigInt, msg: String, packageName?: String = null)` | `Boolean` | 특정 방에 메시지 발신. 해당 방 세션 존재 여부를 반환. |
| `canReply(room: String \| BigInt, packageName?: String)` | `Boolean` | 특정 방에 메시지를 보낼 수 있는지 여부. |
| `markAsRead(room: String \| BigInt, packageName?: String)` | `Boolean` | 특정 방 메시지를 읽음 처리. 읽기 세션 발견 여부 반환. |

### 이벤트 리스너

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `addListener(eventName: String, listener: Function)` | `void` | 리스너를 목록 **끝**에 추가. |
| `on(eventName: String, listener: Function)` | `void` | `addListener`와 동일. |
| `prependListener(eventName: String, listener: Function)` | `void` | 리스너를 목록 **맨 앞**에 추가. |
| `off(eventName: String, listener?: Function)` | `void` | 리스너 제거. 인자 생략 시 마지막 리스너 제거. |
| `removeListener(eventName: String, listener?: Function)` | `void` | `off`와 동일. |
| `removeAllListeners(eventName: String)` | `void` | 해당 이벤트의 모든 리스너 제거. |
| `listeners(eventName: String)` | `Function[]` | 해당 이벤트의 모든 리스너 배열. |
| `getListenersMap()` | `Map<String, Function[]>` | 이벤트별 리스너 배열을 `키:값` map으로 반환. |

### 명령어 / 라이프사이클 / 메타

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `setCommandPrefix(prefix: String)` | `void` | 명령어 접두어 설정. (`command` 이벤트 트리거) |
| `getName()` | `String` | 봇 이름. |
| `getPower()` | `Boolean` | 스크립트 활성화 여부. |
| `setPower(power: Boolean)` | `void` | 스크립트 활성화 제어. |
| `getRootPath()` | `String` | 스크립트 프로젝트 디렉토리 경로. |
| `compile()` | `void` | 스크립트 컴파일. |
| `unload()` | `void` | 컴파일 전 상태로 언로드. |

---

## BotManager

`Bot` 객체를 관리/보조하는 객체. (static)

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `getCurrentBot()` | `Bot` | 호출 스크립트에 할당된 `Bot` 반환. |
| `getBot(botName: String)` | `Bot` | 이름으로 `Bot` 조회. |
| `getBotList()` | `Bot[]` | 모든 `Bot` 인스턴스 배열. |
| `getBotNames()` | `String[]` | 모든 `Bot` 이름 배열. |
| `getBotCount()` | `Number` | `Bot` 인스턴스 개수. |
| `getRooms(packageName?: String)` | `String[]` | 메시지 전송 가능한 방 이름 배열. |
| `getPower(botName: String)` | `Boolean` | 해당 봇 활성화 여부. |
| `setPower(botName: String, power: Boolean)` | `void` | 해당 봇 활성화 제어. |
| `isCompiled(botName: String)` | `Boolean` | 해당 봇 스크립트 컴파일 완료 여부. |
| `compile(botName: String, throwOnError?: Boolean = false)` | `Boolean` | 해당 봇 스크립트 컴파일. `throwOnError`면 에러 throw. |
| `compileAll()` | `void` | 모든 봇 스크립트 컴파일. |
| `prepare(botName: String, throwOnError?: Boolean = false)` | `Number` | 한 번도 컴파일된 적 없으면 컴파일. |
| `prepareAll(throwOnError?: Boolean = false)` | `Number` | 모든 봇에 `prepare()` 실행. 새로 컴파일된 개수 반환. |
| `unload(botName: String)` | `void` | 해당 봇 언로드. |

---

## App

봇 구동 앱에 관한 기능. (static)

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `getContext()` | `android.content.Context` | 앱의 Context 반환. |
| `isMainThread()` | `Boolean` | 호출 스레드가 UI 스레드인지 여부. |
| `runOnUiThread(task: Function, onComplete?: (error, result) => Any)` | `void` | UI 스레드에서 함수 실행. |
| `runOnBackgroundThread(task: Function, onComplete?: (error, result) => Any)` | `void` | 백그라운드 스레드에서 함수 실행. |
| `runDelayed(task: Function, delayMillis: Number)` | `void` | 지연 후 UI 스레드에서 함수 실행. |

---

## 이벤트 인자 객체

이벤트 콜백에 인자로 전달되는 객체들. **직접 생성 불가.**

### Message — `message` 이벤트

**속성**

| 속성 | 타입 | 설명 |
|------|------|------|
| `content` | `String` | 메시지 전체 내용. |
| `room` | `String` | 발신된 방 이름. |
| `channelId` | `BigInt` | 발신된 방 고유 ID. |
| `logId` | `BigInt` | 메시지 고유 ID. |
| `author` | `Author` | 발신자 정보. |
| `image` | `Image` | 포함된 이미지 정보. |
| `packageName` | `String` | 발신 메신저 앱 패키지명. |
| `isGroupChat` | `Boolean` | 그룹 채팅방 여부. |
| `isMultiChat` | `Boolean` | 듀얼 메신저 여부. |
| `isMention` | `Boolean` | 멘션 포함 여부. |
| `isDebugRoom` | `Boolean` | 디버깅 룸 여부. |

**메서드**

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `reply(content: String)` | `void` | 수신한 방에 메시지 발신. |
| `markAsRead()` | `void` | 수신한 방 알림을 읽음 처리. |

### Command — `command` 이벤트

`Message`의 모든 속성/메서드에 더해, 명령어 관련 속성을 추가로 가진다.

| 추가 속성 | 타입 | 설명 |
|-----------|------|------|
| `command` | `String` | 명령어 이름(접두어 제외). |
| `args` | `String[]` | 명령어 인자 배열. |

> 공통 속성: `content`, `room`, `channelId`, `logId`, `author`, `image`, `packageName`, `isGroupChat`, `isMultiChat`, `isMention`, `isDebugRoom` / 공통 메서드: `reply(content)`, `markAsRead()`.

### Author — 발신자

| 속성 | 타입 | 설명 |
|------|------|------|
| `name` | `String` | 발신자 이름. |
| `hash` | `String` | 발신자 고유 해시. **같은 방 내에서만 고유.** |
| `avatar` | `Image` | 발신자 프로필 이미지. |

### Image

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `getBase64()` | `String` | 이미지를 Base64 인코딩한 값. |
| `getBitmap()` | `android.graphics.Bitmap` | 이미지의 Bitmap 값. |

### SessionManager — `notificationPosted` 이벤트

타 메신저 앱 방의 세션을 수동 등록한다.

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `bindSession(room: String, action?: android.app.Notification.Action)` | `Boolean` | `room`에 채팅 도착 시 전송 가능하도록 바인딩. |
| `bindSession(packageName: String, room: String, action?: android.app.Notification.Action)` | `Boolean` | `packageName` 앱의 `room`에 대해 바인딩. |

> 반환값: `action` 인자와 앱이 자동 분석한 회신 action이 모두 non-null인지 여부.

---

## MediaSender — 미디어 전송

텍스트 외 미디어 파일 전송. (static)

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `send(room: Any, media: Any, timeoutMs?: Number = 25000)` | `Boolean` | 특정 방에 미디어 전송. 성공 여부 반환. |
| `getSupportedFormats()` | `String[]` | 지원 미디어 확장자 배열. |
| `getBaseDirectory()` | `String` | 전송할 미디어의 기본 디렉토리. |
| `getCachedUrls()` | `String[]` | 캐시에 저장된 모든 URL 배열. |
| `getCacheSize()` | `Number` | 캐시 크기(Byte). |
| `clearCache()` | `void` | 캐시 삭제. |
| `returnToAppNow()` | `Boolean` | 봇 앱으로 복귀하고 정상 수행 여부 반환. |

---

## 데이터 / 저장소

### Database — 스크립트 로컬 `/Database` 폴더 (static)

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `exists(fileName: String)` | `Boolean` | 파일 존재 여부. |
| `readString(fileName: String)` | `String` | 파일 내용을 문자열로 반환. |
| `readObject(fileName: String)` | `Object` | 파일 내용을 객체로 반환. **JSON 형식만 가능.** |
| `writeString(fileName: String, str: String)` | `void` | 문자열을 파일에 덮어씀(없으면 생성). |
| `writeObject(fileName: String, obj: Object)` | `void` | 객체를 JSON으로 변환해 덮어씀(없으면 생성). |

### FileStream — 내부 저장소 파일 (static)

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `read(path)` | `String` | 파일 내용을 문자열로 반환. |
| `readJSON(path)` | `Object` | 파일 내용을 JSON 객체로 파싱. |
| `write(path, data)` | `String` | 파일 덮어쓰기. 최종 내용 반환. |
| `writeJSON(path, json)` | `void` | 객체를 JSON으로 직렬화해 저장. |
| `append(path, data)` | `String` | 이어쓰기. 최종 내용 반환. |
| `save(path, data, append?: Boolean = false)` | `void` | 문자열 저장. `append=true`면 이어쓰기. |
| `saveJSON(path, json)` | `void` | 객체를 JSON으로 저장. |
| `create(path)` | `Boolean` | 새 파일 생성. |
| `createDir(path)` | `Boolean` | 폴더 생성. |
| `remove(path)` | `Boolean` | 파일 삭제. |
| `copyFile(src, dst)` | `Boolean` | 파일 복사. |
| `moveFile(src, dst)` | `Boolean` | 파일 이동. |
| `exists(path)` | `Boolean` | 경로 존재 여부. |
| `isFile(path)` | `Boolean` | 파일 여부. |
| `isDirectory(path)` | `Boolean` | 디렉토리 여부. |
| `listFiles(path)` | `String[]` | 디렉토리 내 항목 이름 배열(잘못된 경로면 `null`). |
| `getFileName(path)` | `String` | 경로에서 파일명 추출. |
| `getExtension(path)` | `String` | 확장자(없으면 `null`). |
| `getFileSize(path)` | `Number` | 파일 크기(Byte). 없거나 디렉토리면 `-1`. |
| `getParentPath(path)` | `String` | 부모 디렉토리(루트면 `null`). |
| `getSdcardPath()` | `String` | 내장 메모리 최상위 경로. |

### AppData — 앱 키-값 데이터 (static)

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `getString(key)` / `putString(key, string)` | `String` / `void` | 문자열 조회 / 저장. |
| `getInt(key)` / `putInt(key, integer)` | `Number` / `void` | 정수 조회 / 저장. |
| `getBoolean(key)` / `putBoolean(key, boolean)` | `Boolean` / `void` | 불리언 조회 / 저장. |
| `remove(key)` | `void` | 해당 키 삭제. |
| `clear()` | `void` | 전체 삭제. |

### Broadcast — 스크립트 간 데이터 교류 (static)

> ⚠️ Android의 Broadcast와는 무관한, 메신저봇 내부 스크립트 간 통신 메커니즘.

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `register(name: String, task: (value: Any) => Any)` | `void` | 브로드캐스트 리스너 등록. |
| `unregister(name: String, task: Function)` | `void` | 특정 리스너 제거. |
| `unregisterAll()` | `void` | 모든 리스너 제거. |
| `send(name: String, value: Any)` | `void` | 모든 스크립트로 전송. |
| `sendLocal(name: String, value: Any)` | `void` | 호출한 스크립트만 대상으로 전송. |
| `hasListeners(name: String)` | `Boolean` | 리스너 1개 이상 등록 여부. |
| `hasLocalListeners(name: String)` | `Boolean` | (로컬) 리스너 등록 여부. |
| `getListenerCount(name: String)` | `Number` | 리스너 개수. |
| `getAllEvents()` | `String[]` | 리스너 등록된 모든 브로드캐스트 이름. |
| `getLocalEvents()` | `String[]` | (로컬) 리스너 등록된 브로드캐스트 이름. |

---

## 로깅

### Log / GlobalLog — 스크립트 로그 / 글로벌 로그 (static)

두 객체는 동일한 메서드 집합을 가진다. 차이는 기록 대상(스크립트 로그 vs 글로벌 로그).

| 시그니처 | 설명 |
|----------|------|
| `i(data: String, showToast?: Boolean = false)` / `info(...)` / `log(...)` | 정보 로그. `showToast=true`면 토스트로도 출력. |
| `d(data: String, showToast?: Boolean = false)` / `debug(...)` | 디버그 로그. |
| `e(data: String, showToast?: Boolean = false)` / `error(...)` | 에러 로그. |
| `clear()` | 로그 전체 삭제. |

### console — 스크립트 로그 (static, 브라우저 유사 API)

| 시그니처 | 설명 |
|----------|------|
| `log(...args)` / `info(...args)` | 정보 로그. |
| `debug(...args)` | 디버그 로그. |
| `warn(...args)` | 주의 로그. |
| `error(...args)` | 에러 로그. |
| `assert(condition: Boolean, ...args)` | 조건이 `false`면 에러 로그. |
| `table(data)` | 데이터를 표 형태 텍스트로 출력. |
| `count(label?: String = "default")` / `countReset(label?)` | 호출 횟수 기록 / 초기화. |
| `time(label?)` / `timeLog(label?, ...args)` / `timeEnd(label?)` | 타이머 시작 / 중간 기록 / 종료. |
| `clear()` | 로그 전체 삭제. |

---

## 시스템 / 유틸

### Device — 기기/환경 정보 (static)

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `getModelName()` / `getPhoneModel()` | `String` | 모델명. |
| `getPhoneBrand()` | `String` | 브랜드명. |
| `getAndroidVersionName()` | `String` | 안드로이드 버전 이름. |
| `getAndroidVersionCode()` | `Number` | 버전 코드. |
| `getApiLevel()` | `Number` | API Level. |
| `getBuild()` | `android.os.Build` | Build 객체. |
| `getTotalMemory()` | `Number` | 총 메모리(Byte). |
| `getFreeMemory()` | `Number` | 사용 가능 메모리. |
| `getMaxMemory()` | `Number` | 최대 메모리(Byte). |
| `getTotalStorageSpace(path)` / `getFreeStorageSpace(path)` | `Number` | 파티션 전체 / 미할당 공간(Byte). |
| `getBatteryLevel()` | `Number` | 배터리 잔량(%). |
| `getBatteryStatus()` / `getBatteryHealth()` | `Number` | 배터리 상태 / 건강 상수. |
| `getBatteryTemp()` | `Number` | 배터리 온도(˚C). |
| `getBatteryTemperature()` | `Number` | 배터리 온도(temp×10). |
| `getBatteryVoltage()` | `Number` | 배터리 전압(mV). |
| `getBatteryIntent()` | `android.content.Intent` | Battery intent. |
| `isCharging()` | `Boolean` | 충전 중 여부. |
| `getPlugType()` | `String` | 충전기 타입. |
| `isPowerSaveMode()` | `Boolean` | 절전 모드 여부. |
| `isScreenOn()` | `Boolean` | 화면 켜짐 여부. |
| `getConnectedNetworkType()` | `String` | 연결된 네트워크 타입. |
| `getWifiName()` | `String` | 연결된 WiFi 이름(위치 권한 필요). |
| `acquireWakeLock(levelAndFlags: Number, tag?: String, timeout?: Number)` | `void` | Wake lock 획득. ⚠️ 장시간 유지 시 배터리 저하. |
| `releaseWakeLock(flags?: Number = 0)` | `void` | Wake lock 해제. |

### Http — 웹 요청 (static, jsoup 기반)

| 시그니처 | 반환 | 설명 |
|----------|------|------|
| `request(url: String, callBack: Function)` | `void` | 비동기 요청(URL). |
| `request(option: Object, callBack: Function)` | `void` | 비동기 요청(옵션 객체). |
| `requestSync(url: String)` | `org.jsoup.nodes.Document` | 동기 요청(URL). |
| `requestSync(option: Object)` | `org.jsoup.nodes.Document` | 동기 요청(옵션 객체). |

> 콜백 시그니처: `(error: java.lang.Exception?, response: org.jsoup.Connection.Response?, doc: org.jsoup.nodes.Document?) => Any`

### Security — 암호화/해시/인코딩 (static)

**대칭 암복호화**

| 시그니처 | 설명 |
|----------|------|
| `aesEncode(key, initVector, value)` / `aesDecode(key, initVector, value)` | AES 암/복호화. |
| `seedEncode(key, value)` / `seedDecode(key, value)` | SEED 암/복호화. |
| `ariaEncode(key, value)` / `ariaDecode(key, value)` | ARIA 암/복호화. |
| `ariaEncodeRaw(key, value)` → `byte[]` / `ariaDecodeRaw(key, raw)` | ARIA raw 바이트 암/복호화. |
| `desEncode(key, value)` / `desDecode(key, value)` | DES 암/복호화. |
| `des3Encode(key, value)` / `des3Decode(key, value)` | DES3 암/복호화. |
| `desKey()` / `getDesKey()` | DES 보조키 생성. |
| `rc4Encode(key, value)` / `rc4Decode(key, value)` | RC4 암/복호화. |
| `eccEncode(key, value)` / `eccDecode(key, value)` | ECC 암/복호화. (encode 미구현) |

**해시 / 인코딩 / ID** (모두 `String` 반환)

| 시그니처 | 설명 |
|----------|------|
| `md2(value)` / `md5(value)` / `md55(value)` | MD 계열 해시. |
| `sha(value)` / `sha256(value)` / `sha384(value)` / `sha512(value)` | SHA 계열 해시. |
| `sha3_224 / sha3_256 / sha3_384 / sha3_512 (value)` | SHA3 계열 해시. |
| `hashCode(value)` | 해시 코드. |
| `base32Encode/Decode(value)`, `base64Encode/Decode(value)` | Base32/64 인코딩. |
| `uuid()` / `uuidv7()` / `ulid()` | UUID / UUIDv7 / ULID 생성. |

---

## 이벤트

리스너 등록 시 `Event` 객체의 **상수**를 사용한다.

```js
bot.addListener(Event.MESSAGE, function(msg) { /* msg: Message */ });
```

| Event 상수 | 문자열 값 | 콜백 인자 | 발생 시점 |
|------------|-----------|-----------|-----------|
| `Event.MESSAGE` | `"message"` | `Message` | 메시지 수신. |
| `Event.COMMAND` | `"command"` | `Command` | 접두어로 시작하는 명령어 수신. |
| `Event.NOTIFICATION_POSTED` | `"notificationPosted"` | `SessionManager` | 알림 발생. |
| `Event.NOTIFICATION_REMOVED` | `"notificationRemoved"` | — | 알림 사라짐. |
| `Event.TICK` | `"tick"` | — | 매 틱(1초)마다. |
| `Event.BATTERY_LEVEL_CHANGED` | `"batteryLevelChanged"` | — | 배터리 잔량 변화. |
| `Event.START_COMPILE` | `"startCompile"` | — | 컴파일 시작 직전. |
| `Event.Activity.CREATE` | `"activityCreate"` | `activity` | Activity `onCreate()`. |
| `Event.Activity.START` | `"activityStart"` | `activity` | `onStart()`. |
| `Event.Activity.RESUME` | `"activityResume"` | `activity` | `onResume()`. |
| `Event.Activity.PAUSE` | `"activityPause"` | `activity` | `onPause()`. |
| `Event.Activity.STOP` | `"activityStop"` | `activity` | `onStop()`. |
| `Event.Activity.RESTART` | `"activityRestart"` | `activity` | `onRestart()`. |
| `Event.Activity.DESTROY` | `"activityDestroy"` | `activity` | `onDestroy()`. |
| `Event.Activity.BACK_PRESSED` | `"activityBackPressed"` | `activity` | `onBackPressed()`. |

---

## 호환성

객체/멤버에 따라 지원 런타임이 다르다. 인자 객체(`Author`, `Image`, `SessionManager` 등) 기준 대략:

- **메신저봇R** 4.0+
- **StarLight** 0.3.5a+
- **채팅 자동응답 봇** 0.1.0a+ (`SessionManager` 등 일부)

> 정확한 버전별 지원은 각 멤버의 공식 문서 페이지를 확인할 것: <https://kbotdocs.dev/reference/api2>