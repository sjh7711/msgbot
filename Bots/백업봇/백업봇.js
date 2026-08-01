const bot = BotManager.getCurrentBot();

// =====================================================================
// 백업봇.js — /sdcard/msgbot 의 "GitHub 에 없는 것"만 매일 오전 6시(KST)에 zip 백업
//
//  - 압축: java.util.zip.ZipOutputStream (외부 바이너리·root 불필요)
//  - 대상: /sdcard/msgbot 중 레포가 소유하지 않은 파일만
//          → /sdcard/msgbot_backups/msgbot_data_yyyyMMdd_HHmmss.zip
//    봇 소스는 GitHub 에 있으니 백업할 이유가 없다. 실제로 태블릿 12.8MB 중
//    10.1MB(apk 5.7 + stdict.db 2.3 + freq.db 2.1)가 레포 파일이라, 이걸 빼면
//    백업 하나가 7.4MB → 1MB 대로 줄고 보관 기간을 늘려도 부담이 없다.
//    복구가 불가능한 런타임 데이터(각종 .db, 로그, 상태 json, qwen_key)만 남긴다.
//  - "!백업 전체" 로 예전처럼 통째 백업도 가능 (msgbot_full_... 이름)
//  - 보관: 최근 KEEP_DAYS 일치 + 일요일 백업 KEEP_SUNDAYS 주치, 나머지 자동 삭제
//  - 스케줄러: BACKUP_POLLER 스레드 (메이플봇 maple-poll 과 동일한
//    killOld-by-name → spawn → registerThread 재컴파일-안전 패턴.
//    이름에 POLLER 를 넣어 ChatManager !스레드 스캔에 노출)
//  - 기동 캐치업: 재시작 시점이 오늘 6시 이후인데 오늘자 백업이 없으면 즉시 1회
//  - 명령: !백업(수동) / !백업 전체 / !백업목록 / !백업봇(도움말)
//  - 결과는 /sdcard/msgbot_backups/backup.log 에 한 줄씩 기록
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독. ChatManager 가 켜져 있어야 동작.
// =====================================================================

var BOT_NAME = "백업봇";

var BACKUP_SRC = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot";
var BACKUP_DIR = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot_backups";
var BACKUP_LOG = BACKUP_DIR + "/backup.log";

var KEEP_DAYS = 7;          // 최근 N일치 보관
var KEEP_SUNDAYS = 4;       // 일요일 백업은 추가로 N주치 보관
var KEEP_DESC = "최근 " + KEEP_DAYS + "일 + 일요일 " + KEEP_SUNDAYS + "주";
var BACKUP_HOUR = 6;        // 매일 이 시각(KST)에 실행
var KST_TZ = java.util.TimeZone.getTimeZone("Asia/Seoul");

// msgbot_data_20260801_060000.zip / msgbot_full_... / 옛 형식 msgbot_20260801_060000.zip
var BACKUP_NAME_RE = /^msgbot_(?:data_|full_)?(\d{8})_(\d{6})\.zip$/;

// =====================================================================
// "레포가 소유하는 파일" 판정 — 여기 걸리면 백업에서 제외
//
//  ① 깃봇이 .gitpull.json 으로 추적 중인 파일 (Bots/, lib/ 소스)
//  ② 아래 루트 파일 목록 (매니페스트가 안 다루는 범위)
//  ③ 매니페스트가 없어도 동작하도록 하는 정적 규칙:
//     Bots/·lib/ 아래의 *.js, bot.json, package.json
//
//  ②③ 이 있어서 .gitpull.json 이 없거나 깨져도 안전하게 동작한다.
//  판정에서 빠진 건 전부 백업된다 = 데이터를 잃는 쪽으로는 실패하지 않는다.
// =====================================================================

var MANIFEST_PATH = BACKUP_SRC + "/.gitpull.json";

var ROOT_REPO_FILES = [
  "README.md", "legacy_default.js", "editor_shortcuts.txt", "qwen api.md",
  "stdict.db", "freq.db", "linkedin history.apk", ".gitignore", ".gitattributes"
];

