const bot = BotManager.getCurrentBot();

// =====================================================================
// zqt.js — Registry-based rewrite (no legacy, no migration)
//  - Fixed game display order: z, q, t, s, then newly registered games appended
//  - Explicit registries: users(name), games(key, ord)
//  - Recording strictly validates pre-registered users & games
//  - Username must include at least one Korean character (가-힣)
//  - Removed ALL legacy v1(records) code and migration paths
//  - Unified command remains: !게임순위 [이름|게임키] [기간]
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독.
//   ChatManager 가 켜져 있어야 동작.
// =====================================================================

const BOT_NAME = "zqt";

// === 경로 & 상수 ===
var DB_PATH = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/zqt.db";

var DATE_FMT = new java.text.SimpleDateFormat("yyyyMMdd");
var VIEW_FMT = new java.text.SimpleDateFormat("yyyy-MM-dd");
var PDT_TZ   = java.util.TimeZone.getTimeZone("America/Los_Angeles");
DATE_FMT.setTimeZone(PDT_TZ);
VIEW_FMT.setTimeZone(PDT_TZ);

var LONG_MSG_SPACER = "​".repeat(500);

function todayStr(){ return DATE_FMT.format(new java.util.Date()); }
function parseDateStr(s){ try{ return DATE_FMT.parse(s); }catch(e){ return null; } }
function toDateStr(d){ return DATE_FMT.format(d); }
function toViewStr(yyyymmdd){ try{ var d = parseDateStr(yyyymmdd); return VIEW_FMT.format(d); } catch(e){ return yyyymmdd; } }
function trim(s){ return (s||"").replace(/^\s+|\s+$/g, ""); }

// === DB 오픈/초기화 ===
// ─── 공용 DB 헬퍼 (lib/db-helper.js): withDB / queryAll / transaction ───
var DBH = (function() {
  var libPath = "/sdcard/msgbot/lib/db-helper.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/db-helper.js";
    }
  } catch(_) {}
  return require(libPath);
})();

function initDatabase(){
  DBH.withDB(DB_PATH, function(db){
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS records_v2 ("+
      " id INTEGER PRIMARY KEY AUTOINCREMENT,"+
      " play_date TEXT NOT NULL,"+
      " game TEXT NOT NULL,"+
      " player TEXT NOT NULL,"+
      " rank INTEGER NOT NULL,"+
      " UNIQUE(play_date, game, player) ON CONFLICT REPLACE"+
      ");"
    );
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_rec2_date_game ON records_v2(play_date, game)");
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_rec2_player ON records_v2(player)");

    db.execSQL(
      "CREATE TABLE IF NOT EXISTS users ("+
      " name TEXT PRIMARY KEY"+
      ");"
    );
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS games ("+
      " key TEXT PRIMARY KEY,"+
      " ord INTEGER NOT NULL UNIQUE"+
      ");"
    );

    var cur = db.rawQuery("SELECT COUNT(1) FROM games", []);
    var empty = false; if (cur.moveToFirst()) empty = cur.getInt(0) === 0; cur.close();
    if (empty){
      var ins = db.compileStatement("INSERT OR IGNORE INTO games(key, ord) VALUES(?,?)");
      var G = ["z","q","t","s"];
      for (var i=0;i<G.length;i++){ ins.bindString(1, G[i]); ins.bindLong(2, i+1); ins.execute(); }
      ins.close();
    }

    var colCur = db.rawQuery("PRAGMA table_info(records_v2)", []);
    var hasTimeCol = false;
    while (colCur.moveToNext()){ if (colCur.getString(1) === "time"){ hasTimeCol = true; break; } }
    colCur.close();
    if (!hasTimeCol) db.execSQL("ALTER TABLE records_v2 ADD COLUMN time INTEGER");
  });
}
initDatabase();

// === 레지스트리 유틸 ===
function isValidKoreanName(name){ return /^([가-힣])$/.test(name); }

function getAllUsers(){
  return DBH.withDB(DB_PATH, function(db){
    var rows = DBH.queryAll(db, "SELECT name FROM users ORDER BY name ASC");
    var out=[];
    for (var i=0;i<rows.length;i++) out.push(rows[i].name);
    return out;
  });
}

function getAllGamesOrdered(){
  return DBH.withDB(DB_PATH, function(db){
    var rows = DBH.queryAll(db, "SELECT key FROM games ORDER BY ord ASC");
    var out=[];
    for (var i=0;i<rows.length;i++) out.push(rows[i].key);
    return out;
  });
}

function gameExists(key){ return DBH.withDB(DB_PATH, function(db){ var cur=null; try{ cur=db.rawQuery("SELECT 1 FROM games WHERE key=?", [key]); return cur.moveToFirst(); } finally { if(cur)cur.close(); } }); }
function userExists(name){ return DBH.withDB(DB_PATH, function(db){ var cur=null; try{ cur=db.rawQuery("SELECT 1 FROM users WHERE name=?", [name]); return cur.moveToFirst(); } finally { if(cur)cur.close(); } }); }

function registerGame(key){
  key = (key||"").toLowerCase();
  if (!/^[A-Za-z]$/.test(key)) return "게임키는 1글자 영문만 가능합니다.";
  return DBH.withDB(DB_PATH, function(db){
    var cur=null;
    try{
      cur = db.rawQuery("SELECT ord FROM games WHERE key=?", [key]);
      if (cur.moveToFirst()) return "이미 등록된 게임입니다: "+key;
      cur.close();
      cur = db.rawQuery("SELECT IFNULL(MAX(ord),0) FROM games", []);
      var next = 1; if (cur.moveToFirst()) next = cur.getInt(0) + 1; cur.close();
      var st = db.compileStatement("INSERT INTO games(key, ord) VALUES(?,?)");
      st.bindString(1, key); st.bindLong(2, next); st.execute(); st.close();
      return "게임 등록 완료: "+key+" (순서 "+next+")";
    } finally { if (cur) cur.close(); }
  });
}

function registerUser(name){
  name = trim(name||"");
  if (!name) return "형식: !유저등록 [이름]";
  if (!isValidKoreanName(name)) return "유저 이름은 1글자여야 합니다.";
  return DBH.withDB(DB_PATH, function(db){
    var cur=null;
    try{
      cur = db.rawQuery("SELECT 1 FROM users WHERE name=?", [name]);
      if (cur.moveToFirst()) return "이미 등록된 유저입니다: "+name;
      cur.close();
      var st = db.compileStatement("INSERT INTO users(name) VALUES(?)");
      st.bindString(1, name); st.execute(); st.close();
      return "유저 등록 완료: "+name;
    } finally { if (cur) cur.close(); }
  });
}

// === 파싱 유틸 ===
function tokenizeOrder(s){
  s = trim(s).replace(/\s+/g, "");
  var tokens = [];
  var i = 0;
  while (i < s.length) {
    var c = s.charAt(i);
    if (c === "(") {
      var j = i + 1;
      while (j < s.length && s.charAt(j) !== ")") j++;
      if (j >= s.length) { tokens.push(s.slice(i)); break; }
      tokens.push(s.slice(i, j + 1));
      i = j + 1;
    } else {
      tokens.push(c);
      i++;
    }
  }
  return tokens;
}

