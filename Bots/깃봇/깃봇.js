var bot = BotManager.getCurrentBot();

// =====================================================================
// 깃봇 — GitHub 저장소의 봇 소스를 태블릿에 반영 ("!깃풀")
//
//  PC 에서 작업 → git push → 카톡에서 !깃풀 → 태블릿 반영 + 재컴파일.
//
//  git 바이너리를 쓰지 않는다. GitHub API 로 파일별 blob SHA 를 받아
//  로컬 파일의 git blob SHA(sha1("blob "+길이+"\0"+내용))와 비교해
//  "바뀐 파일만" raw.githubusercontent 에서 내려받는다.
//    · 다운로드는 브랜치가 아니라 커밋 SHA 로 고정 → 받는 도중 새 푸시가
//      들어와도 여러 커밋이 섞이지 않는다.
//    · 받은 바이트의 blob SHA 를 다시 확인해 무결성 검증 후 .part → rename.
//
//  안전장치
//    · 동기화 범위는 Bots/ 와 lib/ 뿐. 레포에 없는 태블릿 파일은 절대 지우지 않는다
//      (userhash.db, quiz.db, log.json, qwen_key 등 런타임 데이터 보호).
//    · 이미 존재하는 bot.json 은 덮어쓰지 않는다. scriptPower(전원 on/off)가
//      런타임에 앱이 쓰는 값이라, 덮으면 돌아가던 봇이 조용히 꺼진다.
//    · 마지막 pull 시점의 SHA 를 .gitpull.json 에 기록해 두고, 로컬 파일이
//      그 SHA 와 다르면 "태블릿에서 직접 수정됨"으로 보고 건드리지 않는다
//      (!깃풀 강제 로만 덮어씀).
//    · 덮어쓰기 전 원본을 msgbot_backups/gitpull_<시각>/ 에 복사 → !깃롤백.
//    · 컴파일 실패한 봇은 해당 파일을 자동 롤백하고 다시 컴파일한다.
//
//  한계: 새 봇 폴더는 앱이 인식하지 못하므로 !깃풀 만으로 추가되지 않는다.
//        앱에서 같은 이름의 봇을 한 번 만들어 주면 그 다음부터 내용이 채워진다.
//        (이때 앱이 만드는 기본 골격 .js 는 충돌로 보지 않고 덮어쓴다 —
//         isFreshBotScaffold 참고. 예전엔 이것 때문에 새 봇이 빈 골격인 채로
//         남아 !깃풀 강제 를 써야 했다.)
//
//  명령: !깃확인 / !깃풀 [강제] / !깃롤백 / !깃봇
//
//  메시지 수신: ChatManager 의 broadcast 큐 구독. ChatManager 가 켜져 있어야 동작.
//
//  RhinoJS-safe: var / function 만.
// =====================================================================

var BOT_NAME = "깃봇";
var WORKER_NAME = "GIT_BOT_WORKER";

// ── 설정 ─────────────────────────────────────────────────────────────
var REPO_OWNER = "sjh7711";
var REPO_NAME  = "msgbot";
var BRANCH     = "main";

// 실행 권한. 비워두면 누구나/어디서나 실행 가능하다.
// !깃봇 이 본인 hash 와 방 이름을 알려주므로 그대로 복사해 넣으면 된다.
var ALLOW_HASHES = [];   // 예: ["abcd1234..."]
var ALLOW_ROOMS  = [];   // 예: ["봇테스트방"]

var SD          = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath();
var MSGBOT_DIR  = SD + "/msgbot";
var MANIFEST    = MSGBOT_DIR + "/.gitpull.json";
var BACKUP_ROOT = SD + "/msgbot_backups";

var SYNC_PREFIXES = ["Bots/", "lib/"];   // 이 접두사로 시작하는 경로만 동기화
var HTTP_TIMEOUT  = 20000;
var UA            = "msgbot-gitbot";     // GitHub API 는 User-Agent 없으면 403

var KST = java.util.TimeZone.getTimeZone("Asia/Seoul");

// 카카오톡 "더보기" 접기용 제로폭 공백 (ES5 안전: repeat() 대신 Array.join)
var LONG_MSG_SPACER = new Array(501).join("\u200b");

// =====================================================================
// 기본 유틸
// =====================================================================

function trim(s) { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, ""); }

function newByteArray(n) { return java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, n); }

function nowStr(pattern) {
  var f = new java.text.SimpleDateFormat(pattern);
  f.setTimeZone(KST);
  return String(f.format(new java.util.Date()));
}

function fileOf(relPath) { return new java.io.File(MSGBOT_DIR + "/" + relPath); }

function readAllBytes(is) {
  var bos = new java.io.ByteArrayOutputStream();
  var buf = newByteArray(65536);
  var n;
  while ((n = is.read(buf)) !== -1) if (n > 0) bos.write(buf, 0, n);
  return bos.toByteArray();
}

function bytesToStr(bytes) { return String(new java.lang.String(bytes, "UTF-8")); }