function loadManifestFiles() {
  var f = new java.io.File(MANIFEST_PATH);
  if (!f.exists()) return {};
  var is = null;
  try {
    is = new java.io.FileInputStream(f);
    var bos = new java.io.ByteArrayOutputStream();
    var buf = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 16384);
    var n;
    while ((n = is.read(buf)) !== -1) if (n > 0) bos.write(buf, 0, n);
    var j = JSON.parse(String(new java.lang.String(bos.toByteArray(), "UTF-8")));
    return (j && j.files) ? j.files : {};
  } catch (e) {
    return {};
  } finally {
    if (is) try { is.close(); } catch(_) {}
  }
}

function makeSkipFn(manifestFiles) {
  return function (rel, isDir) {
    if (isDir) return /(^|\/)node_modules$/.test(rel);
    if (manifestFiles[rel]) return true;
    if (ROOT_REPO_FILES.indexOf(rel) !== -1) return true;
    if (/^(?:Bots|lib)\//.test(rel)) {
      var base = rel.substring(rel.lastIndexOf("/") + 1);
      if (/\.js$/.test(base) || base === "bot.json" || base === "package.json") return true;
    }
    return false;
  };
}

function trim(s){ return (s||"").replace(/^\s+|\s+$/g, ""); }

function tsFmt(pattern){
  var f = new java.text.SimpleDateFormat(pattern);
  f.setTimeZone(KST_TZ);
  return f;
}

// =====================================================================
// zip 압축
// =====================================================================

// rel: BACKUP_SRC 기준 상대경로 (루트는 ""), entryPath: zip 안의 경로
function addToZip(zos, file, rel, entryPath, buf, stats, skipFn){
  var isDir = file.isDirectory();
  if (rel && skipFn && skipFn(rel, isDir)){ stats.skipped++; return; }

  if (isDir){
    var kids = file.listFiles();
    if (kids == null || kids.length === 0){
      try { zos.putNextEntry(new java.util.zip.ZipEntry(entryPath + "/")); zos.closeEntry(); } catch(_) {}
      return;
    }
    for (var i = 0; i < kids.length; i++){
      var nm = String(kids[i].getName());
      addToZip(zos, kids[i], rel ? (rel + "/" + nm) : nm, entryPath + "/" + nm, buf, stats, skipFn);
    }
    return;
  }
  var fis = null;
  try {
    fis = new java.io.BufferedInputStream(new java.io.FileInputStream(file));
    zos.putNextEntry(new java.util.zip.ZipEntry(entryPath));
    var n;
    while ((n = fis.read(buf)) !== -1) zos.write(buf, 0, n);
    zos.closeEntry();
    stats.files++;
  } catch(e) {
    // 백업 도중 쓰기 중인 파일 등 개별 실패는 건너뛰고 계속 (개수만 집계)
    stats.errors++;
    try { zos.closeEntry(); } catch(_) {}
  } finally {
    if (fis) try { fis.close(); } catch(_) {}
  }
}

function zipDirectory(srcPath, destZipPath, skipFn){
  var srcDir = new java.io.File(srcPath);
  var zos = new java.util.zip.ZipOutputStream(
    new java.io.BufferedOutputStream(new java.io.FileOutputStream(destZipPath))
  );
  var buf = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 65536);
  var stats = { files: 0, errors: 0, skipped: 0 };
  try {
    addToZip(zos, srcDir, "", srcDir.getName(), buf, stats, skipFn);
  } finally {
    try { zos.close(); } catch(_) {}
  }
  return stats;
}

// =====================================================================
// 백업 실행 / 보관 정리 / 로그
// =====================================================================

// 파일명에서 "YYYYMMDD_HHMMSS" 추출 (msgbot_ / msgbot_data_ / msgbot_full_ 모두 대응)
function stampOf(fileName){
  var m = BACKUP_NAME_RE.exec(String(fileName));
  return m ? (m[1] + "_" + m[2]) : null;
}