function parseOrderToGroups(s, allowedUsers){
  var tokens = tokenizeOrder(s); if (!tokens||!tokens.length) return null;
  var allowSet={}; for (var i=0;i<allowedUsers.length;i++) allowSet[allowedUsers[i]] = true;
  var groups=[], seen={};
  for (var i=0;i<tokens.length;i++){
    var tok = tokens[i];
    if (/^\(.+\)$/.test(tok)){
      var inner = tok.slice(1,-1); if(!inner) return null; var g=[];
      for (var j=0;j<inner.length;j++){ var ch=inner.charAt(j); if(!allowSet[ch]) return {error:"미등록 유저 포함: "+ch}; if(seen[ch]) return {error:"중복 유저: "+ch}; seen[ch]=true; g.push(ch); }
      groups.push(g);
    } else {
      for (var k=0;k<tok.length;k++){ var ch2=tok.charAt(k); if(!allowSet[ch2]) return {error:"미등록 유저 포함: "+ch2}; if(seen[ch2]) return {error:"중복 유저: "+ch2}; seen[ch2]=true; groups.push([ch2]); }
    }
  }
  if (!groups.length) return null; return {groups:groups};
}

function parseGameLines(lines, allowedUsers, allowedGames){
  var got = {};
  var allowGameSet={}; for (var i=0;i<allowedGames.length;i++) allowGameSet[allowedGames[i]] = true;
  for (var i=0;i<lines.length;i++){
    var line = trim(lines[i]); if(!line) continue;
    var m = line.match(/^([A-Za-z])\s+(.+)$/);
    if (!m) return { error: "형식 오류: "+line+"  (예: z 이(그명)쫑)" };
    var g = m[1].toLowerCase(); if (!allowGameSet[g]) return { error: "미등록 게임키: "+g };
    var parsed = parseOrderToGroups(m[2], allowedUsers); if (!parsed || parsed.error) return parsed || {error:"순위 문자열 오류: "+line};
    got[g] = parsed.groups;
  }
  return { data: got };
}

// === 저장 ===
function saveV2(dateStr, parsed){
  DBH.withDB(DB_PATH, function(db){
    DBH.transaction(db, function(db){
      for (var g in parsed){
        var groups = parsed[g];
        var currentRank = 1;
        for (var r = 0; r < groups.length; r++){
          var arr = groups[r];
          for (var i = 0; i < arr.length; i++){
            upsertV2(db, dateStr, g, arr[i], currentRank);
          }
          currentRank += arr.length;
        }
      }
    });
  });
}

// === 조회 유틸 ===
function getGamesInRangeOrdered(fromStr, toStr){
  var usedSet = DBH.withDB(DB_PATH, function(db){
    var cur=null; var s={};
    try{
      cur = db.rawQuery("SELECT DISTINCT game FROM records_v2 WHERE play_date BETWEEN ? AND ?", [fromStr, toStr]);
      while (cur.moveToNext()) s[cur.getString(0)] = true;
    } finally { if (cur) cur.close(); }
    return s;
  });
  var all = getAllGamesOrdered(); var out=[]; for (var i=0;i<all.length;i++){ if (usedSet[all[i]]) out.push(all[i]); }
  return out;
}

function getAllPlayersInRange(fromStr, toStr){
  var set = DBH.withDB(DB_PATH, function(db){
    var cur=null; var s={};
    try{
      cur = db.rawQuery("SELECT DISTINCT player FROM records_v2 WHERE play_date BETWEEN ? AND ?", [fromStr, toStr]);
      while (cur.moveToNext()) s[cur.getString(0)] = true;
    } finally { if (cur) cur.close(); }
    return s;
  });
  var reg = getAllUsers(); var out=[]; var regSet={}; for (var i=0;i<reg.length;i++) regSet[reg[i]]=true;
  for (var k in set){ if (regSet[k]) out.push(k); }
  out.sort();
  return out;
}

// === 미참가 패널티 보강 ===
// 어떤 날 진행된 각 게임에 대해, 그 게임을 하지 않은 인원은 "그날 참가 인원 수"(=그날 꼴등)
// 등수로 처리한다. 적용 대상은 "그날 1게임이라도 참가한" 등록 유저로 한정한다.
// (그날 아예 참가하지 않은 사람에게는 패널티를 주지 않음)
// gameKeysFilter: 게임키 배열(해당 게임들만) 또는 null(그날 진행된 모든 게임).
// 반환: [{ date, game, player, rank }] — 실제 등수 또는 미참가 패널티 등수.
function loadAugmentedRecords(fromStr, toStr, gameKeysFilter){
  var filterSet = null;
  if (gameKeysFilter){ filterSet = {}; for (var i=0;i<gameKeysFilter.length;i++) filterSet[gameKeysFilter[i]] = true; }

  var reg = getAllUsers(); var regSet = {}; for (var i=0;i<reg.length;i++) regSet[reg[i]] = true;

  // d -> { ranks:{game:{player:rank}}, gamesSet:{game:true}, partSet:{player:true} }
  var dayInfo = {};
  DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try{
      cur = db.rawQuery("SELECT play_date, game, player, rank FROM records_v2 WHERE play_date BETWEEN ? AND ?", [fromStr, toStr]);
      while (cur.moveToNext()){
        var d = cur.getString(0), g = cur.getString(1), p = cur.getString(2), r = cur.getInt(3);
        if (!regSet[p]) continue;        // 미등록 유저는 집계 제외(getAllPlayersInRange 와 동일 기준)
        if (!dayInfo[d]) dayInfo[d] = { ranks:{}, gamesSet:{}, partSet:{} };
        var di = dayInfo[d];
        di.gamesSet[g] = true;
        di.partSet[p] = true;            // 그날 1게임이라도 참가한 인원(게임 필터와 무관)
        if (!di.ranks[g]) di.ranks[g] = {};
        di.ranks[g][p] = r;
      }
    } finally { if (cur) cur.close(); }
  });

  var out = [];
  for (var d in dayInfo){
    var di = dayInfo[d];
    var dayPlayers = []; for (var pp in di.partSet) dayPlayers.push(pp);
    var Pd = dayPlayers.length;        // 그날 참가 인원 수 = 미참가 패널티 등수
    for (var g in di.gamesSet){
      if (filterSet && !filterSet[g]) continue;
      for (var i=0;i<dayPlayers.length;i++){
        var pl = dayPlayers[i];
        var rank = di.ranks[g].hasOwnProperty(pl) ? di.ranks[g][pl] : Pd;
        out.push({ date:d, game:g, player:pl, rank:rank });
      }
    }
  }
  return out;
}

// === 집계 ===
function playerGameStats(gameKey, player, fromStr, toStr){
  var recs = loadAugmentedRecords(fromStr, toStr, [gameKey]);
  var sum=0, played=0; var counts={1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0};
  for (var i=0;i<recs.length;i++){
    var rec = recs[i]; if (rec.game !== gameKey || rec.player !== player) continue;
    var rk = rec.rank; sum+=rk; played++; counts[rk]=(counts[rk]||0)+1;
  }
  return { played: played, counts: counts, avg: (played>0? sum/played : null) };
}

function avgRanksForGame(gameKey, fromStr, toStr){
  var recs = loadAugmentedRecords(fromStr, toStr, [gameKey]);
  var sum={}, cnt={}, per={};
  for (var i=0;i<recs.length;i++){
    var rec = recs[i]; if (rec.game !== gameKey) continue;
    var pl = rec.player, rk = rec.rank;
    if (!sum.hasOwnProperty(pl)){ sum[pl]=0; cnt[pl]=0; per[pl]={1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0}; }
    sum[pl]+=rk; cnt[pl]+=1; per[pl][rk]=(per[pl][rk]||0)+1;
  }
  var arr=[]; for (var p in sum){ if (cnt[p]>0) arr.push({ name:p, avg: sum[p]/cnt[p], played: cnt[p], perRank: per[p] }); }
  return arr;
}