function toHex(bytes) {
  var sb = new java.lang.StringBuilder();
  for (var i = 0; i < bytes.length; i++) {
    var v = bytes[i] & 0xFF;
    if (v < 16) sb.append("0");
    sb.append(java.lang.Integer.toHexString(v));
  }
  return String(sb.toString());
}

// git blob SHA-1 = sha1("blob " + 바이트길이 + "\0" + 내용)
function blobHeader(len) {
  var head = new java.lang.String("blob " + len).getBytes("UTF-8");
  var out = newByteArray(head.length + 1);
  java.lang.System.arraycopy(head, 0, out, 0, head.length);
  out[head.length] = 0;   // 구분자 NUL
  return out;
}

function blobShaOfBytes(bytes) {
  var md = java.security.MessageDigest.getInstance("SHA-1");
  md.update(blobHeader(bytes.length));
  md.update(bytes);
  return toHex(md.digest());
}

// 큰 파일(apk/db)까지 메모리에 올리지 않도록 스트리밍으로 해시
function blobShaOfFile(f) {
  if (!f.exists() || !f.isFile()) return null;
  var is = null;
  try {
    var md = java.security.MessageDigest.getInstance("SHA-1");
    md.update(blobHeader(f.length()));
    is = new java.io.BufferedInputStream(new java.io.FileInputStream(f));
    var buf = newByteArray(65536);
    var n;
    while ((n = is.read(buf)) !== -1) if (n > 0) md.update(buf, 0, n);
    return toHex(md.digest());
  } catch (e) {
    return null;
  } finally {
    if (is) try { is.close(); } catch (_) {}
  }
}

function copyFile(srcPath, dstPath) {
  var is = null, os = null;
  try {
    var sf = new java.io.File(srcPath);
    if (!sf.exists()) return false;
    var df = new java.io.File(dstPath);
    var parent = df.getParentFile();
    if (parent != null) parent.mkdirs();
    is = new java.io.BufferedInputStream(new java.io.FileInputStream(sf));
    os = new java.io.BufferedOutputStream(new java.io.FileOutputStream(df));
    var buf = newByteArray(65536);
    var n;
    while ((n = is.read(buf)) !== -1) if (n > 0) os.write(buf, 0, n);
    return true;
  } catch (e) {
    return false;
  } finally {
    if (is) try { is.close(); } catch (_) {}
    if (os) try { os.close(); } catch (_) {}
  }
}

// .part 로 쓴 뒤 rename. (/sdcard 는 대상이 있으면 rename 이 실패하므로 먼저 지운다)
function writeBytesAtomic(absPath, bytes) {
  var os = null;
  try {
    var f = new java.io.File(absPath);
    var parent = f.getParentFile();
    if (parent != null) parent.mkdirs();
    var tmp = new java.io.File(absPath + ".part");
    os = new java.io.FileOutputStream(tmp);
    os.write(bytes);
    os.flush();
    try { os.close(); } catch (_) {}
    os = null;
    if (f.exists()) f["delete"]();
    if (!tmp.renameTo(f)) { try { tmp["delete"](); } catch (_) {} return false; }
    return true;
  } catch (e) {
    return false;
  } finally {
    if (os) try { os.close(); } catch (_) {}
  }
}

function readTextFile(path) {
  var f = new java.io.File(path);
  if (!f.exists()) return null;
  var is = null;
  try {
    is = new java.io.FileInputStream(f);
    return bytesToStr(readAllBytes(is));
  } catch (e) {
    return null;
  } finally {
    if (is) try { is.close(); } catch (_) {}
  }
}

function writeTextFile(path, text) {
  return writeBytesAtomic(path, new java.lang.String(text).getBytes("UTF-8"));
}

// =====================================================================
// HTTP (GitHub)
// =====================================================================

function httpGet(url, accept, wantBytes) {
  var conn = null;
  try {
    conn = new java.net.URL(url).openConnection();
    conn.setRequestMethod("GET");
    conn.setRequestProperty("User-Agent", UA);
    if (accept) conn.setRequestProperty("Accept", accept);
    conn.setConnectTimeout(HTTP_TIMEOUT);
    conn.setReadTimeout(HTTP_TIMEOUT);

    var code = conn.getResponseCode();
    var stream = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
    var bytes = stream ? readAllBytes(stream) : newByteArray(0);
    if (stream) try { stream.close(); } catch (_) {}

    if (code < 200 || code >= 300) {
      var detail = bytesToStr(bytes);
      if (code === 403 && detail.indexOf("rate limit") !== -1) {
        return { error: "GitHub API 호출 한도 초과. 잠시 뒤 다시 시도하세요." };
      }
      if (code === 404) return { error: "HTTP 404 — 경로/브랜치를 확인하세요." };
      return { error: "HTTP " + code + ": " + detail.slice(0, 160) };
    }
    return wantBytes ? { bytes: bytes } : { text: bytesToStr(bytes) };
  } catch (e) {
    return { error: "네트워크 오류: " + ((e && e.message) ? String(e.message) : String(e)) };
  } finally {
    try { if (conn) conn.disconnect(); } catch (_) {}
  }
}

function apiUrl(suffix) {
  return "https://api.github.com/repos/" + REPO_OWNER + "/" + REPO_NAME + suffix;
}

