const bot = BotManager.getCurrentBot();

// =====================================================================
// 백업봇.js — /sdcard/msgbot 전체를 매일 오전 6시(KST)에 zip 백업
//
//  - 압축: java.util.zip.ZipOutputStream (외부 바이너리·root 불필요)
//  - 대상: /sdcard/msgbot 전체 → /sdcard/msgbot_backups/msgbot_yyyyMMdd_HHmmss.zip
//  - 보관: 최근 KEEP_DAYS 일치 + 일요일 백업 KEEP_SUNDAYS 주치, 나머지 자동 삭제
//  - 스케줄러: BACKUP_POLLER 스레드 (메이플봇 maple-poll 과 동일한
//    killOld-by-name → spawn → registerThread 재컴파일-안전 패턴.
//    이름에 POLLER 를 넣어 ChatManager !스레드 스캔에 노출)
//  - 기동 캐치업: 재시작 시점이 오늘 6시 이후인데 오늘자 백업이 없으면 즉시 1회
//  - 명령: !백업(수동 실행) / !백업목록 / !백업봇(도움말)
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

var BACKUP_NAME_RE = /^msgbot_\d{8}_\d{6}\.zip$/;

function trim(s){ return (s||"").replace(/^\s+|\s+$/g, ""); }

function tsFmt(pattern){
  var f = new java.text.SimpleDateFormat(pattern);
  f.setTimeZone(KST_TZ);
  return f;
}

// =====================================================================
// zip 압축
// =====================================================================

function addToZip(zos, file, entryPath, buf, stats){
  if (file.isDirectory()){
    var kids = file.listFiles();
    if (kids == null || kids.length === 0){
      try { zos.putNextEntry(new java.util.zip.ZipEntry(entryPath + "/")); zos.closeEntry(); } catch(_) {}
      return;
    }
    for (var i = 0; i < kids.length; i++){
      addToZip(zos, kids[i], entryPath + "/" + kids[i].getName(), buf, stats);
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

function zipDirectory(srcPath, destZipPath){
  var srcDir = new java.io.File(srcPath);
  var zos = new java.util.zip.ZipOutputStream(
    new java.io.BufferedOutputStream(new java.io.FileOutputStream(destZipPath))
  );
  var buf = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 65536);
  var stats = { files: 0, errors: 0 };
  try {
    addToZip(zos, srcDir, srcDir.getName(), buf, stats);
  } finally {
    try { zos.close(); } catch(_) {}
  }
  return stats;
}

// =====================================================================
// 백업 실행 / 보관 정리 / 로그
// =====================================================================

function listBackupFilesDesc(){
  var dir = new java.io.File(BACKUP_DIR);
  var files = dir.listFiles();
  var arr = [];
  if (files){
    for (var i = 0; i < files.length; i++){
      if (BACKUP_NAME_RE.test(String(files[i].getName()))) arr.push(files[i]);
    }
  }
  arr.sort(function(a, b){
    var an = String(a.getName()), bn = String(b.getName());
    return an < bn ? 1 : (an > bn ? -1 : 0);   // 이름=타임스탬프라 사전순 내림차순=최신순
  });
  return arr;
}

function dateStrOf(fileName){ return String(fileName).substring(7, 15); }  // "msgbot_YYYYMMDD_..." → YYYYMMDD

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

function hasBackupForToday(){
  var prefix = "msgbot_" + tsFmt("yyyyMMdd").format(new java.util.Date());
  var arr = listBackupFilesDesc();
  for (var i = 0; i < arr.length; i++){
    if (String(arr[i].getName()).indexOf(prefix) === 0) return true;
  }
  return false;
}

// trigger: "auto"(스케줄) | "manual"(!백업)
function runBackup(trigger){
  var t0 = java.lang.System.currentTimeMillis();
  var dir = new java.io.File(BACKUP_DIR);
  if (!dir.exists() && !dir.mkdirs()){
    appendBackupLog(trigger + " FAIL 백업 폴더 생성 실패: " + BACKUP_DIR);
    return { error: "백업 폴더 생성 실패: " + BACKUP_DIR };
  }

  var name = "msgbot_" + tsFmt("yyyyMMdd_HHmmss").format(new java.util.Date()) + ".zip";
  var dest = BACKUP_DIR + "/" + name;
  var tmp = dest + ".part";   // 도중 실패한 반쪽 zip 이 정상 백업으로 오인되지 않게 완료 후 rename

  try {
    var stats = zipDirectory(BACKUP_SRC, tmp);
    if (!new java.io.File(tmp).renameTo(new java.io.File(dest))){
      throw new Error("rename 실패: " + tmp);
    }
    var pruned = pruneOldBackups();
    var sizeKB = Math.round(new java.io.File(dest).length() / 1024);
    var ms = java.lang.System.currentTimeMillis() - t0;
    appendBackupLog(trigger + " OK " + name + " " + sizeKB + "KB files=" + stats.files +
                    " errors=" + stats.errors + " pruned=" + pruned + " " + ms + "ms");
    return { name: name, files: stats.files, errors: stats.errors, sizeKB: sizeKB, ms: ms, pruned: pruned };
  } catch(e) {
    try { new java.io.File(tmp)["delete"](); } catch(_) {}
    appendBackupLog(trigger + " FAIL " + String(e));
    return { error: String(e) };
  }
}

function formatBackupResult(res){
  if (res.error) return "[백업 실패] " + res.error;
  var line = "[백업 완료] " + res.name +
             "\n파일 " + res.files + "개, " + (res.sizeKB >= 1024 ? (res.sizeKB/1024).toFixed(1) + "MB" : res.sizeKB + "KB") +
             ", " + (res.ms/1000).toFixed(1) + "초";
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
          runBackup("auto");
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
          if (!hasBackupForToday()) runBackup("auto");   // 새벽에 수동 !백업 했으면 스킵
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

  if (text === "!백업"){ msg.reply(formatBackupResult(runBackup("manual"))); return; }
  if (text === "!백업목록"){ msg.reply(handleBackupList()); return; }
  if (text === "!백업봇"){
    msg.reply(
      "[백업봇 설명서]\n" +
      "매일 오전 " + BACKUP_HOUR + "시(KST) msgbot 폴더 전체를 자동 백업\n" +
      "저장: " + BACKUP_DIR + " (보관: " + KEEP_DESC + ")\n\n" +
      "!백업 — 지금 즉시 백업\n" +
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