function prettyAvgLines(avgArr, maxRank){
  if (!avgArr.length) return "(해당 기간 기록 없음)";
  avgArr.sort(function(a,b){
    if (a.avg!==b.avg) return a.avg-b.avg;
    return a.name.localeCompare(b.name);
  });
  var n = Math.max(1, maxRank || 1);
  var out = [], currentRank = 1;
  for (var i=0;i<avgArr.length;i++){
    var it = avgArr[i];
    if (i>0 && Math.abs(it.avg-avgArr[i-1].avg) < 1e-9) { }
    else { currentRank = i + 1; }
    out.push(currentRank + "등 " + it.name + " " + it.avg.toFixed(2) + "등");
    var parts = [];
    for (var r=1; r<=n; r++){
      parts.push((it.perRank[r] || 0) + "회");
    }
    out.push("[" + parts.join(", ") + "]");
  }
  return out.join("\n");
}

function slashCounts(counts, maxRank){
  var n = Math.max(1, maxRank || 1);
  var parts = [];
  for (var r = 1; r <= n; r++){
    parts.push((counts[r] || 0));
  }
  return "[" + parts.join("/ ") + "]";
}

function overallAvgArray(fromStr, toStr){
  var res = sumScores(fromStr, toStr);
  var arr = [];
  for (var p in res.scores){
    if (res.counts[p] > 0){
      arr.push({ name: p, avg: res.scores[p] / res.counts[p], played: res.counts[p] });
    }
  }
  arr.sort(function(a,b){ if (a.avg !== b.avg) return a.avg - b.avg; return a.name.localeCompare(b.name); });
  return arr;
}

function overallRankForPlayer(fromStr, toStr, player){
  var arr = overallAvgArray(fromStr, toStr); var rank=0;
  for (var i=0;i<arr.length;i++){ if (i>0 && Math.abs(arr[i].avg - arr[i-1].avg) < 1e-9){} else { rank=i+1; } if (arr[i].name===player) return { rank:rank, avg:arr[i].avg, played:arr[i].played }; }
  return { rank:null, avg:null, played:0 };
}

// === 보기 포맷 ===
function prettyRankLineFromGroups(groups){ var out=[]; for (var i=0;i<groups.length;i++){ var g=groups[i]; out.push(g.length>1? ("("+g.join("")+")") : g[0]); } return out.join(" "); }

// === 기간 파싱 ===
function getFullRangeFromDB(){
  var found = DBH.withDB(DB_PATH, function(db){
    var cur=null;
    try{
      cur = db.rawQuery("SELECT MIN(play_date), MAX(play_date) FROM records_v2", []);
      if (cur.moveToFirst()){ var minD=cur.getString(0), maxD=cur.getString(1); if (minD && maxD) return { from:minD, to:maxD, view: toViewStr(minD)+" ~ "+toViewStr(maxD) }; }
    } finally { if (cur) cur.close(); }
    return null;
  });
  if (found) return found;
  var today=todayStr(); return { from:today, to:today, view: toViewStr(today) };
}

// 단일 날짜 키워드(오늘/어제)를 yyyyMMdd 로 치환 → 범위식 안에서도 사용 가능 (예: 20260101~오늘)
function dayOffsetStr(offset){ var cal=java.util.Calendar.getInstance(PDT_TZ); cal.add(java.util.Calendar.DAY_OF_MONTH, offset); return toDateStr(cal.getTime()); }
function subDayKeywords(s){ return s.replace(/오늘/g, todayStr()).replace(/어제/g, dayOffsetStr(-1)); }

function getRangeFromArg(arg){
  arg = trim(arg||"");
  if (!arg){ var d=todayStr(); return { type:"single", from:d, to:d, view: toViewStr(d) }; }

  // 오늘/어제 → 실제 날짜로 치환 (단독 사용 시 \d{8} 단일 분기로, 범위식 안에서도 동작)
  arg = subDayKeywords(arg);

  if (arg === "전체"){ var rg=getFullRangeFromDB(); return { type:"all", from:rg.from, to:rg.to, view: rg.view }; }
  if (arg === "이번주" || arg === "저번주"){
    var cal=java.util.Calendar.getInstance(PDT_TZ); cal.set(java.util.Calendar.HOUR_OF_DAY,0); cal.set(java.util.Calendar.MINUTE,0); cal.set(java.util.Calendar.SECOND,0); cal.set(java.util.Calendar.MILLISECOND,0);
    cal.setFirstDayOfWeek(java.util.Calendar.MONDAY);
    var dow=cal.get(java.util.Calendar.DAY_OF_WEEK); var diff=((dow+5)%7);
    cal.add(java.util.Calendar.DAY_OF_MONTH, 0-diff - (arg==="저번주"?7:0));
    var from=toDateStr(cal.getTime()); cal.add(java.util.Calendar.DAY_OF_MONTH,6); var to=toDateStr(cal.getTime());
    return { type:"week", from:from, to:to, view: toViewStr(from)+" ~ "+toViewStr(to) };
  }
  if (arg === "이번달" || arg === "저번달"){
    var ca=java.util.Calendar.getInstance(PDT_TZ); ca.set(java.util.Calendar.DAY_OF_MONTH,1); ca.set(java.util.Calendar.HOUR_OF_DAY,0); ca.set(java.util.Calendar.MINUTE,0); ca.set(java.util.Calendar.SECOND,0); ca.set(java.util.Calendar.MILLISECOND,0);
    if (arg==="저번달") ca.add(java.util.Calendar.MONTH,-1);
    var f=toDateStr(ca.getTime()); ca.add(java.util.Calendar.MONTH,1); ca.add(java.util.Calendar.DAY_OF_MONTH,-1); var t=toDateStr(ca.getTime());
    return { type:"month", from:f, to:t, view: toViewStr(f)+" ~ "+toViewStr(t) };
  }
  if (arg === "올해" || arg === "작년"){
    var yr=java.util.Calendar.getInstance(PDT_TZ).get(java.util.Calendar.YEAR) - (arg==="작년"?1:0);
    var f=yr+"0101", t=yr+"1231";
    return { type:"year", from:f, to:t, view: toViewStr(f)+" ~ "+toViewStr(t) };
  }
  var mm = arg.match(/^(\d{1,2})월$/);
  if (mm){
    var mon=parseInt(mm[1],10);
    if (mon>=1 && mon<=12){
      var yr2=java.util.Calendar.getInstance(PDT_TZ).get(java.util.Calendar.YEAR);
      var cm=java.util.Calendar.getInstance(PDT_TZ); cm.clear(); cm.set(yr2, mon-1, 1, 0,0,0);
      var f2=toDateStr(cm.getTime()); cm.add(java.util.Calendar.MONTH,1); cm.add(java.util.Calendar.DAY_OF_MONTH,-1); var t2=toDateStr(cm.getTime());
      return { type:"month", from:f2, to:t2, view: toViewStr(f2)+" ~ "+toViewStr(t2) };
    }
  }
  if (/^\d{8}$/.test(arg)) return { type:"single", from:arg, to:arg, view: toViewStr(arg) };
  var m = arg.match(/^(\d{8})\s*[~-]\s*(\d{8})$/); if (m){ var a=m[1], b=m[2]; if (a>b){ var tmp=a; a=b; b=tmp; } return { type:"range", from:a, to:b, view: toViewStr(a)+" ~ "+toViewStr(b) }; }
  return { error: "기간을 해석할 수 없습니다. (전체/오늘/어제/이번주/저번주/이번달/저번달/n월/올해/작년/yyyyMMdd/yyyyMMdd~yyyyMMdd)" };
}