// 경로의 각 구간을 퍼센트 인코딩 (한글 봇 이름 · 공백 포함 파일명 대응)
function encodePath(p) {
  var parts = String(p).split("/");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    out.push(String(java.net.URLEncoder.encode(parts[i], "UTF-8")).replace(/\+/g, "%20"));
  }
  return out.join("/");
}

function rawUrl(commitSha, path) {
  return "https://raw.githubusercontent.com/" + REPO_OWNER + "/" + REPO_NAME +
         "/" + commitSha + "/" + encodePath(path);
}

var GH_ACCEPT = "application/vnd.github+json";

// 브랜치의 HEAD 커밋 SHA
function ghHeadSha() {
  var r = httpGet(apiUrl("/git/ref/heads/" + BRANCH), GH_ACCEPT, false);
  if (r.error) return r;
  try {
    var j = JSON.parse(r.text);
    if (!j.object || !j.object.sha) return { error: "ref 응답에 sha 가 없습니다." };
    return { sha: String(j.object.sha) };
  } catch (e) { return { error: "ref 응답 JSON 파싱 실패" }; }
}

// 커밋 SHA 기준 전체 파일 목록 (경로 + blob SHA)
function ghTree(commitSha) {
  var r = httpGet(apiUrl("/git/trees/" + commitSha + "?recursive=1"), GH_ACCEPT, false);
  if (r.error) return r;
  try {
    var j = JSON.parse(r.text);
    if (!j.tree) return { error: "tree 응답에 tree 가 없습니다." };
    var files = [];
    for (var i = 0; i < j.tree.length; i++) {
      var e = j.tree[i];
      if (String(e.type) === "blob") files.push({ path: String(e.path), sha: String(e.sha) });
    }
    return { files: files, truncated: !!j.truncated };
  } catch (e) { return { error: "tree 응답 JSON 파싱 실패" }; }
}

// 커밋 메시지 (실패해도 무해 — 보고용)
function ghCommitInfo(commitSha) {
  var r = httpGet(apiUrl("/git/commits/" + commitSha), GH_ACCEPT, false);
  if (r.error) return null;
  try {
    var j = JSON.parse(r.text);
    return {
      message: trim(String(j.message || "")).split("\n")[0],
      date: (j.author && j.author.date) ? String(j.author.date).replace("T", " ").replace("Z", "") : ""
    };
  } catch (e) { return null; }
}

// =====================================================================
// 매니페스트 (.gitpull.json) — 마지막 pull 시점의 파일별 SHA
// =====================================================================

function loadManifest() {
  var text = readTextFile(MANIFEST);
  if (text) {
    try {
      var j = JSON.parse(text);
      if (j && j.files) return { commit: String(j.commit || ""), at: String(j.at || ""), files: j.files };
    } catch (e) {}
  }
  return { commit: "", at: "", files: {} };
}

function saveManifest(m) {
  return writeTextFile(MANIFEST, JSON.stringify(m, null, 2));
}

// =====================================================================
// 동기화 범위 / 계획
// =====================================================================

function inScope(path) {
  for (var i = 0; i < SYNC_PREFIXES.length; i++) {
    if (path.indexOf(SYNC_PREFIXES[i]) === 0) return true;
  }
  return false;
}

// 레포에 섞여 들어간 런타임 찌꺼기는 배포하지 않는다
function isExcluded(path) {
  var base = path.substring(path.lastIndexOf("/") + 1);
  if (base === "log.json") return true;
  if (/\.bak$/.test(base)) return true;
  if (/\.db$/.test(base) || /\.db-journal$/.test(base)) return true;
  if (path.indexOf("/message/") !== -1) return true;
  return false;
}

function isBotJson(path) { return /(^|\/)bot\.json$/.test(path); }

// =====================================================================
// 앱이 만든 기본 스크립트(골격) 예외
//
//  깃봇은 새 봇을 앱에 등록할 수 없어서, 새 봇은 반드시 앱에서 먼저 만들어야
//  한다. 그런데 그때 앱이 주석만 있는 골격 .js 를 만들어 둔다. 이 파일은
//  매니페스트에 없으므로 아래 판정에서 "태블릿에서 직접 작성한 코드"로 분류돼
//  충돌 처리되고, 깃풀이 영영 건너뛴다.
//  실제로 야민정음봇이 이것 때문에 빈 골격인 채로 컴파일됐다(2026-08-02).
//
//  그래서 다음 두 조건을 모두 만족하면 충돌로 보지 않고 덮어쓴다.
//    ① 이 봇에 대해 매니페스트가 추적 중인 파일이 하나도 없다 (= 깃봇이 처음 다루는 봇)
//    ② 로컬 파일이 앱 골격의 특징을 갖고 있다 (주석 마커 + 작은 크기)
//  ①이 있어서, 깃봇이 한 번이라도 배포한 봇의 로컬 수정은 여전히 보호된다.
// =====================================================================

// 앱 골격에만 있는 주석 문구 (사람이 직접 쓸 일이 없는 문자열)
var APP_TEMPLATE_MARKS = [
  "(string) msg.content:",
  "msg.author.avatar.getBase64()",
  "(boolean) msg.isDebugRoom"
];
var APP_TEMPLATE_MAX = 8000;   // 앱 골격은 3KB 안팎. 실제 봇 코드는 이보다 크다.