function listBackupFilesDesc(){
  var dir = new java.io.File(BACKUP_DIR);
  var files = dir.listFiles();
  var arr = [];
  if (files){
    for (var i = 0; i < files.length; i++){
      if (stampOf(files[i].getName())) arr.push(files[i]);
    }
  }
  // 접두사가 섞이면 사전순 != 시간순이 된다("msgbot_2026..." < "msgbot_data_...").
  // 그래서 파일명에서 뽑은 타임스탬프로 정렬한다.
  arr.sort(function(a, b){
    var as = stampOf(a.getName()), bs = stampOf(b.getName());
    return as < bs ? 1 : (as > bs ? -1 : 0);
  });
  return arr;
}

function dateStrOf(fileName){
  var s = stampOf(fileName);
  return s ? s.substring(0, 8) : "";
}

function isSundayDateStr(d8){
  var cal = java.util.Calendar.getInstance(KST_TZ);
  cal.clear();
  cal.set(parseInt(d8.substring(0,4),10), parseInt(d8.substring(4,6),10)-1, parseInt(d8.substring(6,8),10));
  return cal.get(java.util.Calendar.DAY_OF_WEEK) === java.util.Calendar.SUNDAY;
}

// 보관 정책: 최근 KEEP_DAYS 개 날짜 + 최근 KEEP_SUNDAYS 개 일요일 날짜의 백업만 남긴다.
// (수동 !백업으로 같은 날 여러 개 생겨도 날짜 단위로 함께 보관/삭제)
function pruneOldBackups(){
  var arr = listBackupFilesDesc();   // 최신순
  var dates = [], seen = {};
  for (var i = 0; i < arr.length; i++){
    var d = dateStrOf(arr[i].getName());
    if (!seen[d]){ seen[d] = true; dates.push(d); }
  }
  var keep = {};
  for (var i = 0; i < dates.length && i < KEEP_DAYS; i++) keep[dates[i]] = true;
  var sun = 0;
  for (var i = 0; i < dates.length && sun < KEEP_SUNDAYS; i++){
    if (isSundayDateStr(dates[i])){ keep[dates[i]] = true; sun++; }
  }
  var deleted = 0;
  for (var i = 0; i < arr.length; i++){
    if (!keep[dateStrOf(arr[i].getName())]){
      try { if (arr[i]["delete"]()) deleted++; } catch(_) {}
    }
  }
  return deleted;
}

function appendBackupLog(line){
  var fw = null;
  try {
    fw = new java.io.FileWriter(BACKUP_LOG, true);
    fw.write(tsFmt("yyyy-MM-dd HH:mm:ss").format(new java.util.Date()) + " " + line + "\n");
  } catch(_) {} finally {
    if (fw) try { fw.close(); } catch(_) {}
  }
}

// 오늘 날짜의 백업이 하나라도 있으면 true (data/full/옛 형식 무관)
function hasBackupForToday(){
  var today = tsFmt("yyyyMMdd").format(new java.util.Date());
  var arr = listBackupFilesDesc();
  for (var i = 0; i < arr.length; i++){
    if (dateStrOf(arr[i].getName()) === today) return true;
  }
  return false;
}

// trigger: "auto"(스케줄) | "manual"(!백업)
// full=true 면 레포 파일까지 통째로 (예전 동작), 기본은 레포에 없는 것만
function runBackup(trigger, full){
  var t0 = java.lang.System.currentTimeMillis();
  var dir = new java.io.File(BACKUP_DIR);
  if (!dir.exists() && !dir.mkdirs()){
    appendBackupLog(trigger + " FAIL 백업 폴더 생성 실패: " + BACKUP_DIR);
    return { error: "백업 폴더 생성 실패: " + BACKUP_DIR };
  }

  var kind = full ? "full" : "data";
  var skipFn = full ? null : makeSkipFn(loadManifestFiles());

  var name = "msgbot_" + kind + "_" + tsFmt("yyyyMMdd_HHmmss").format(new java.util.Date()) + ".zip";
  var dest = BACKUP_DIR + "/" + name;
  var tmp = dest + ".part";   // 도중 실패한 반쪽 zip 이 정상 백업으로 오인되지 않게 완료 후 rename

  try {
    var stats = zipDirectory(BACKUP_SRC, tmp, skipFn);
    if (!new java.io.File(tmp).renameTo(new java.io.File(dest))){
      throw new Error("rename 실패: " + tmp);
    }
    var pruned = pruneOldBackups();
    var sizeKB = Math.round(new java.io.File(dest).length() / 1024);
    var ms = java.lang.System.currentTimeMillis() - t0;
    appendBackupLog(trigger + " OK " + name + " " + sizeKB + "KB files=" + stats.files +
                    " skipped=" + stats.skipped + " errors=" + stats.errors +
                    " pruned=" + pruned + " " + ms + "ms");
    return { name: name, kind: kind, files: stats.files, skipped: stats.skipped,
             errors: stats.errors, sizeKB: sizeKB, ms: ms, pruned: pruned };
  } catch(e) {
    try { new java.io.File(tmp)["delete"](); } catch(_) {}
    appendBackupLog(trigger + " FAIL " + String(e));
    return { error: String(e) };
  }
}