// === 핸들러: 기록 ===
function handleRecord(msg){
  var lines = msg.split(/\n/); var head = trim(lines[0]); var m = head.match(/^!게임기록(?:\s+(\d{8}))?$/);
  if (!m) return "형식: !게임기록 [yyyyMMdd]\n다음 줄들에 <게임키> 순위 입력 (예: z 이(그명)쫑)";
  var day = m[1] || todayStr();
  var body = lines.slice(1); if (body.length===0) return "기록할 줄이 없습니다.";

  var allowedUsers = getAllUsers(); if (allowedUsers.length===0) return "유저가 1명도 등록되지 않았습니다. 먼저 !유저등록 을 해주세요.";
  var allowedGames = getAllGamesOrdered(); if (allowedGames.length===0) return "게임이 1개도 등록되지 않았습니다. 먼저 !게임등록 을 해주세요.";

  var parsed = parseGameLines(body, allowedUsers, allowedGames); if (parsed.error) return parsed.error;
  saveV2(day, parsed.data);

  var order = getAllGamesOrdered(); var show=[]; for (var i=0;i<order.length;i++){ var g=order[i]; if (parsed.data[g]) show.push(g+" "+prettyRankLineFromGroups(parsed.data[g])); }
  return "[저장 완료] "+toViewStr(day)+"\n"+show.join("\n");
}

// === 핸들러: 종합 순위 ===
function prettyRankBlocksFromScores(scores, counts, days){
  var arr=[]; for (var name in scores){ var avg = (counts[name]>0) ? (scores[name]/counts[name]) : 0; arr.push({name:name, sum:scores[name], avg:avg, count:counts[name], days:(days?days[name]:0)}); }
  arr.sort(function(a,b){ if (a.avg!==b.avg) return a.avg-b.avg; return a.name.localeCompare(b.name); });
  var out=[], currentRank=1;
  for (var i=0;i<arr.length;i++){
    if (i>0 && Math.abs(arr[i].avg-arr[i-1].avg)<1e-9){} else { currentRank=i+1; }
    var line = currentRank+"등 "+arr[i].name+" ("+arr[i].avg.toFixed(2)+")";
    if (days && arr[i].days > 0){
      var gpd = arr[i].days > 0 ? (arr[i].count / arr[i].days).toFixed(1) : "0.0";
      line += " ["+arr[i].sum+"/"+arr[i].days+"/"+gpd+"]";
    }
    out.push(line);
  }
  if (!out.length) out.push("(해당 기간 기록 없음)"); return out.join("\n");
}

function sumScores(fromStr, toStr){
  var recs = loadAugmentedRecords(fromStr, toStr, null);
  var scores={}; var counts={}; var daySet={};
  for (var i=0;i<recs.length;i++){
    var rec = recs[i], p = rec.player;
    if (!scores.hasOwnProperty(p)) { scores[p]=0; counts[p]=0; daySet[p]={}; }
    scores[p]+=rec.rank; counts[p]++; daySet[p][rec.date]=true;
  }
  var days={}; for (var p in daySet){ var c=0; for (var d in daySet[p]) c++; days[p]=c; }
  return { scores:scores, counts:counts, days:days };
}

function handleRank(arg){
  arg = trim(arg); var range = getRangeFromArg(arg); if (range.error) return range.error;
  var res = sumScores(range.from, range.to);
  var days = (range.from !== range.to) ? res.days : null;
  var lines=[]; lines.push("[종합순위] "+range.view); lines.push(prettyRankBlocksFromScores(res.scores, res.counts, days));
  return lines.join("\n");
}

// === 핸들러: 일자 상세 ===
function loadDayV2(dateStr){ return DBH.withDB(DB_PATH, function(db){ var cur=null; var map={}; try{ cur=db.rawQuery("SELECT game, player, rank FROM records_v2 WHERE play_date=? ORDER BY game, rank", [dateStr]); while (cur.moveToNext()){ var g=cur.getString(0), p=cur.getString(1), r=cur.getInt(2); if(!map[g]) map[g]=[]; while (map[g].length<r) map[g].push([]); map[g][r-1].push(p); } } finally { if (cur) cur.close(); } return map; }); }
function handleDetail(argText){
  var range = getRangeFromArg(trim(argText||""));
  if (range.error) return range.error;

  var dates = DBH.withDB(DB_PATH, function(db){
    var cur = null; var d = [];
    try {
      cur = db.rawQuery("SELECT DISTINCT play_date FROM records_v2 WHERE play_date BETWEEN ? AND ? ORDER BY play_date", [range.from, range.to]);
      while (cur.moveToNext()) d.push(cur.getString(0));
    } finally { if (cur) cur.close(); }
    return d;
  });

  if (!dates.length) return range.view + " 기록이 없습니다.";

  var lines = [];

  for (var d = 0; d < dates.length; d++) {
    var dateStr = dates[d];
    var dayMap = loadDayV2(dateStr);
    if (Object.keys(dayMap).length === 0) continue;

    // 게임별 순위 줄(실제 기록 그대로 표시)
    var order = getAllGamesOrdered();
    var gameLines = [];
    for (var i = 0; i < order.length; i++) {
      var gk = order[i];
      if (!dayMap[gk]) continue;
      gameLines.push(gk + " " + prettyRankLineFromGroups(dayMap[gk]));
    }

    // 종합순위 점수: 미참가 패널티(=그날 참가 인원 수) 반영
    var scores = {}, counts = {};
    var recs = loadAugmentedRecords(dateStr, dateStr, null);
    for (var i = 0; i < recs.length; i++) {
      var ch = recs[i].player;
      if (!scores.hasOwnProperty(ch)) { scores[ch] = 0; counts[ch] = 0; }
      scores[ch] += recs[i].rank; counts[ch]++;
    }

    if (d > 0) lines.push("");
    lines.push("[종합순위] " + toViewStr(dateStr));
    lines.push(prettyRankBlocksFromScores(scores, counts));
    lines.push("");
    lines.push("[게임별 순위]");
    for (var i = 0; i < gameLines.length; i++) lines.push(gameLines[i]);
  }

  var result = lines.join("\n");
  if (dates.length === 1) {
    var timeSection = buildTimeSection(dates[0]);
    if (timeSection) result += LONG_MSG_SPACER + "\n\n" + timeSection;
  }
  return result;
}

// === 시간 표시 ===
function formatTime(secs) {
  var m = Math.floor(secs / 60);
  var s = secs % 60;
  return m + ":" + (s < 10 ? "0" + s : "" + s);
}