function looksLikeAppTemplate(absPath) {
  var text = readTextFile(absPath);
  if (text === null || text.length > APP_TEMPLATE_MAX) return false;
  var hits = 0;
  for (var i = 0; i < APP_TEMPLATE_MARKS.length; i++) {
    if (text.indexOf(APP_TEMPLATE_MARKS[i]) !== -1) hits++;
  }
  return hits >= 2;
}

// 이 봇에 대해 매니페스트가 추적 중인 파일이 하나라도 있는가
function botIsTracked(manifestFiles, botName) {
  var prefix = "Bots/" + botName + "/";
  for (var p in manifestFiles) {
    if (manifestFiles.hasOwnProperty(p) && p.indexOf(prefix) === 0) return true;
  }
  return false;
}

// "깃봇이 처음 다루는 봇의, 앱이 만든 골격 파일" 인가
function isFreshBotScaffold(rel, manifestFiles) {
  var b = botOfPath(rel);
  if (!b) return false;                              // Bots/<봇>/ 아래만 해당
  if (botIsTracked(manifestFiles, b)) return false;  // 이미 다룬 봇 → 로컬 수정 보호
  return looksLikeAppTemplate(String(fileOf(rel).getAbsolutePath()));
}

// 계획 수립. manifest 는 "최신 확인된 파일"에 대해 그 자리에서 갱신된다.
function buildPlan(remoteFiles, manifest) {
  var plan = { create: [], update: [], scaffold: [], conflict: [], keptBotJson: [], same: 0, removed: [] };
  var seen = {};

  for (var i = 0; i < remoteFiles.length; i++) {
    var rf = remoteFiles[i];
    if (!inScope(rf.path) || isExcluded(rf.path)) continue;
    seen[rf.path] = true;

    var local = blobShaOfFile(fileOf(rf.path));

    if (local === rf.sha) {           // 이미 최신 — 추적만 갱신
      plan.same++;
      manifest.files[rf.path] = rf.sha;
      continue;
    }
    if (local === null) {             // 태블릿에 없는 파일 → 새로 생성
      plan.create.push(rf);
      continue;
    }
    if (isBotJson(rf.path)) {         // 전원 상태(scriptPower) 보존
      plan.keptBotJson.push(rf.path);
      continue;
    }
    var base = manifest.files[rf.path];
    if (base && base === local) {
      plan.update.push(rf);           // 마지막 pull 이후 로컬 변경 없음 → 안전
    } else if (!base && isFreshBotScaffold(rf.path, manifest.files)) {
      plan.scaffold.push(rf);         // 앱이 만든 골격 → 덮어써도 잃을 게 없다
    } else {
      plan.conflict.push({
        path: rf.path, sha: rf.sha,
        reason: base ? "태블릿에서 수정됨" : "추적 이력 없음"
      });
    }
  }

  for (var p in manifest.files) {
    if (manifest.files.hasOwnProperty(p) && !seen[p]) plan.removed.push(p);
  }
  return plan;
}

function planTargets(plan, force) {
  var t = [];
  for (var i = 0; i < plan.create.length; i++) t.push(plan.create[i]);
  for (var j = 0; j < plan.update.length; j++) t.push(plan.update[j]);
  // 앱 골격 덮어쓰기는 강제 옵션 없이도 적용한다 (잃을 내용이 없으므로)
  for (var s = 0; s < plan.scaffold.length; s++) t.push(plan.scaffold[s]);
  if (force) {
    for (var k = 0; k < plan.conflict.length; k++) {
      t.push({ path: plan.conflict[k].path, sha: plan.conflict[k].sha });
    }
  }
  return t;
}

// =====================================================================
// 적용 (다운로드 → 검증 → 백업 → 원자적 쓰기)
// =====================================================================