function formatBackupResult(res){
  if (res.error) return "[백업 실패] " + res.error;
  var line = "[백업 완료] " + res.name +
             "\n" + (res.kind === "full" ? "전체 백업" : "레포에 없는 파일만") +
             " — 파일 " + res.files + "개, " + (res.sizeKB >= 1024 ? (res.sizeKB/1024).toFixed(1) + "MB" : res.sizeKB + "KB") +
             ", " + (res.ms/1000).toFixed(1) + "초";
  if (res.kind !== "full" && res.skipped > 0) line += "\nGitHub 에 있는 " + res.skipped + "개 제외";
  if (res.errors > 0) line += "\n⚠️ 읽기 실패 " + res.errors + "개 건너뜀";
  if (res.pruned > 0) line += "\n오래된 백업 " + res.pruned + "개 삭제 (보관: " + KEEP_DESC + ")";
  return line;
}

// =====================================================================
// 스케줄러 스레드 — 매일 BACKUP_HOUR시(KST)
// =====================================================================

var SCHED_THREAD_NAME = "BACKUP_POLLER";
var schedThread = null;

// 재컴파일로 누수된 옛 스케줄러 스레드 정리 (maple-poll killOldPollThreads 와 동일 패턴)
function killOldSchedThreads(){
  try {
    var root = java.lang.Thread.currentThread().getThreadGroup();
    while (root.getParent() != null) root = root.getParent();
    var n = root.activeCount() + 32;
    var arr = java.lang.reflect.Array.newInstance(java.lang.Thread, n);
    var got = root.enumerate(arr, true);
    for (var i = 0; i < got; i++){
      var t = arr[i];
      if (!t) continue;
      if (String(t.getName() || "") === SCHED_THREAD_NAME){
        try { t.interrupt(); } catch(_) {}
      }
    }
  } catch(_) {}
}

function nextRunMillis(){
  var cal = java.util.Calendar.getInstance(KST_TZ);
  cal.set(java.util.Calendar.HOUR_OF_DAY, BACKUP_HOUR);
  cal.set(java.util.Calendar.MINUTE, 0);
  cal.set(java.util.Calendar.SECOND, 0);
  cal.set(java.util.Calendar.MILLISECOND, 0);
  if (cal.getTimeInMillis() <= java.lang.System.currentTimeMillis()){
    cal.add(java.util.Calendar.DAY_OF_MONTH, 1);
  }
  return cal.getTimeInMillis();
}