function buildTimeSection(dateStr) {
  var gameData = DBH.withDB(DB_PATH, function(db){
    var cur = null; var gd = {};
    try {
      cur = db.rawQuery(
        "SELECT game, player, rank, time FROM records_v2 WHERE play_date=? ORDER BY game, rank",
        [dateStr]
      );
      while (cur.moveToNext()) {
        var g = cur.getString(0), p = cur.getString(1), r = cur.getInt(2);
        var t = cur.isNull(3) ? null : cur.getInt(3);
        if (!gd[g]) gd[g] = [];
        gd[g].push({ player: p, rank: r, time: t });
      }
    } finally { if (cur) cur.close(); }
    return gd;
  });

  var allGames = getAllGamesOrdered();
  var usedGames = [];
  for (var i = 0; i < allGames.length; i++) {
    if (gameData[allGames[i]]) usedGames.push(allGames[i]);
  }
  if (!usedGames.length) return null;

  for (var i = 0; i < usedGames.length; i++) {
    var rows = gameData[usedGames[i]];
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].time === null) return null;
    }
  }

  var lines = [];
  for (var i = 0; i < usedGames.length; i++) {
    var gk = usedGames[i];
    if (i > 0) lines.push("");
    lines.push(gk);
    var rows = gameData[gk];
    for (var j = 0; j < rows.length; j++) {
      lines.push(rows[j].rank + " " + rows[j].player + " " + formatTime(rows[j].time));
    }
  }
  return lines.join("\n");
}

// === 핸들러: 특정 종목 평균 순위 ===
function handleGameAvg(argText){
  var parts = trim(argText||"").split(/\s+/).filter(Boolean);
  if (parts.length===0) return "형식: !게임순위 [게임키] [전체|오늘|어제|이번주|저번주|이번달|저번달|n월|올해|작년|yyyyMMdd|yyyyMMdd~yyyyMMdd]\n예) !게임순위 q 이번주";
  var gameKey = parts[0].toLowerCase(); if (!/^[A-Za-z]$/.test(gameKey)) return "게임키는 1글자 영문이어야 합니다."; if (!gameExists(gameKey)) return "미등록 게임입니다: "+gameKey;
  var range; if (parts.length===1){ range=getFullRangeFromDB(); } else { range=getRangeFromArg(parts.slice(1).join(" ")); if (range.error) return range.error; }
  var avgArr = avgRanksForGame(gameKey, range.from, range.to);
  var nPlayers = getAllPlayersInRange(range.from, range.to).length;
  var title = "["+gameKey+" 순위] "+range.view;
  var body = prettyAvgLines(avgArr, nPlayers);
  return title+"\n"+body;
}

// === 핸들러: 유저 전적 요약 ===
function rankInGameByAvg(gameKey, fromStr, toStr, player){ var arr = avgRanksForGame(gameKey, fromStr, toStr); if (!arr.length) return null; arr.sort(function(a,b){ if (a.avg!==b.avg) return a.avg-b.avg; return a.name.localeCompare(b.name); }); var rank=0; for (var i=0;i<arr.length;i++){ if (i>0 && Math.abs(arr[i].avg-arr[i-1].avg)<1e-9){} else { rank=i+1; } if (arr[i].name===player){ return { rank:rank, avg:arr[i].avg, perRank:arr[i].perRank, played:arr[i].played }; } } return null; }

function userStatsSummary(player, fromStr, toStr, viewLabel){
  var games = getGamesInRangeOrdered(fromStr, toStr);
  var nPlayers = getAllPlayersInRange(fromStr, toStr).length;
  var titleLabel = (viewLabel==="__ALL__") ? (toViewStr(fromStr)+" ~ "+toViewStr(toStr)) : viewLabel;

  var headerGames = (games.length ? games.join(" ") : "");
  var lines = [];
  lines.push(player + (headerGames ? (" " + headerGames) : "") + " 전적\n" + titleLabel);

  for (var i=0; i<games.length; i++){
    var g = games[i];
    var st = playerGameStats(g, player, fromStr, toStr);
    var rankInfo = rankInGameByAvg(g, fromStr, toStr, player);
    var rankTxt = (rankInfo && rankInfo.rank) ? (rankInfo.rank + "등") : "-";
    var avgTxt  = (st.avg != null) ? (st.avg.toFixed(2) + "등") : "-";
    lines.push(g + " " + rankTxt + " " + slashCounts(st.counts, nPlayers) + " avg " + avgTxt);
  }

  var ov = overallRankForPlayer(fromStr, toStr, player);
  var ovRankTxt = (ov.rank ? (ov.rank + "등") : "-");
  var ovAvgTxt  = (ov.avg != null) ? (ov.avg.toFixed(2) + "등") : "-";
  lines.push("전체 " + ovRankTxt + "            avg " + ovAvgTxt);

  return lines.join("\n");
}

function handlePerfectWins(player){
  if (!userExists(player)) return "미등록 유저입니다: " + player;

  var rows = DBH.withDB(DB_PATH, function(db){
    var cur = null;
    var rr = [];
    try {
      cur = db.rawQuery(
        "SELECT play_date, GROUP_CONCAT(DISTINCT game) " +
        "FROM records_v2 " +
        "GROUP BY play_date " +
        "HAVING COUNT(DISTINCT game) = COUNT(DISTINCT CASE WHEN player=? AND rank=1 THEN game END) " +
        "ORDER BY play_date ASC",
        [player]
      );
      while (cur.moveToNext()) rr.push({ date: cur.getString(0), games: cur.getString(1) });
    } finally { if(cur) cur.close(); }
    return rr;
  });

  if (rows.length === 0) return player + "의 완승 기록이 없습니다.";

  var allGames = getAllGamesOrdered();
  var orderIdx = {};
  for (var i=0;i<allGames.length;i++) orderIdx[allGames[i]] = i;
  function sortGames(s){
    var arr = (s||"").split(",");
    arr.sort(function(a,b){
      var ia = (a in orderIdx) ? orderIdx[a] : 999;
      var ib = (b in orderIdx) ? orderIdx[b] : 999;
      if (ia !== ib) return ia - ib;
      return a.localeCompare(b);
    });
    return arr.join("");
  }

  var out = [];
  out.push(player + "의 완승 횟수 : " + rows.length + "회");
  out.push("완승날짜" + LONG_MSG_SPACER);
  for (var i=0;i<rows.length;i++){
    out.push(toViewStr(rows[i].date) + " " + sortGames(rows[i].games));
  }
  return out.join("\n");
}

function handleRankStats(player){
  if (!userExists(player)) return "미등록 유저입니다: " + player;

  var rg = getFullRangeFromDB();
  var dayMap = DBH.withDB(DB_PATH, function(db){
    var cur=null;
    var dm = {};
    try {
      cur = db.rawQuery(
        "SELECT play_date, player, rank FROM records_v2 ORDER BY play_date, player",
        []
      );
      while (cur.moveToNext()){
        var d = cur.getString(0);
        var p = cur.getString(1);
        var r = cur.getInt(2);
        if (!dm[d]) dm[d] = {};
        if (!dm[d][p]) dm[d][p] = 0;
        dm[d][p] += r;
      }
    } finally { if (cur) cur.close(); }
    return dm;
  });

  var rankCount = {1:0, 2:0, 3:0, 4:0};
  var totalDays = 0;

  for (var d in dayMap){
    var players = [];
    for (var p in dayMap[d]){
      players.push({name:p, score:dayMap[d][p]});
    }
    if (players.length === 0) continue;
    totalDays++;

    players.sort(function(a,b){
      if (a.score !== b.score) return a.score - b.score;
      return a.name.localeCompare(b.name);
    });

    var currentRank = 1;
    for (var i=0;i<players.length;i++){
      if (i>0 && players[i].score !== players[i-1].score)
        currentRank = i + 1;
      if (players[i].name === player){
        if (currentRank >=1 && currentRank <=4)
          rankCount[currentRank] = (rankCount[currentRank]||0)+1;
        break;
      }
    }
  }

  if (totalDays === 0) return "기록이 없습니다.";

  var lines=[];
  lines.push(rg.view);
  lines.push(player + " 종합등수통계");
  lines.push("1등 : " + (rankCount[1]||0) + "회");
  lines.push("2등 : " + (rankCount[2]||0) + "회");
  lines.push("3등 : " + (rankCount[3]||0) + "회");
  lines.push("4등 : " + (rankCount[4]||0) + "회");
  return lines.join("\n");
}