function applyTargets(targets, commitSha, manifest) {
  var stamp = nowStr("yyyyMMdd_HHmmss");
  var backupDir = BACKUP_ROOT + "/gitpull_" + stamp;
  // 같은 초에 두 번 pull 하면 폴더 이름이 겹친다. 이미 있던 폴더면 아래 정리 단계에서
  // 건드리지 않는다 — 앞선 pull 의 백업/매니페스트를 지워 롤백을 깨뜨리기 때문.
  var dirExisted = new java.io.File(backupDir).exists();
  new java.io.File(backupDir).mkdirs();
  if (!dirExisted) copyFile(MANIFEST, backupDir + "/.gitpull.json");   // 롤백 시 매니페스트도 되돌린다

  var replaced = [], created = [], failed = [];

  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var r = httpGet(rawUrl(commitSha, t.path), null, true);
    if (r.error) { failed.push(t.path + " — " + r.error); continue; }

    if (blobShaOfBytes(r.bytes) !== t.sha) {   // 받은 내용이 기대한 blob 이 아님
      failed.push(t.path + " — 내용 검증 실패(SHA 불일치)");
      continue;
    }

    var f = fileOf(t.path);
    var existed = f.exists();
    if (existed && !copyFile(String(f.getAbsolutePath()), backupDir + "/" + t.path)) {
      failed.push(t.path + " — 백업 실패로 건너뜀");
      continue;
    }
    if (!writeBytesAtomic(String(f.getAbsolutePath()), r.bytes)) {
      failed.push(t.path + " — 파일 쓰기 실패");
      continue;
    }
    manifest.files[t.path] = t.sha;
    if (existed) replaced.push(t.path); else created.push(t.path);
  }

  var applied = replaced.concat(created);
  if (applied.length) {
    writeTextFile(backupDir + "/rollback.json", JSON.stringify({
      at: nowStr("yyyy-MM-dd HH:mm:ss"),
      commit: commitSha,
      replaced: replaced,
      created: created
    }, null, 2));
  } else if (!dirExisted) {
    // 이번 호출에서 만든 빈 백업 폴더만 치운다
    try { new java.io.File(backupDir + "/.gitpull.json")["delete"](); } catch (_) {}
    try { new java.io.File(backupDir)["delete"](); } catch (_) {}
  }
  return { replaced: replaced, created: created, applied: applied, failed: failed, backupDir: backupDir };
}

// =====================================================================
// 재컴파일
// =====================================================================

function knownBotNames() {
  try {
    var arr = BotManager.getBotNames();
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(String(arr[i]));
    return out;
  } catch (e) { return []; }
}

function botOfPath(path) {
  var m = /^Bots\/([^\/]+)\//.exec(path);
  return m ? m[1] : null;
}

// lib/xxx.js 를 require 하는 봇 찾기 (봇 소스에 파일명이 등장하는지로 판정)
function botsUsingLibs(libBaseNames) {
  var names = knownBotNames();
  var hit = [];
  for (var i = 0; i < names.length; i++) {
    var dir = new java.io.File(MSGBOT_DIR + "/Bots/" + names[i]);
    if (!dir.isDirectory()) continue;
    var kids = dir.listFiles();
    if (!kids) continue;
    var found = false;
    for (var j = 0; j < kids.length && !found; j++) {
      if (!String(kids[j].getName()).match(/\.js$/)) continue;
      var src = readTextFile(String(kids[j].getAbsolutePath()));
      if (!src) continue;
      for (var k = 0; k < libBaseNames.length; k++) {
        if (src.indexOf(libBaseNames[k]) !== -1) { found = true; break; }
      }
    }
    if (found) hit.push(names[i]);
  }
  return hit;
}

// 바뀐 경로들 → 재컴파일 대상 봇 이름 (앱이 모르는 새 봇은 제외)
function botsToRecompile(paths) {
  var set = {}, libs = [];
  for (var i = 0; i < paths.length; i++) {
    var b = botOfPath(paths[i]);
    if (b) { set[b] = true; continue; }
    if (paths[i].indexOf("lib/") === 0) libs.push(paths[i].substring(4));
  }
  if (libs.length) {
    var users = botsUsingLibs(libs);
    for (var u = 0; u < users.length; u++) set[users[u]] = true;
  }
  var known = knownBotNames(), unknown = [], targets = [];
  for (var name in set) {
    if (!set.hasOwnProperty(name)) continue;
    if (known.indexOf(name) === -1) unknown.push(name); else targets.push(name);
  }
  // 순서: 일반 봇 → ChatManager(메시지 버스) → 깃봇(자기 자신)은 호출부에서 마지막에.
  targets.sort(function (a, b) {
    var ra = (a === BOT_NAME) ? 2 : (a === "ChatManager" ? 1 : 0);
    var rb = (b === BOT_NAME) ? 2 : (b === "ChatManager" ? 1 : 0);
    return ra - rb;
  });
  return { targets: targets, unknown: unknown };
}

// 컴파일 실패 → 그 봇 파일만 백업에서 되돌리고 재컴파일 (문법 오류로 봇이 죽는 것 방지)
function rollbackBotFiles(name, appliedPaths, backupDir) {
  var restored = 0;
  for (var i = 0; i < appliedPaths.length; i++) {
    if (botOfPath(appliedPaths[i]) !== name) continue;
    var backup = backupDir + "/" + appliedPaths[i];
    if (new java.io.File(backup).exists()) {
      if (copyFile(backup, MSGBOT_DIR + "/" + appliedPaths[i])) restored++;
    } else {
      try { if (fileOf(appliedPaths[i])["delete"]()) restored++; } catch (_) {}
    }
  }
  return restored;
}

function compileBots(names, appliedPaths, backupDir, manifest) {
  var lines = [], rolledBack = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var ok = false, err = "";
    try { ok = !!BotManager.compile(name, false); }
    catch (e) { ok = false; err = (e && e.message) ? String(e.message) : String(e); }

    if (ok) { lines.push("  ✅ " + name); continue; }

    var n = rollbackBotFiles(name, appliedPaths, backupDir);
    var reOk = false;
    try { reOk = !!BotManager.compile(name, false); } catch (e2) {}
    // 롤백했으므로 매니페스트에서도 해당 봇 항목을 지워 다음 pull 때 다시 시도하게 한다
    for (var j = 0; j < appliedPaths.length; j++) {
      if (botOfPath(appliedPaths[j]) === name) delete manifest.files[appliedPaths[j]];
    }
    rolledBack.push(name);
    lines.push("  ❌ " + name + " 컴파일 실패" + (err ? " (" + err + ")" : "") +
               " → 파일 " + n + "개 롤백, 재컴파일 " + (reOk ? "성공" : "실패"));
  }
  return { lines: lines, rolledBack: rolledBack };
}