function startScheduler(){
  killOldSchedThreads();

  schedThread = new java.lang.Thread(new java.lang.Runnable({
    run: function(){
      // 기동 캐치업: 6시 시점에 JVM 이 죽어 있었다면(재부팅·업데이트 등) 지금 1회 보충.
      // 하루 1개 기준이라 재컴파일이 반복돼도 중복 백업은 안 생긴다.
      try {
        var now = java.util.Calendar.getInstance(KST_TZ);
        if (now.get(java.util.Calendar.HOUR_OF_DAY) >= BACKUP_HOUR && !hasBackupForToday()){
          runBackup("auto", false);
        }
      } catch(e) { appendBackupLog("auto FAIL 캐치업: " + String(e)); }

      while (!java.lang.Thread.currentThread().isInterrupted()){
        var target = nextRunMillis();
        // 시계 변경(수동 시간조정 등)에 대비해 최대 1시간 단위로 끊어 자면서 재계산
        while (true){
          var remain = target - java.lang.System.currentTimeMillis();
          if (remain <= 0) break;
          try { java.lang.Thread.sleep(Math.min(remain, 3600000)); }
          catch(ie) { return; }   // interrupt = 재컴파일/수동 kill → 종료
        }
        try {
          if (!hasBackupForToday()) runBackup("auto", false);   // 새벽에 수동 !백업 했으면 스킵
        } catch(e) { appendBackupLog("auto FAIL " + String(e)); }
      }
    }
  }));
  schedThread.setDaemon(true);
  schedThread.setName(SCHED_THREAD_NAME);
  schedThread.start();

  // 스레드 레지스트리 등록 → ChatManager !스레드 / !스레드킬 대상 (실패해도 무해)
  try {
    var libPath = "/sdcard/msgbot/lib/thread-registry.js";
    try {
      if (typeof bot.getRootPath === "function") libPath = bot.getRootPath() + "/../../lib/thread-registry.js";
    } catch(_) {}
    require(libPath).registerThread(SCHED_THREAD_NAME, BOT_NAME, schedThread);
  } catch(_) {}
}

startScheduler();

// =====================================================================
// 명령 처리
// =====================================================================

function handleBackupList(){
  var arr = listBackupFilesDesc();
  if (!arr.length) return "백업이 없습니다.\n경로: " + BACKUP_DIR;
  var totalKB = 0;
  for (var i = 0; i < arr.length; i++) totalKB += arr[i].length() / 1024;
  var lines = [];
  lines.push("[백업 목록] " + arr.length + "개, 총 " + (totalKB/1024).toFixed(1) + "MB (보관: " + KEEP_DESC + ")");
  var show = Math.min(arr.length, 10);
  for (var i = 0; i < show; i++){
    var kb = Math.round(arr[i].length() / 1024);
    lines.push(String(arr[i].getName()) + " (" + (kb >= 1024 ? (kb/1024).toFixed(1) + "MB" : kb + "KB") + ")");
  }
  if (arr.length > show) lines.push("... 외 " + (arr.length - show) + "개");
  return lines.join("\n");
}

function handleMessage(msg){
  var text = trim(msg.content);

  if (text === "!백업"){ msg.reply(formatBackupResult(runBackup("manual", false))); return; }
  if (text === "!백업 전체"){ msg.reply(formatBackupResult(runBackup("manual", true))); return; }
  if (text === "!백업목록"){ msg.reply(handleBackupList()); return; }
  if (text === "!백업봇"){
    msg.reply(
      "[백업봇 설명서]\n" +
      "매일 오전 " + BACKUP_HOUR + "시(KST) 자동 백업\n" +
      "GitHub 에 있는 파일(봇 소스·사전 db·apk)은 제외하고,\n" +
      "복구 불가능한 런타임 데이터만 담는다.\n" +
      "저장: " + BACKUP_DIR + " (보관: " + KEEP_DESC + ")\n\n" +
      "!백업 — 지금 즉시 백업 (레포에 없는 것만)\n" +
      "!백업 전체 — msgbot 폴더 통째로 백업\n" +
      "!백업목록 — 백업 파일 목록"
    );
    return;
  }
}

// ─── 프리필터: "!" 로 시작하는 명령만 처리 ──────────────────────────────────
function isMyCommand(text){
  return !!text && trim(text).indexOf("!") === 0;
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독, 공용 subscriber 모듈 사용) ───
var WORKER_NAME = "BACKUP_BOT_WORKER";

var subscribe = (function(){
  var libPath = "/sdcard/msgbot/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function"){
      libPath = bot.getRootPath() + "/../../lib/subscriber.js";
    }
  } catch(_) {}
  return require(libPath);
})();

subscribe(BOT_NAME, WORKER_NAME, function(msg){
  if (!isMyCommand(msg.content)) return;
  handleMessage(msg);
});

function onMessage(rawMsg){}  // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);