function handleUserRecord(argText){
  var parts = trim(argText||"").split(/\s+/).filter(Boolean);
  if (parts.length===0) return "형식: !게임순위 [이름] [전체|오늘|어제|이번주|저번주|이번달|저번달|n월|올해|작년|yyyyMMdd|yyyyMMdd~yyyyMMdd]\n예) !게임순위 쫑";
  var player = parts[0]; if (!userExists(player)) return "미등록 유저입니다: "+player;
  var from,to,view; if (parts.length===1){ var rg=getFullRangeFromDB(); from=rg.from; to=rg.to; view="__ALL__"; } else { var r=getRangeFromArg(parts.slice(1).join(" ")); if (r.error) return r.error; from=r.from; to=r.to; view=r.view; }
  return userStatsSummary(player, from, to, view);
}

function parseMultiGameKeys(str){
  if (!/^[A-Za-z]+$/.test(str)) return null;
  var keys = str.toLowerCase().split("");
  var out = [];
  for (var i=0;i<keys.length;i++){
    if (!gameExists(keys[i])) return null;
    if (out.indexOf(keys[i]) === -1) out.push(keys[i]);
  }
  return out;
}

function sumScoresForGames(gameKeys, fromStr, toStr){
  var recs = loadAugmentedRecords(fromStr, toStr, gameKeys);
  var scores = {}, counts = {}, daySet = {};
  for (var i=0;i<recs.length;i++){
    var rec = recs[i], p = rec.player;
    if (!scores.hasOwnProperty(p)){ scores[p]=0; counts[p]=0; daySet[p]={}; }
    scores[p] += rec.rank; counts[p]++; daySet[p][rec.date] = true;
  }
  var days = {};
  for (var p in daySet){ var c=0; for (var d in daySet[p]) c++; days[p] = c; }
  return { scores: scores, counts: counts, days: days };
}

// function avgRanksForMultiGames(gameKeys, fromStr, toStr){
//   var players = getAllPlayersInRange(fromStr, toStr);

//   var sum = {}, cnt = {};
//   for (var i=0;i<players.length;i++){
//     sum[players[i]] = 0;
//     cnt[players[i]] = 0;
//   }

//   var placeholders = gameKeys.map(function(){ return "?"; }).join(",");

//   var db = openDB();
//   var cur = null;
//   try {
//     cur = db.rawQuery(
//       "SELECT player, rank FROM records_v2 " +
//       "WHERE game IN (" + placeholders + ") " +
//       "AND play_date BETWEEN ? AND ?",
//       gameKeys.concat([fromStr, toStr])
//     );

//     while (cur.moveToNext()){
//       var p = cur.getString(0);
//       var r = cur.getInt(1);
//       if (sum.hasOwnProperty(p)){
//         sum[p] += r;
//         cnt[p] += 1;
//       }
//     }
//   } finally {
//     if (cur) cur.close();
//     db.close();
//   }

//   var result = [];
//   for (var p in sum){
//     if (cnt[p] > 0){
//       result.push({
//         name: p,
//         avg: sum[p] / cnt[p],
//         played: cnt[p]
//       });
//     }
//   }

//   result.sort(function(a,b){
//     if (a.avg !== b.avg) return a.avg - b.avg;
//     return a.name.localeCompare(b.name);
//   });

//   return result;
// }

// function prettyMultiGameAvgRanks(arr){
//   if (!arr.length) return "(해당 기간 기록 없음)";

//   var out = [];
//   var currentRank = 1;

//   for (var i=0;i<arr.length;i++){
//     if (i>0 && Math.abs(arr[i].avg - arr[i-1].avg) > 1e-9){
//       currentRank = i + 1;
//     }
//     out.push(
//       currentRank + "등 " +
//       arr[i].name + " (" +
//       arr[i].avg.toFixed(2) + ")"
//     );
//   }

//   return out.join("\n");
// }

function defaultMultiGameKeys(){
  var all = getAllGamesOrdered();
  var allSet = {};
  for (var i=0;i<all.length;i++) allSet[all[i]] = true;
  var pref = ["z","q","t","s","p"];
  var out = [];
  for (var i=0;i<pref.length;i++){
    if (allSet[pref[i]]) out.push(pref[i]);
  }
  return out.join("");
}

function handleMultiGameRank(gameKeyStr, rangeArg){
  var gameKeys = parseMultiGameKeys(gameKeyStr);
  if (!gameKeys) return "게임키 형식 오류 또는 미등록 게임 포함";

  var range = getRangeFromArg(rangeArg);
  if (range.error) return range.error;

  // 단일 날짜이면 게임키와 무관하게 그날의 일자 상세 폼으로 출력
  if (range.from === range.to) return handleDetail(rangeArg);

  var res = sumScoresForGames(gameKeys, range.from, range.to);
  var title = "[" + gameKeys.join("") + " 순위] " + range.view;
  var body = prettyRankBlocksFromScores(res.scores, res.counts, res.days);

  // 각 게임별 상세 순위 블록 생성
  var nPlayers = getAllPlayersInRange(range.from, range.to).length;
  var detailLines = [];
  for (var i = 0; i < gameKeys.length; i++){
    var gk = gameKeys[i];
    var avgArr = avgRanksForGame(gk, range.from, range.to);
    detailLines.push("[" + gk + " 순위]");
    detailLines.push(prettyAvgLines(avgArr, nPlayers));
    if (i < gameKeys.length - 1) detailLines.push("");
  }

  return title + "\n" + body + "\n======[" + gameKeys.join("") + "] 상세 순위======" + LONG_MSG_SPACER + "\n" + detailLines.join("\n");
}

function handleUnifiedRank(argText){
  var txt = trim(argText||"");
  if (!txt) return handleDetail("오늘");

  var parts = txt.split(/\s+/).filter(Boolean);
  var first = parts[0];

  var multiGames = parseMultiGameKeys(first);
  if (multiGames && multiGames.length > 1){
    return handleMultiGameRank(
      first,
      parts.slice(1).join(" ") || "전체"
    );
  }

  var isUser = userExists(first);
  var isGame = gameExists(first.toLowerCase());

  if (isUser) return handleUserRecord(parts.join(" "));
  if (isGame) return handleGameAvg(parts.join(" "));

  var range = getRangeFromArg(txt);
  if (!range.error && range.from === range.to) return handleDetail(txt);

  return handleMultiGameRank(defaultMultiGameKeys(), txt);
}

function loadDailyOverallScores(fromStr, toStr){
  return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    var dayMap = {};

    try {
      cur = db.rawQuery(
        "SELECT play_date, player, rank " +
        "FROM records_v2 " +
        "WHERE play_date BETWEEN ? AND ? " +
        "ORDER BY play_date, player",
        [fromStr, toStr]
      );

      while (cur.moveToNext()){
        var d = cur.getString(0);
        var p = cur.getString(1);
        var r = cur.getInt(2);

        if (!dayMap[d]) dayMap[d] = {};
        if (!dayMap[d][p]) dayMap[d][p] = 0;

        dayMap[d][p] += r;
      }
    } finally {
      if (cur) cur.close();
    }

    return dayMap;
  });
}