// =====================================================================
// 보고 텍스트
// =====================================================================

function listBlock(title, arr, limit) {
  if (!arr || !arr.length) return [];
  var out = [];
  if (title) out.push(title);
  var show = Math.min(arr.length, limit || 20);
  for (var i = 0; i < show; i++) out.push("  " + arr[i]);
  if (arr.length > show) out.push("  ... 외 " + (arr.length - show) + "개");
  return out;
}

function pathsOf(items) {
  var out = [];
  for (var i = 0; i < items.length; i++) out.push(items[i].path);
  return out;
}

function conflictLines(conflicts) {
  var out = [];
  for (var i = 0; i < conflicts.length; i++) {
    out.push(conflicts[i].path + " (" + conflicts[i].reason + ")");
  }
  return out;
}

// 길면 첫 줄 뒤에 제로폭 공백을 넣어 카카오톡이 "더보기"로 접게 한다.
function withSpacer(text) {
  if (text.length <= 500) return text;
  var nl = text.indexOf("\n");
  if (nl === -1) return text + LONG_MSG_SPACER;
  return text.substring(0, nl) + LONG_MSG_SPACER + text.substring(nl);
}

// =====================================================================
// 명령: 공통 조회 (HEAD → tree → 계획)
// =====================================================================

function fetchPlan() {
  var head = ghHeadSha();
  if (head.error) return { error: head.error };

  var tree = ghTree(head.sha);
  if (tree.error) return { error: tree.error };

  var manifest = loadManifest();
  var plan = buildPlan(tree.files, manifest);
  return { commit: head.sha, plan: plan, manifest: manifest, truncated: tree.truncated };
}

function commitLine(commitSha) {
  var info = ghCommitInfo(commitSha);
  var line = "커밋 " + commitSha.substring(0, 7);
  if (info && info.message) line += " — " + info.message;
  return line;
}

// =====================================================================
// 명령: !깃확인
// =====================================================================

function handleCheck(room) {
  var r = fetchPlan();
  if (r.error) { bot.send(room, "[깃확인] ⚠ " + r.error); return; }

  var p = r.plan;
  var changed = p.create.length + p.update.length + p.scaffold.length;
  var lines = ["[깃확인] " + commitLine(r.commit)];

  if (!changed && !p.conflict.length) {
    lines.push("이미 최신입니다. (추적 " + p.same + "개)");
  } else {
    lines.push("적용 대상 " + changed + "개 / 최신 " + p.same + "개");
  }
  lines = lines.concat(listBlock("[수정]", pathsOf(p.update), 20));
  lines = lines.concat(listBlock("[신규]", pathsOf(p.create), 20));
  lines = lines.concat(listBlock("[앱 골격 덮어쓰기]", pathsOf(p.scaffold), 10));
  lines = lines.concat(listBlock("[충돌 — 건너뜀]", conflictLines(p.conflict), 10));
  lines = lines.concat(listBlock("[bot.json 보존]", p.keptBotJson, 5));
  lines = lines.concat(listBlock("[레포에서 삭제됨 — 태블릿 유지]", p.removed, 10));

  if (p.conflict.length) lines.push("\n충돌 파일까지 덮어쓰려면: !깃풀 강제");
  else if (changed) lines.push("\n적용하려면: !깃풀");

  bot.send(room, withSpacer(lines.join("\n")));
}

// =====================================================================
// 명령: !깃풀 [강제]
// =====================================================================

function handlePull(room, force) {
  var r = fetchPlan();
  if (r.error) { bot.send(room, "[깃풀] ⚠ " + r.error); return; }

  var p = r.plan, manifest = r.manifest;
  var targets = planTargets(p, force);

  if (!targets.length) {
    saveManifest({ commit: r.commit, at: nowStr("yyyy-MM-dd HH:mm:ss"), files: manifest.files });
    var msg = ["[깃풀] " + commitLine(r.commit), "이미 최신입니다. (추적 " + p.same + "개)"];
    if (p.conflict.length) {
      msg = msg.concat(listBlock("[충돌 — 건너뜀]", conflictLines(p.conflict), 10));
      msg.push("\n덮어쓰려면: !깃풀 강제");
    }
    bot.send(room, withSpacer(msg.join("\n")));
    return;
  }

  var res = applyTargets(targets, r.commit, manifest);

  // 재컴파일 — 자기 자신(깃봇)은 보고를 보낸 뒤 마지막에.
  var rc = botsToRecompile(res.applied);
  var selfChanged = false;
  var others = [];
  for (var i = 0; i < rc.targets.length; i++) {
    if (rc.targets[i] === BOT_NAME) selfChanged = true; else others.push(rc.targets[i]);
  }
  var compiled = compileBots(others, res.applied, res.backupDir, manifest);

  saveManifest({ commit: r.commit, at: nowStr("yyyy-MM-dd HH:mm:ss"), files: manifest.files });

  var lines = ["[깃풀] " + commitLine(r.commit)];
  lines.push("반영 " + res.applied.length + "개 (수정 " + res.replaced.length + ", 신규 " + res.created.length + ")");
  lines = lines.concat(listBlock("[수정]", res.replaced, 20));
  lines = lines.concat(listBlock("[신규]", res.created, 20));
  lines = lines.concat(listBlock("[실패]", res.failed, 10));
  lines = lines.concat(listBlock("[앱 골격 덮어씀]", pathsOf(p.scaffold), 10));
  lines = lines.concat(listBlock("[충돌 — 건너뜀]", conflictLines(force ? [] : p.conflict), 10));
  lines = lines.concat(listBlock("[bot.json 보존]", p.keptBotJson, 5));
  lines = lines.concat(listBlock("[앱에 없는 봇 — 앱에서 먼저 생성 필요]", rc.unknown, 5));

  if (compiled.lines.length) {
    lines.push("");
    lines.push("[재컴파일]");
    lines = lines.concat(compiled.lines);
  }
  if (selfChanged) lines.push("  ⏳ " + BOT_NAME + " (이 메시지 직후 재컴파일)");
  if (res.applied.length) lines.push("\n되돌리기: !깃롤백");

  bot.send(room, withSpacer(lines.join("\n")));

  if (selfChanged) {
    try { java.lang.Thread.sleep(800); } catch (_) {}
    try { BotManager.compile(BOT_NAME, false); } catch (_) {}
  }
}

// =====================================================================
// 명령: !깃롤백
// =====================================================================

function latestRollbackDir() {
  var root = new java.io.File(BACKUP_ROOT);
  var kids = root.listFiles();
  if (!kids) return null;
  var best = null;
  for (var i = 0; i < kids.length; i++) {
    var nm = String(kids[i].getName());
    if (!/^gitpull_\d{8}_\d{6}$/.test(nm)) continue;
    if (!new java.io.File(String(kids[i].getAbsolutePath()) + "/rollback.json").exists()) continue;
    if (best === null || nm > best) best = nm;   // 이름=타임스탬프라 사전순 = 시간순
  }
  return best ? (BACKUP_ROOT + "/" + best) : null;
}

function handleRollback(room) {
  var dir = latestRollbackDir();
  if (!dir) { bot.send(room, "[깃롤백] 되돌릴 pull 기록이 없습니다."); return; }

  var meta;
  try { meta = JSON.parse(readTextFile(dir + "/rollback.json")); }
  catch (e) { bot.send(room, "[깃롤백] rollback.json 을 읽을 수 없습니다: " + dir); return; }

  var restored = [], removed = [], failed = [];

  var replaced = meta.replaced || [];
  for (var i = 0; i < replaced.length; i++) {
    if (copyFile(dir + "/" + replaced[i], MSGBOT_DIR + "/" + replaced[i])) restored.push(replaced[i]);
    else failed.push(replaced[i]);
  }
  var created = meta.created || [];
  for (var j = 0; j < created.length; j++) {
    try { if (fileOf(created[j])["delete"]()) removed.push(created[j]); else failed.push(created[j]); }
    catch (e2) { failed.push(created[j]); }
  }

  // 매니페스트도 pull 이전 상태로
  if (new java.io.File(dir + "/.gitpull.json").exists()) copyFile(dir + "/.gitpull.json", MANIFEST);
  else try { new java.io.File(MANIFEST)["delete"](); } catch (_) {}

  var touched = restored.concat(removed);
  var rc = botsToRecompile(touched);
  var selfChanged = false, others = [];
  for (var k = 0; k < rc.targets.length; k++) {
    if (rc.targets[k] === BOT_NAME) selfChanged = true; else others.push(rc.targets[k]);
  }
  var compiled = compileBots(others, [], dir, loadManifest());

  // 되돌린 백업 폴더는 재사용되지 않도록 표시
  try { new java.io.File(dir + "/rollback.json").renameTo(new java.io.File(dir + "/rollback.done.json")); } catch (_) {}

  var lines = ["[깃롤백] " + String(dir).substring(String(dir).lastIndexOf("/") + 1)];
  lines.push("복원 " + restored.length + "개, 신규파일 삭제 " + removed.length + "개");
  lines = lines.concat(listBlock("[복원]", restored, 20));
  lines = lines.concat(listBlock("[삭제]", removed, 10));
  lines = lines.concat(listBlock("[실패]", failed, 10));
  if (compiled.lines.length) {
    lines.push("");
    lines.push("[재컴파일]");
    lines = lines.concat(compiled.lines);
  }
  if (selfChanged) lines.push("  ⏳ " + BOT_NAME + " (이 메시지 직후 재컴파일)");

  bot.send(room, withSpacer(lines.join("\n")));

  if (selfChanged) {
    try { java.lang.Thread.sleep(800); } catch (_) {}
    try { BotManager.compile(BOT_NAME, false); } catch (_) {}
  }
}