function calcDailyOverallRanks(dayScores){
  var arr = [];

  for (var p in dayScores){
    arr.push({ name: p, score: dayScores[p] });
  }

  arr.sort(function(a,b){
    if (a.score !== b.score) return a.score - b.score;
    return a.name.localeCompare(b.name);
  });

  var ranks = {};
  var currentRank = 1;

  for (var i=0;i<arr.length;i++){
    if (i>0 && arr[i].score !== arr[i-1].score){
      currentRank = i + 1;
    }
    ranks[arr[i].name] = currentRank;
  }

  return ranks;
}

function monthlyAvgOverallRanks(fromStr, toStr){
  var dayMap = loadDailyOverallScores(fromStr, toStr);

  var acc = {};

  for (var d in dayMap){
    var dailyRanks = calcDailyOverallRanks(dayMap[d]);

    for (var p in dailyRanks){
      if (!acc[p]) acc[p] = { sum: 0, days: 0 };
      acc[p].sum += dailyRanks[p];
      acc[p].days += 1;
    }
  }

  var result = [];
  for (var p in acc){
    result.push({
      name: p,
      avg: acc[p].sum / acc[p].days,
      days: acc[p].days
    });
  }

  result.sort(function(a,b){
    if (a.avg !== b.avg) return a.avg - b.avg;
    return a.name.localeCompare(b.name);
  });

  return result;
}

function prettyMonthlyAvgOverallRanks(arr){
  if (!arr.length) return "(해당 기간 기록 없음)";

  var out = [];
  var currentRank = 1;

  for (var i=0;i<arr.length;i++){
    if (i>0 && Math.abs(arr[i].avg - arr[i-1].avg) > 1e-9){
      currentRank = i + 1;
    }
    out.push(
      currentRank + "등 " +
      arr[i].name + " (" +
      arr[i].avg.toFixed(2) + ")"
    );
  }

  return out.join("\n");
}

function handleMonthlyAvgOverallRank(arg){
  var range = getRangeFromArg(arg);
  if (range.error) return range.error;

  var arr = monthlyAvgOverallRanks(range.from, range.to);

  var lines = [];
  lines.push("[월간 종합등수 평균] " + range.view);
  lines.push(prettyMonthlyAvgOverallRanks(arr));

  return lines.join("\n");
}

// =====================================================================
// !자동기록 — notifications 파일 파싱 → records + records_v2 자동 저장
// =====================================================================

var HISTORY_DIR = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/zqt_history/";

var NOTIFY_DATE_FMT = new java.text.SimpleDateFormat("yyyy-MM-dd");
NOTIFY_DATE_FMT.setTimeZone(PDT_TZ);
function todayNotifyDateStr(){ return NOTIFY_DATE_FMT.format(new java.util.Date()); }

var USER_MAPPING = {
  '박현식': '이',
  '신종화': '쫑',
  '김수민': '그',
  '송수익': '명',
  '김다현': '먐'
};

var GAME_MAPPING = {
  'Zip': 'z',
  'Queens': 'q',
  'Tango': 't',
  'Mini Sudoku': 's',
  'Patches': 'p'
};

function readNotificationsFile(notifyDateStr) {
  var d = notifyDateStr || todayNotifyDateStr();
  var filePath = HISTORY_DIR + "notifications_" + d + ".txt";
  var file = new java.io.File(filePath);
  if (!file.exists()) return { path: filePath, content: null };
  var sb = new java.lang.StringBuilder();
  var br = new java.io.BufferedReader(new java.io.InputStreamReader(new java.io.FileInputStream(file), "UTF-8"));
  var line;
  while ((line = br.readLine()) !== null) { sb.append(line).append("\n"); }
  br.close();
  return { path: filePath, content: sb.toString() };
}

function parseGameResultFromContent(content) {
  for (var gameName in GAME_MAPPING) {
    if (!GAME_MAPPING.hasOwnProperty(gameName)) continue;
    var gameCode = GAME_MAPPING[gameName];

    // 패턴 1: "GameName #번호 | M:SS" (한 줄)
    var match1 = content.match(new RegExp(gameName + '\\s+#\\d+\\s+\\|\\s+(\\d+):(\\d+)'));
    if (match1) return { game: gameCode, time: parseInt(match1[1], 10) * 60 + parseInt(match1[2], 10) };

    // 패턴 2: "GameName #번호" 단독 줄, 다음 줄에 "M:SS"
    var pattern2 = new RegExp(gameName + '\\s+#\\d+\\s*(?:\\n|$)');
    var match2 = content.match(pattern2);
    if (match2) {
      var afterMatch = content.slice(content.indexOf(match2[0]) + match2[0].length);
      var timeMatch = afterMatch.match(/^(\d+):(\d+)/m);
      if (timeMatch) return { game: gameCode, time: parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10) };
    }
  }
  return null;
}

function extractPlayerFromTitle(title) {
  var m = title.match(/새\s*메시지\s*\d+\s*:\s*(.+)$/);
  if (!m) return null;
  var nameAndGroup = trim(m[1]);

  if (USER_MAPPING[nameAndGroup]) return USER_MAPPING[nameAndGroup];

  // "이름 - 그룹" 형식 (예: "박현식 - ZQT")
  var dm = nameAndGroup.match(/^(.+?)\s*-\s*.+$/);
  if (dm && USER_MAPPING[trim(dm[1])]) return USER_MAPPING[trim(dm[1])];

  return null;
}

function parseNotificationsFile(content) {
  if (!content) return [];
  var blocks = content.split(/\n?---+\n?/);
  var entries = [];
  var seen = {};

  for (var i = 0; i < blocks.length; i++) {
    var block = trim(blocks[i]);
    if (!block) continue;

    var titleMatch = block.match(/제목\s*:\s*(.+)/);
    if (!titleMatch) continue;
    var player = extractPlayerFromTitle(trim(titleMatch[1]));
    if (!player) continue;

    var contentMatch = block.match(/내용\s*:\s*([\s\S]+)/);
    if (!contentMatch) continue;
    var msgContent = trim(contentMatch[1]);

    var result = parseGameResultFromContent(msgContent);
    if (!result) continue;

    var key = result.game + ":" + player;
    if (seen[key]) continue;
    seen[key] = true;
    entries.push({ game: result.game, player: player, time: result.time });
  }
  return entries;
}

function upsertV2(db, dateStr, game, player, rank, time) {
  var st = db.compileStatement(
    "UPDATE records_v2 SET rank=?, time=COALESCE(?, time) WHERE play_date=? AND game=? AND player=?"
  );
  st.bindLong(1, rank);
  if (time != null) st.bindLong(2, time); else st.bindNull(2);
  st.bindString(3, dateStr);
  st.bindString(4, game);
  st.bindString(5, player);
  var changed = st.executeUpdateDelete(); st.close();

  if (changed === 0) {
    var st2 = db.compileStatement(
      "INSERT INTO records_v2(play_date, game, player, rank, time) VALUES(?,?,?,?,?)"
    );
    st2.bindString(1, dateStr);
    st2.bindString(2, game);
    st2.bindString(3, player);
    st2.bindLong(4, rank);
    if (time != null) st2.bindLong(5, time); else st2.bindNull(5);
    st2.execute(); st2.close();
  }
}