// =====================================================================
// 명령: !깃봇 (도움말 + 상태)
// =====================================================================

function handleHelp(msg) {
  var m = loadManifest();
  var tracked = 0;
  for (var p in m.files) if (m.files.hasOwnProperty(p)) tracked++;

  var lines = [
    "[깃봇 설명서]",
    "GitHub(" + REPO_OWNER + "/" + REPO_NAME + " @" + BRANCH + ") 의 봇 소스를 태블릿에 반영합니다.",
    "",
    "!깃확인 — 무엇이 바뀌는지 미리보기 (적용 안 함)",
    "!깃풀 — 바뀐 파일 내려받아 반영 + 해당 봇 재컴파일",
    "!깃풀 강제 — 태블릿에서 수정한 파일까지 덮어쓰기",
    "!깃롤백 — 직전 !깃풀 되돌리기",
    "",
    "동기화 범위: Bots/ , lib/ (레포에 없는 파일은 지우지 않음)",
    "이미 있는 bot.json 은 전원 상태 보존을 위해 덮어쓰지 않습니다.",
    "새 봇은 앱에서 먼저 만들어야 !깃풀 이 내용을 채웁니다.",
    "",
    "마지막 pull: " + (m.at ? (m.at + " (" + String(m.commit).substring(0, 7) + ")") : "없음") +
      " / 추적 " + tracked + "개"
  ];

  var restricted = (ALLOW_HASHES.length || ALLOW_ROOMS.length);
  lines.push("실행 권한: " + (restricted ? "제한됨" : "제한 없음 (누구나 실행 가능)"));
  lines.push("내 hash: " + String(msg.hash || "?"));
  lines.push("이 방: " + String(msg.room || "?"));

  bot.send(msg.room, withSpacer(lines.join("\n")));
}

// =====================================================================
// 권한 / 디스패치
// =====================================================================

function isAllowed(msg) {
  if (ALLOW_HASHES.length && ALLOW_HASHES.indexOf(String(msg.hash || "")) === -1) return false;
  if (ALLOW_ROOMS.length && ALLOW_ROOMS.indexOf(String(msg.room || "")) === -1) return false;
  return true;
}

function handleMessage(msg) {
  var text = trim(msg.content);
  if (text !== "!깃확인" && text !== "!깃풀" && text !== "!깃풀 강제" &&
      text !== "!깃롤백" && text !== "!깃봇") return;

  if (text === "!깃봇") { handleHelp(msg); return; }

  if (!isAllowed(msg)) {
    bot.send(msg.room, "[깃봇] 이 방/계정에는 실행 권한이 없습니다.");
    return;
  }

  var room = msg.room;
  // 네트워크·파일 작업이 수 초 걸리므로 워커 큐를 막지 않도록 별도 스레드에서 처리.
  var t = new java.lang.Thread(new java.lang.Runnable({
    run: function () {
      try {
        if (text === "!깃확인") handleCheck(room);
        else if (text === "!깃풀") handlePull(room, false);
        else if (text === "!깃풀 강제") handlePull(room, true);
        else if (text === "!깃롤백") handleRollback(room);
      } catch (e) {
        try { bot.send(room, "[깃봇] ⚠ 오류: " + ((e && e.message) ? e.message : e)); } catch (_) {}
      }
    }
  }));
  t.setDaemon(true);
  t.setName("GITBOT_TASK");
  t.start();
}

// ─── 프리필터: "!깃" 으로 시작하는 명령만 처리 ────────────────────────────────
function isMyCommand(text) {
  return !!text && trim(text).indexOf("!깃") === 0;
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독, 공용 subscriber 모듈 사용) ───
var subscribe = (function () {
  var libPath = "/sdcard/msgbot/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/subscriber.js";
    }
  } catch (_) {}
  return require(libPath);
})();

subscribe(BOT_NAME, WORKER_NAME, function (msg) {
  if (!isMyCommand(msg.content)) return;
  handleMessage(msg);
});

// ─── 보일러플레이트 ─────────────────────────────────────────────────────────
function onMessage(rawMsg) {}   // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);

function onCreate(savedInstanceState, activity) {
  var tv = new Packages.android.widget.TextView(activity);
  tv.setText("깃봇");
  tv.setTextColor(Packages.android.graphics.Color.DKGRAY);
  activity.setContentView(tv);
}
function onStart(activity) {}
function onResume(activity) {}
function onPause(activity) {}
function onStop(activity) {}
function onRestart(activity) {}
function onDestroy(activity) {}
function onBackPressed(activity) {}

bot.addListener(Event.Activity.CREATE, onCreate);
bot.addListener(Event.Activity.START, onStart);
bot.addListener(Event.Activity.RESUME, onResume);
bot.addListener(Event.Activity.PAUSE, onPause);
bot.addListener(Event.Activity.STOP, onStop);
bot.addListener(Event.Activity.RESTART, onRestart);
bot.addListener(Event.Activity.DESTROY, onDestroy);
bot.addListener(Event.Activity.BACK_PRESSED, onBackPressed);