function calcRanksFromEntries(entries) {
  var byGame = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!byGame[e.game]) byGame[e.game] = [];
    byGame[e.game].push({ player: e.player, time: e.time });
  }

  var result = {};
  for (var g in byGame) {
    if (!byGame.hasOwnProperty(g)) continue;
    var arr = byGame[g];
    arr.sort(function(a, b) { return a.time - b.time; });

    var groups = [];
    var i = 0;
    while (i < arr.length) {
      var j = i;
      var curTime = arr[i].time;
      var grp = [];
      while (j < arr.length && arr[j].time === curTime) {
        grp.push(arr[j].player);
        j++;
      }
      groups.push(grp);
      i = j;
    }
    result[g] = groups;
  }
  return result;
}

function handleAutoRecord(dateArg) {
  var notifyDateStr, dbDateStr;
  if (dateArg) {
    dateArg = trim(dateArg);
    var ma = dateArg.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var mb = dateArg.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (ma) {
      notifyDateStr = dateArg;
      dbDateStr = ma[1] + ma[2] + ma[3];
    } else if (mb) {
      notifyDateStr = mb[1] + "-" + mb[2] + "-" + mb[3];
      dbDateStr = dateArg;
    } else {
      return "날짜 형식 오류. yyyy-MM-dd 또는 yyyyMMdd 사용";
    }
  } else {
    notifyDateStr = todayNotifyDateStr();
    dbDateStr = todayStr();
  }

  var fileResult = readNotificationsFile(notifyDateStr);
  if (!fileResult.content) return "파일을 찾을 수 없습니다.\n경로: " + fileResult.path;

  var entries = parseNotificationsFile(fileResult.content);
  if (!entries.length) return notifyDateStr + " 날짜의 기록이 없습니다.";

  var timeMap = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!timeMap[e.game]) timeMap[e.game] = {};
    timeMap[e.game][e.player] = e.time;
  }

  // rankGroups 는 콜백 밖(출력 루프, 아래)에서도 쓰이므로 handleAutoRecord 스코프에서 선언해야 한다.
  // (이전엔 transaction 콜백 안에서 var 선언 → 콜백 밖 출력부에서 ReferenceError 로 reply 가 안 나갔음.
  //  DB 쓰기는 콜백 안에서 이미 커밋돼 "기록은 되는데 출력만 안 나오는" 증상이었음.)
  // calcRanksFromEntries 는 entries 만 쓰는 순수 계산이라 DB 쓰기 전에 미리 구해도 안전.
  var rankGroups = calcRanksFromEntries(entries);

  DBH.withDB(DB_PATH, function(db){
    DBH.transaction(db, function(db){
      for (var g in rankGroups) {
        if (!rankGroups.hasOwnProperty(g)) continue;
        var groups = rankGroups[g];
        var currentRank = 1;
        for (var r = 0; r < groups.length; r++) {
          var grp = groups[r];
          for (var k = 0; k < grp.length; k++) {
            var t = (timeMap[g] && timeMap[g][grp[k]] != null) ? timeMap[g][grp[k]] : null;
            upsertV2(db, dbDateStr, g, grp[k], currentRank, t);
          }
          currentRank += grp.length;
        }
      }
    });
  });

  var lines = [];
  lines.push("[자동기록 완료] " + toViewStr(dbDateStr));

  var allGames = getAllGamesOrdered();
  for (var i = 0; i < allGames.length; i++) {
    var gk = allGames[i];
    if (!rankGroups[gk]) continue;
    lines.push(gk + " " + prettyRankLineFromGroups(rankGroups[gk]));
  }

  return lines.join("\n");
}

// =====================================================================
// 메시지 핸들러
// =====================================================================

/**
 * (string) msg.content: 메시지의 내용
 * (string) msg.room: 메시지를 받은 방 이름
 * (User) msg.author: 메시지 전송자
 * (string) msg.author.name: 메시지 전송자 이름
 * (Image) msg.author.avatar: 메시지 전송자 프로필 사진
 * (string) msg.author.avatar.getBase64()
 * (string | null) msg.author.hash: 사용자의 고유 id
 * (boolean) msg.isGroupChat: 단체/오픈채팅 여부
 * (boolean) msg.isDebugRoom: 디버그룸에서 받은 메시지일 시 true
 * (string) msg.packageName: 메시지를 받은 메신저의 패키지명
 * (void) msg.reply(string): 답장하기
 * (boolean) msg.isMention: 메세지 맨션 포함 여부
 * (bigint) msg.logId: 각 메세지의 고유 id
 * (bigint) msg.channelId: 각 방의 고유 id
 */
function handleMessage(msg) {
  var text = trim(msg.content);

  if (/^!월간종합등수(\s+.*)?$/.test(text)){
    var arg = trim(text.replace(/^!월간종합등수/, ""));
    msg.reply(handleMonthlyAvgOverallRank(arg || "이번달"));
    return;
  }
  if (text === "!자동기록" || /^!자동기록\s+\S/.test(text)){ var autoArg = trim(text.replace(/^!자동기록/, "")) || null; msg.reply(handleAutoRecord(autoArg)); return; }
  if (/^!유저등록\s+.+$/.test(text)){ var name=trim(text.replace(/^!유저등록\s+/, "")); msg.reply(registerUser(name)); return; }
  if (/^!게임등록\s+.+$/.test(text)){ var key=trim(text.replace(/^!게임등록\s+/, "")); msg.reply(registerGame(key)); return; }
  if (/^!게임기록(\s+\d{8})?(\n|$)/.test(text)){ msg.reply(handleRecord(text)); return; }
  if (/^!게임순위(\s+.*)?$/.test(text)){ var arg = trim(text.replace(/^!게임순위/, "")); msg.reply(handleUnifiedRank(arg)); return; }
  if (/^!완승기록\s+.+$/.test(text)){ var name=trim(text.replace(/^!완승기록\s+/, "")); msg.reply(handlePerfectWins(name)); return; }
  if (/^!등수통계\s+.+$/.test(text)){ var name=trim(text.replace(/^!등수통계\s+/, "")); msg.reply(handleRankStats(name)); return; }
  if (text === "!zqt"){
    var g = getAllGamesOrdered();
    msg.reply(
      "[zqt 설명서]\n"+
      "!게임기록 [yyyyMMdd]\nz 이 그 (명쫑)\nq 이 명 그 쫑\n"+
      "\n"+
      "!게임순위 [게임키] [전체|오늘|어제|이번주|저번주|이번달|저번달|n월|올해|작년|yyyyMMdd|yyyyMMdd~yyyyMMdd]\n"+
      "!완승기록 [이름]\n"+
      "!등수통계 [이름]"
    );
    return;
  }
}

// ─── 프리필터: "!" 로 시작하는 명령만 처리 ──────────────────────────────────
function isMyCommand(text) {
  return !!text && trim(text).indexOf("!") === 0;
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독, 공용 subscriber 모듈 사용) ───
var WORKER_NAME = "ZQT_BOT_WORKER";

var subscribe = (function() {
  var libPath = "/sdcard/msgbot/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/subscriber.js";
    }
  } catch(_) {}
  return require(libPath);
})();

subscribe(BOT_NAME, WORKER_NAME, function(msg) {
  if (!isMyCommand(msg.content)) return;
  handleMessage(msg);
});


function onMessage(rawMsg) {}  // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);


function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);


function onCreate(savedInstanceState, activity) {
  var textView = new Packages.android.widget.TextView(activity);
  textView.setText("Hello, World!");
  textView.setTextColor(Packages.android.graphics.Color.DKGRAY);
  activity.setContentView(textView);
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