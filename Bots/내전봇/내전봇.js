const bot = BotManager.getCurrentBot();

// =====================================================================
// 내전봇 — userhash 기반 닉네임 연결
//  - users(hash PK, lol_nickname, room): hash↔롤닉네임↔방 연결
//  - players(lol_nickname PK, room, stats...): 롤닉네임 기준 전적
//  - 하나의 lol_nickname에 최대 2개 hash 허용 (방이 달라 hash가 다른 경우)
//  - !닉네임등록: 신규등록 + 같은 hash로 닉변 모두 처리
//  - !닉네임재등록: 카카오계정 변경으로 hash가 바뀐 경우 재연결
//  - !챔프: 이 hash로 등록된 모든 lol_nickname 후보와 매칭
//  - !통계, !파트너순위, !상대전적: 인수없음=본인, @카카오이름=hash경유
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독.
//   ChatManager 가 켜져 있어야 동작.
//
// ⚠️ hash 형식 변경:
//   이전: msgbot 의 msg.author.hash
//   이후: KakaoTalk DB 의 user_id (ChatManager 가 넘겨줌)
//   기존 users 테이블의 등록 정보는 옛 해시 기반이라 새 hash 와 매칭 안 됨.
//   → 모든 사용자가 !닉네임등록 [롤닉] 으로 한 번 재등록 필요.
// =====================================================================

const BOT_NAME = "내전봇";

const DB_PATH = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/내전봇.db";

function openDB() {
    return Packages.android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(DB_PATH, null);
}

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

function initDatabase() {
    DBH.withDB(DB_PATH, function(db){
    try {
        // users: hash(PK) ↔ lol_nickname + 등록한 방
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS users (" +
            "hash TEXT PRIMARY KEY, " +
            "lol_nickname TEXT NOT NULL, " +
            "room TEXT NOT NULL, " +
            "created_at DATETIME DEFAULT CURRENT_TIMESTAMP, " +
            "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
        );
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_users_lol ON users(lol_nickname)");

        // players: lol_nickname(PK) + 전적
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS players (" +
            "lol_nickname TEXT PRIMARY KEY, " +
            "wins INTEGER DEFAULT 0, " +
            "losses INTEGER DEFAULT 0, " +
            "total_games INTEGER DEFAULT 0, " +
            "win_rate REAL DEFAULT 0.0, " +
            "created_at DATETIME DEFAULT CURRENT_TIMESTAMP, " +
            "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
        );

        db.execSQL(
            "CREATE TABLE IF NOT EXISTS games (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "game_date DATETIME DEFAULT CURRENT_TIMESTAMP, " +
            "left_team TEXT NOT NULL, " +
            "right_team TEXT NOT NULL, " +
            "left_team_champions TEXT, " +
            "right_team_champions TEXT, " +
            "winning_team TEXT CHECK(winning_team IN ('left', 'right')), " +
            "game_duration TEXT, " +
            "notes TEXT)"
        );

        db.execSQL(
            "CREATE TABLE IF NOT EXISTS game_participants (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "game_id INTEGER, " +
            "lol_nickname TEXT NOT NULL, " +
            "team TEXT CHECK(team IN ('left', 'right')), " +
            "is_winner BOOLEAN, " +
            "FOREIGN KEY (game_id) REFERENCES games (id))"
        );

        db.execSQL(
            "CREATE TABLE IF NOT EXISTS hiding_players (" +
            "lol_nickname TEXT PRIMARY KEY, " +
            "created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
        );



    } finally {  }
    });
}
initDatabase();

// =====================================================================
// users: hash ↔ lol_nickname 연결
// =====================================================================

// hash로 롤닉네임 조회
function getNicknameFromHash(hash) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery("SELECT lol_nickname FROM users WHERE hash=?", [hash]);
        if (cur.moveToFirst()) return cur.getString(0);
        return null;
    } catch(e) { return null; }
    finally { if (cur) cur.close(); }
    });
}

// 카카오이름으로 hash 조회 (userhash DB 참조)
function getHashByKakaoName(kakaoName) {
    var HASH_DB_PATH = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/userhash.db";
    return DBH.withDB(HASH_DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery("SELECT hash FROM userhash WHERE name=? LIMIT 1", [kakaoName]);
        if (cur.moveToFirst()) return cur.getString(0);
        return null;
    } catch(e) { return null; }
    finally { if (cur) cur.close(); }
    });
}

// 카카오이름(@sender) → 롤닉네임
function getNicknameFromKakaoName(kakaoName) {
    var h = getHashByKakaoName(kakaoName);
    if (!h) return null;
    return getNicknameFromHash(h);
}

// 롤닉네임에 연결된 hash 개수 조회
function getHashCountByLolNickname(lolNickname) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery("SELECT COUNT(*) FROM users WHERE lol_nickname=?", [lolNickname]);
        if (cur.moveToFirst()) return cur.getInt(0);
        return 0;
    } catch(e) { return 0; }
    finally { if (cur) cur.close(); }
    });
}

// 닉네임 등록 / 닉네임 변경 통합 처리
// - 신규: INSERT users + INSERT players
// - 같은 hash로 다른 lol_nickname: UPDATE users + players 연쇄 업데이트
// - lol_nickname hash 2개 초과 시 거부
function insertNickname(hash, lolNickname, room) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        // 이 hash가 이미 등록되어 있는지 확인
        cur = db.rawQuery("SELECT lol_nickname FROM users WHERE hash=?", [hash]);
        var existingNick = cur.moveToFirst() ? cur.getString(0) : null;
        cur.close(); cur = null;

        if (existingNick !== null) {
            // 이미 같은 닉네임이면 중복
            if (existingNick === lolNickname) {
                return { success: false, message: "이미 '" + lolNickname + "'(으)로 등록되어 있습니다." };
            }
            // 닉네임 변경: 새 lol_nickname의 hash 수 체크
            var newNickHashCount = getHashCountByLolNickname(lolNickname);
            if (newNickHashCount >= 2) {
                return { success: false, message: "'" + lolNickname + "'은(는) 이미 2개 계정에 연결되어 있어 추가 연결이 불가합니다." };
            }
            var oldNick = existingNick;
            // users 업데이트
            db.execSQL("UPDATE users SET lol_nickname=?, room=?, updated_at=CURRENT_TIMESTAMP WHERE hash=?",
                [lolNickname, room, hash]);
            // players: 새 닉네임 없으면 INSERT, 있으면 기존 전적 이전
            cur = db.rawQuery("SELECT lol_nickname FROM players WHERE lol_nickname=?", [lolNickname]);
            var newExists = cur.moveToFirst();
            cur.close(); cur = null;
            if (!newExists) {
                // 기존 전적을 새 닉네임으로 복사
                db.execSQL(
                    "INSERT INTO players(lol_nickname, wins, losses, total_games, win_rate, created_at) " +
                    "SELECT ?, wins, losses, total_games, win_rate, created_at FROM players WHERE lol_nickname=?",
                    [lolNickname, oldNick]
                );
            }
            // game_participants, games 의 닉네임 연쇄 업데이트
            db.execSQL("UPDATE game_participants SET lol_nickname=? WHERE lol_nickname=?", [lolNickname, oldNick]);
            var gcur = db.rawQuery("SELECT id, left_team, right_team FROM games", []);
            while (gcur.moveToNext()) {
                var gid = gcur.getInt(0);
                var lt  = gcur.getString(1);
                var rt  = gcur.getString(2);
                var nlt = lt.split(",").map(function(x){ return x === oldNick ? lolNickname : x; }).join(",");
                var nrt = rt.split(",").map(function(x){ return x === oldNick ? lolNickname : x; }).join(",");
                if (lt !== nlt || rt !== nrt) {
                    db.execSQL("UPDATE games SET left_team=?, right_team=? WHERE id=?", [nlt, nrt, gid]);
                }
            }
            gcur.close();
            // 기존 닉네임의 players 행 삭제 (전적 이전 완료)
            db.execSQL("DELETE FROM players WHERE lol_nickname=?", [oldNick]);
            return { success: true, message: "✔ 닉네임을 '" + oldNick + "' → '" + lolNickname + "'(으)로 변경했습니다." };
        }

        // 신규 등록: lol_nickname hash 2개 초과 체크
        var hashCount = getHashCountByLolNickname(lolNickname);
        if (hashCount >= 2) {
            return { success: false, message: "'" + lolNickname + "'은(는) 이미 2개 계정에 연결되어 있어 추가 연결이 불가합니다." };
        }

        db.execSQL("INSERT INTO users(hash, lol_nickname, room) VALUES(?,?,?)", [hash, lolNickname, room]);

        // players 없으면 INSERT
        cur = db.rawQuery("SELECT 1 FROM players WHERE lol_nickname=?", [lolNickname]);
        if (!cur.moveToFirst()) {
            cur.close(); cur = null;
            db.execSQL("INSERT OR IGNORE INTO players(lol_nickname) VALUES(?)", [lolNickname]);
        }
        return { success: true, message: "✔ 롤 닉네임 '" + lolNickname + "' 등록 완료!" };
    } catch(e) {
        return { success: false, message: "등록 실패: " + e.message };
    } finally { if (cur) cur.close(); }
    });
}

// 닉네임 재등록: 카카오계정 변경으로 hash가 바뀐 경우
// - lol_nickname이 users에 등록되어 있어야 함
// - 새 hash가 이미 다른 닉네임에 등록되어 있으면 거부
// - 기존 hash를 새 hash로 교체
function reRegisterNickname(newHash, lolNickname, room) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        // 새 hash가 이미 다른 닉네임에 등록되어 있는지 확인
        cur = db.rawQuery("SELECT lol_nickname FROM users WHERE hash=?", [newHash]);
        if (cur.moveToFirst()) {
            var conflict = cur.getString(0);
            cur.close(); cur = null;
            if (conflict === lolNickname) {
                return { success: false, message: "이미 이 계정으로 '" + lolNickname + "'이(가) 등록되어 있습니다." };
            }
            return { success: false, message: "이 계정은 이미 '" + conflict + "'(으)로 등록되어 있습니다." };
        }
        cur.close(); cur = null;

        // 해당 lol_nickname에 연결된 기존 hash 목록 조회
        cur = db.rawQuery("SELECT hash FROM users WHERE lol_nickname=?", [lolNickname]);
        var oldHashes = [];
        while (cur.moveToNext()) oldHashes.push(cur.getString(0));
        cur.close(); cur = null;

        if (oldHashes.length === 0) {
            return { success: false, message: "'" + lolNickname + "'은(는) 등록된 적 없는 닉네임입니다.\n!닉네임등록 으로 먼저 등록하세요." };
        }
        if (oldHashes.length >= 2) {
            return { success: false, message: "'" + lolNickname + "'은(는) 이미 2개 계정에 연결되어 있습니다.\n재등록하려면 관리자에게 문의하세요." };
        }

        // 기존 hash → 새 hash 교체
        var oldHash = oldHashes[0];
        db.execSQL("UPDATE users SET hash=?, room=?, updated_at=CURRENT_TIMESTAMP WHERE hash=?",
            [newHash, room, oldHash]);

        return { success: true, message: "✔ '" + lolNickname + "' 계정 재연결 완료!" };
    } catch(e) {
        return { success: false, message: "재등록 실패: " + e.message };
    } finally { if (cur) cur.close(); }
    });
}

function isRegisteredNickname(nickname) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery("SELECT 1 FROM players WHERE lol_nickname=?", [nickname]);
        return cur.moveToFirst();
    } catch(e) { return false; }
    finally { if (cur) cur.close(); }
    });
}

// =====================================================================
// 날짜 검증
// =====================================================================
function isValidDateTime(str) {
    var regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
    if (!regex.test(str)) return false;
    var parts = str.split(" ");
    var d = parts[0].split("-").map(Number);
    var t = parts[1].split(":").map(Number);
    var date = new Date(d[0], d[1]-1, d[2], t[0], t[1]);
    return date instanceof Date && !isNaN(date);
}

// =====================================================================
// 플레이어 통계
// =====================================================================
// db 인수가 주어지면 그 연결을 사용하고 닫지 않음(트랜잭션 내 호출용).
// db 가 null/undefined 면 직접 열고 finally 에서 닫음(기존 동작).
function updatePlayerStats(db, nickname, isWin) {
    var ownDb = (db === null || db === undefined);
    if (ownDb) db = openDB();
    var cur = null;
    try {
        cur = db.rawQuery("SELECT wins, losses, total_games FROM players WHERE lol_nickname=?", [nickname]);
        if (!cur.moveToFirst()) {
            cur.close(); cur = null;
            var wins = isWin ? 1 : 0;
            var losses = isWin ? 0 : 1;
            db.execSQL("INSERT INTO players(lol_nickname,wins,losses,total_games,win_rate) VALUES(?,?,?,?,?)",
                [nickname, wins, losses, 1, isWin ? 100.0 : 0.0]);
        } else {
            var w = cur.getInt(0), l = cur.getInt(1), tot = cur.getInt(2);
            var nw = isWin ? w+1 : w, nl = isWin ? l : l+1, nt = tot+1;
            db.execSQL("UPDATE players SET wins=?,losses=?,total_games=?,win_rate=?,updated_at=CURRENT_TIMESTAMP WHERE lol_nickname=?",
                [nw, nl, nt, (nw/nt)*100, nickname]);
        }
        return true;
    } catch(e) {
        if (!ownDb) throw e;
        return false;
    }
    finally { if (cur) cur.close(); if (ownDb) db.close(); }
}

function getPlayerStats(nickname) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery("SELECT wins,losses,total_games,win_rate FROM players WHERE lol_nickname=?", [nickname]);
        if (!cur.moveToFirst()) return null;
        return { wins: cur.getInt(0), losses: cur.getInt(1), totalGames: cur.getInt(2), winRate: cur.getFloat(3) };
    } catch(e) { return null; }
    finally { if (cur) cur.close(); }
    });
}

// =====================================================================
// 게임 저장/조회
// =====================================================================
function saveGameResult(leftTeam, rightTeam, leftChamps, rightChamps, winningTeam) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null; var gameId = null;
    try {
        DBH.transaction(db, function(db){
        db.execSQL("INSERT INTO games(left_team,right_team,left_team_champions,right_team_champions,winning_team) VALUES(?,?,?,?,?)",
            [leftTeam.join(","), rightTeam.join(","), leftChamps.join(","), rightChamps.join(","), winningTeam]);
        cur = db.rawQuery("SELECT last_insert_rowid()", []);
        cur.moveToFirst();
        gameId = cur.getInt(0);
        cur.close(); cur = null;
        for (var i=0; i<leftTeam.length; i++) {
            db.execSQL("INSERT INTO game_participants(game_id,lol_nickname,team,is_winner) VALUES(?,?,?,?)",
                [gameId, leftTeam[i], "left", winningTeam==="left"]);
            updatePlayerStats(db, leftTeam[i], winningTeam==="left");
        }
        for (var i=0; i<rightTeam.length; i++) {
            db.execSQL("INSERT INTO game_participants(game_id,lol_nickname,team,is_winner) VALUES(?,?,?,?)",
                [gameId, rightTeam[i], "right", winningTeam==="right"]);
            updatePlayerStats(db, rightTeam[i], winningTeam==="right");
        }
        });
        return gameId;
    } catch(e) { return null; }
    finally { if (cur) cur.close(); }
    });
}

function getGameRecordById(gameId) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery("SELECT * FROM games WHERE id=?", [String(gameId)]);
        if (!cur.moveToFirst()) return null;
        var lc = cur.getString(cur.getColumnIndex("left_team_champions"));
        var rc = cur.getString(cur.getColumnIndex("right_team_champions"));
        return {
            id: cur.getInt(cur.getColumnIndex("id")),
            gameDate: cur.getString(cur.getColumnIndex("game_date")),
            leftTeam: cur.getString(cur.getColumnIndex("left_team")).split(","),
            rightTeam: cur.getString(cur.getColumnIndex("right_team")).split(","),
            leftChampions: lc ? lc.split(",") : [],
            rightChampions: rc ? rc.split(",") : [],
            winningTeam: cur.getString(cur.getColumnIndex("winning_team"))
        };
    } catch(e) { return null; }
    finally { if (cur) cur.close(); }
    });
}

function getRecentGameRecords(count) {
    var games = DBH.withDB(DB_PATH, function(db){
    var cur = null; var out = [];
    try {
        cur = db.rawQuery("SELECT * FROM games ORDER BY id DESC LIMIT ?", [String(count)]);
        while (cur.moveToNext()) {
            var lc = cur.getString(cur.getColumnIndex("left_team_champions"));
            var rc = cur.getString(cur.getColumnIndex("right_team_champions"));
            out.push({
                id: cur.getInt(cur.getColumnIndex("id")),
                gameDate: cur.getString(cur.getColumnIndex("game_date")),
                leftTeam: cur.getString(cur.getColumnIndex("left_team")).split(","),
                rightTeam: cur.getString(cur.getColumnIndex("right_team")).split(","),
                leftChampions: lc ? lc.split(",") : [],
                rightChampions: rc ? rc.split(",") : [],
                winningTeam: cur.getString(cur.getColumnIndex("winning_team"))
            });
        }
    } catch(e) {}
    finally { if (cur) cur.close(); }
    return out;
    });
    return games;
}

// =====================================================================
// 팀 통계
// =====================================================================
function getTeamStats(n1, n2) {
    return DBH.withDB(DB_PATH, function(db){
    var c1 = null; var c2 = null;
    try {
        var sameQ = "SELECT COUNT(*) as tot, SUM(CASE WHEN gp1.is_winner=1 THEN 1 ELSE 0 END) as w " +
            "FROM game_participants gp1 JOIN game_participants gp2 ON gp1.game_id=gp2.game_id " +
            "WHERE gp1.lol_nickname=? AND gp2.lol_nickname=? AND gp1.team=gp2.team";
        c1 = db.rawQuery(sameQ, [n1, n2]); c1.moveToFirst();
        var st = c1.getInt(0), sw = c1.getInt(1);
        c1.close(); c1 = null;
        var enemyQ = "SELECT COUNT(*) as tot, SUM(CASE WHEN gp1.is_winner=1 THEN 1 ELSE 0 END) as w " +
            "FROM game_participants gp1 JOIN game_participants gp2 ON gp1.game_id=gp2.game_id " +
            "WHERE gp1.lol_nickname=? AND gp2.lol_nickname=? AND gp1.team!=gp2.team";
        c2 = db.rawQuery(enemyQ, [n1, n2]); c2.moveToFirst();
        var et = c2.getInt(0), ew = c2.getInt(1);
        return {
            sameTeam: { totalGames:st, wins:sw, losses:st-sw, winRate:st>0?(sw/st)*100:0 },
            enemyTeam: { totalGames:et, wins:ew, losses:et-ew, winRate:et>0?(ew/et)*100:0 }
        };
    } catch(e) { return null; }
    finally { if (c1) c1.close(); if (c2) c2.close(); }
    });
}

function getOpponentStats(baseNickname) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery(
            "SELECT DISTINCT gp2.lol_nickname FROM game_participants gp1 " +
            "JOIN game_participants gp2 ON gp1.game_id=gp2.game_id " +
            "WHERE gp1.lol_nickname=? AND gp2.lol_nickname!=? AND gp1.team!=gp2.team",
            [baseNickname, baseNickname]);
        var opponents = [];
        while (cur.moveToNext()) opponents.push(cur.getString(0));
        cur.close(); cur = null;
        var results = [];
        for (var i=0; i<opponents.length; i++) {
            var s = getTeamStats(baseNickname, opponents[i]);
            if (s && s.enemyTeam.totalGames > 0)
                results.push({ opponent:opponents[i], totalGames:s.enemyTeam.totalGames,
                    wins:s.enemyTeam.wins, losses:s.enemyTeam.losses, winRate:s.enemyTeam.winRate });
        }
        results.sort(function(a,b) {
            if (Math.abs(a.winRate-b.winRate)>0.01) return b.winRate-a.winRate;
            if (a.wins!==b.wins) return b.wins-a.wins;
            return b.totalGames-a.totalGames;
        });
        return results;
    } catch(e) { return null; }
    finally { if (cur) cur.close(); }
    });
}

// =====================================================================
// 숨기기
// =====================================================================
function isHiddenPlayer(lolNickname) {
    return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery("SELECT 1 FROM hiding_players WHERE lol_nickname=?", [lolNickname]);
        return cur.moveToFirst();
    } catch(e) { return false; }
    finally { if (cur) cur.close(); }
    });
}

// =====================================================================
// 무결성 / 복구
// =====================================================================
function calculateStatsFromParticipants() {
    var map = DBH.withDB(DB_PATH, function(db){
    var cur = null; var acc = {};
    try {
        cur = db.rawQuery("SELECT lol_nickname,is_winner FROM game_participants WHERE is_winner IS NOT NULL", []);
        while (cur.moveToNext()) {
            var n=cur.getString(0); var w=cur.getInt(1)===1;
            if (!acc[n]) acc[n]={wins:0,losses:0,total:0};
            if (w) acc[n].wins++; else acc[n].losses++;
            acc[n].total++;
        }
    } catch(e) {}
    finally { if (cur) cur.close(); }
    return acc;
    });
    return map;
}

function checkIntegrity() {
    var pStats = calculateStatsFromParticipants();
    var mismatched = DBH.withDB(DB_PATH, function(db){
    var cur = null; var out = [];
    try {
        cur = db.rawQuery("SELECT lol_nickname,wins,losses,total_games FROM players", []);
        while (cur.moveToNext()) {
            var n=cur.getString(0), w=cur.getInt(1), l=cur.getInt(2), tot=cur.getInt(3);
            var p=pStats[n]||{wins:0,losses:0,total:0};
            if (w!==p.wins||l!==p.losses||tot!==p.total)
                out.push({nickname:n,players:{wins:w,losses:l,total:tot},actual:p});
        }
    } catch(e) {}
    finally { if (cur) cur.close(); }
    return out;
    });
    return mismatched;
}

function rebuildPlayersTableFromParticipants() {
    var stats = calculateStatsFromParticipants();
    DBH.withDB(DB_PATH, function(db){
    try {
        for (var n in stats) {
            var s=stats[n];
            var wr = s.total>0?(s.wins/s.total)*100:0;
            db.execSQL("UPDATE players SET wins=?,losses=?,total_games=?,win_rate=? WHERE lol_nickname=?",
                [s.wins,s.losses,s.total,wr,n]);
        }
    } finally {  }
    });
}

function getGameParticipants(gameId) {
    var list = DBH.withDB(DB_PATH, function(db){
    var cur = null; var out = [];
    try {
        cur = db.rawQuery("SELECT lol_nickname,team,is_winner FROM game_participants WHERE game_id=?", [String(gameId)]);
        while (cur.moveToNext()) out.push({nickname:cur.getString(0),team:cur.getString(1),isWinner:cur.getInt(2)});
    } catch(e) {}
    finally { if (cur) cur.close(); }
    return out;
    });
    return list;
}

function findUndefinedParticipants() {
    var results = DBH.withDB(DB_PATH, function(db){
    var cur = null; var out = [];
    try {
        cur = db.rawQuery("SELECT game_id,team FROM game_participants WHERE lol_nickname IS NULL OR lol_nickname=''", []);
        while (cur.moveToNext()) out.push({gameId:cur.getInt(0),team:cur.getString(1)});
    } catch(e) {}
    finally { if (cur) cur.close(); }
    return out;
    });
    return results;
}

// =====================================================================
// 회차 수정
// =====================================================================
function rollbackGameStats(gameId) {
    DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery("SELECT lol_nickname,is_winner FROM game_participants WHERE game_id=?", [String(gameId)]);
        while (cur.moveToNext()) {
            var n=cur.getString(0); var wasWin=cur.getInt(1)===1;
            var sc=db.rawQuery("SELECT wins,losses,total_games FROM players WHERE lol_nickname=?",[n]);
            if (sc.moveToFirst()) {
                var w=sc.getInt(0),l=sc.getInt(1),tot=sc.getInt(2);
                if (wasWin) w=Math.max(0,w-1); else l=Math.max(0,l-1);
                tot=Math.max(0,tot-1);
                db.execSQL("UPDATE players SET wins=?,losses=?,total_games=?,win_rate=? WHERE lol_nickname=?",
                    [w,l,tot,tot>0?(w/tot)*100:0,n]);
            }
            sc.close();
        }
        db.execSQL("UPDATE game_participants SET is_winner=NULL WHERE game_id=?",[String(gameId)]);
    } finally { if (cur) cur.close(); }
    });
}

function applyGameStats(gameId, winningTeam) {
    DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
        cur = db.rawQuery("SELECT id,lol_nickname,team FROM game_participants WHERE game_id=?",[String(gameId)]);
        while (cur.moveToNext()) {
            var rowId=cur.getInt(0),n=cur.getString(1),team=cur.getString(2);
            var isWin=(team===winningTeam)?1:0;
            db.execSQL("UPDATE game_participants SET is_winner=? WHERE id=?",[isWin,rowId]);
            updatePlayerStats(db,n,isWin===1);
        }
    } finally { if (cur) cur.close(); }
    });
}

// =====================================================================
// ELO
// =====================================================================
const ELO_CONFIG = { STARTING_ELO:1500, USE_DYNAMIC_K:true, K_FACTOR_PROVISIONAL:32, K_FACTOR_ESTABLISHED:16, PROVISIONAL_THRESHOLD:6, K_FACTOR_FIXED:16 };

function getKFactor(games) {
    if (!ELO_CONFIG.USE_DYNAMIC_K) return ELO_CONFIG.K_FACTOR_FIXED;
    return games < ELO_CONFIG.PROVISIONAL_THRESHOLD ? ELO_CONFIG.K_FACTOR_PROVISIONAL : ELO_CONFIG.K_FACTOR_ESTABLISHED;
}

function calculateExpectedScore(a, b) { return 1/(1+Math.pow(10,(b-a)/400)); }

function calculateAllEloRatings() {
    return DBH.withDB(DB_PATH, function(db){
    var gc = null;
    var playerStats={}, eloHistory={};
    try {
        gc = db.rawQuery("SELECT id,winning_team FROM games ORDER BY id ASC",[]);
        while (gc.moveToNext()) {
            var gameId=gc.getInt(0), wt=gc.getString(1);
            var pc=db.rawQuery("SELECT lol_nickname,team FROM game_participants WHERE game_id=?",[String(gameId)]);
            var lt=[], rt=[];
            while (pc.moveToNext()) {
                var n=pc.getString(0), t=pc.getString(1);
                if (!playerStats[n]) { playerStats[n]={elo:ELO_CONFIG.STARTING_ELO,games:0}; eloHistory[n]=[]; }
                if (t==="left") lt.push(n); else rt.push(n);
            }
            pc.close();
            var la=0; for (var i=0;i<lt.length;i++) la+=playerStats[lt[i]].elo; la/=lt.length;
            var ra=0; for (var i=0;i<rt.length;i++) ra+=playerStats[rt[i]].elo; ra/=rt.length;
            var al=(wt==="left")?1.0:0.0, ar=1.0-al;
            for (var i=0;i<lt.length;i++) {
                var n=lt[i],oe=playerStats[n].elo,gp=playerStats[n].games;
                var ne=Math.round(oe+getKFactor(gp)*(al-calculateExpectedScore(oe,ra)));
                playerStats[n].elo=ne; playerStats[n].games++; eloHistory[n].push({gameId:gameId,elo:ne});
            }
            for (var i=0;i<rt.length;i++) {
                var n=rt[i],oe=playerStats[n].elo,gp=playerStats[n].games;
                var ne=Math.round(oe+getKFactor(gp)*(ar-calculateExpectedScore(oe,la)));
                playerStats[n].elo=ne; playerStats[n].games++; eloHistory[n].push({gameId:gameId,elo:ne});
            }
        }
    } finally { if (gc) gc.close(); }
    return { playerStats:playerStats, eloHistory:eloHistory };
    });
}

function formatEloRankings(playerStats, excludedPlayers) {
    excludedPlayers = excludedPlayers || [];
    var filtered = [];
    for (var n in playerStats) {
        if (excludedPlayers.indexOf(n)===-1)
            filtered.push({nickname:n, elo:playerStats[n].elo, games:playerStats[n].games});
    }
    filtered.sort(function(a,b){ return b.elo-a.elo; });
    var result = DBH.withDB(DB_PATH, function(db){
    var res = "=== ELO 레이팅 순위 ===\n";
    for (var i=0;i<filtered.length;i++) {
        var p=filtered[i];
        var sc=db.rawQuery("SELECT wins,losses,win_rate FROM players WHERE lol_nickname=?",[p.nickname]);
        var w=0,l=0,wr=0;
        if (sc.moveToFirst()) { w=sc.getInt(0); l=sc.getInt(1); wr=sc.getFloat(2); }
        sc.close();
        res += (i+1)+". "+p.nickname+"\n   ELO: "+p.elo+"\n   "+p.games+"전 "+w+"승 "+l+"패 ("+wr.toFixed(1)+"%)";
        if (i<filtered.length-1) res+="\n";
    }
    return res;
    });
    var tot=0, cnt=0;
    for (var n in playerStats) { tot+=playerStats[n].elo; cnt++; }
    result += "\n===================\n평균 ELO: "+(tot/cnt).toFixed(1);
    return result;
}

function getPlayerEloInfo(nickname) {
    var r=calculateAllEloRatings(); var ps=r.playerStats;
    if (!ps[nickname]) return null;
    var rank=1, elo=ps[nickname].elo;
    for (var n in ps) { if (ps[n].elo>elo) rank++; }
    return { elo:elo, games:ps[nickname].games, rank:rank };
}

// =====================================================================
// 챔프 리스트 & 게임 상태
// =====================================================================
const champlist = ['아트록스','아리','아칼리','알리스타','아무무','애니비아','애니','암베사','아펠리오스','애쉬','아우렐리온 솔','아지르','바드','블리츠크랭크','브랜드','브라움','케이틀린','카밀','카시오페아','초가스','코르키','다리우스','다이애나','드레이븐','문도 박사','에코','엘리스','이블린','이즈리얼','피들스틱','피오라','피즈','갈리오','갱플랭크','가렌','나르','그라가스','그레이브즈','헤카림','하이머딩거','일라오이','이렐리아','아이번','잔나','자르반 4세','잭스','제이스','진','징크스','카이사','칼리스타','카르마','카서스','카사딘','카타리나','케일','케인','케넨','카직스','킨드레드','클레드','코그모','르블랑','리신','레오나','리산드라','루시안','룰루','럭스','말파이트','말자하','마오카이','마스터 이','미스 포츄','오공','모데카이저','모르가나','나미','나서스','노틸러스','니코','니달리','닐라','녹턴','누누와 윌럼프','올라프','오리아나','오른','판테온','뽀삐','파이크','키아나','퀸','라칸','람머스','렉사이','레넥톤','렝가','리븐','럼블','라이즈','세주아니','세나','세트','샤코','쉔','쉬바나','신지드','사이온','시비르','스카너','소나','소라카','스웨인','사일러스','신드라','탐켄치','탈리야','탈론','타릭','티모','쓰레쉬','트리스타나','트런들','트린다미어','트위스티드 페이트','트위치','우디르','우르곳','바루스','베인','베이가','벨코즈','바이','빅토르','블라디미르','볼리베어','워윅','자야','제라스','신짜오','야스오','요릭','유미','자크','제드','직스','질리언','조이','자이라','사미라','밀리오','렐','벨베스','크산테','나피리','레나타','세라핀','벡스','비에고','요네','아크샨','브라이어','그웬','제리','흐웨이','릴리아','스몰더','오로라','멜','유나라','자헨'];

// 긴 메시지 강제 줄바꿈용 제로폭 공백 스페이서
var LONG_MSG_SPACER = "​".repeat(500);

// 방(채널)별 상태. 전역 공유 상태로 인한 방 간 간섭 제거.
function freshRoomState() {
    return {
        party: [],
        leftTeam: [],
        rightTeam: [],
        leftteamchamplist: [],
        rightteamchamplist: [],
        lastgameparty: [],
        partygathering: false,
        gamestart: false,
        manualRecord: { active:false, leftTeam:[], rightTeam:[], leftChamps:[], rightChamps:[], winner:"", gameDate:"" },
        editRecord: { active:false, gameId:null, originalGame:null, newLeftChamps:null, newRightChamps:null, newWinner:null }
    };
}

var rooms = {};

// =====================================================================
// 날짜 포맷 (내전기록용)
// =====================================================================
function formatGameDate(originalDate) {
    if (!originalDate) return "정보 없음";
    try {
        var dp=originalDate.split(" ");
        if (dp.length!==2) return originalDate+" (형식 오류)";
        var d=dp[0].split("-"), t=dp[1].split(":");
        if (d.length!==3||t.length<2) return originalDate+" (변환 실패)";
        var gd=new Date(+d[0],+d[1]-1,+d[2],+t[0],+t[1]);
        var kd=new Date(gd.getTime()+(9*60*60*1000));
        var mo=kd.getMonth()+1, dy=kd.getDate(), hr=kd.getHours(), mi=kd.getMinutes();
        return kd.getFullYear()+"-"+(mo<10?"0"+mo:mo)+"-"+(dy<10?"0"+dy:dy)+" "+(hr<10?"0"+hr:hr)+":"+(mi<10?"0"+mi:mi);
    } catch(e) { return originalDate+" (오류: "+e.message+")"; }
}

// =====================================================================
// handleMessage (워커 스레드에서 호출됨)
// =====================================================================
/**
 * (string) msg.content, msg.room, msg.author.name, msg.author.hash
 * (void) msg.reply(string)
 */
function handleMessage(msg) {
    try {
        var text = msg.content;
        var hash = msg.author.hash ? String(msg.author.hash) : null;
        var room = msg.room;

        // 방(채널)별 상태 (전역 공유 제거)
        var chanId = String(msg.channelId || "");
        var st = rooms[chanId] || (rooms[chanId] = freshRoomState());

        // ── 닉네임 확인 ──────────────────────────────────────────
        if (text === "!닉네임") {
            if (!hash) { msg.reply("유저 해시를 인식할 수 없습니다."); return; }
            var nick = getNicknameFromHash(hash);
            if (!nick) msg.reply("닉네임이 등록되어 있지 않습니다.\n!닉네임등록 롤닉네임 으로 등록하세요.");
            else msg.reply("카카오톡: " + msg.author.name + "\n롤 닉네임: " + nick);
            return;
        }

        // ── 닉네임 등록 (신규 + 닉네임변경 통합) ────────────────
        else if (text.startsWith("!닉네임등록 ")) {
            if (!hash) { msg.reply("유저 해시를 인식할 수 없습니다."); return; }
            var lolNick = text.replace("!닉네임등록 ", "").trim();
            if (!lolNick) { msg.reply("사용법: !닉네임등록 롤닉네임"); return; }
            var result = insertNickname(hash, lolNick, room);
            msg.reply(result.message);
            return;
        }

        // ── 닉네임 재등록 (카카오계정 변경 시) ──────────────────
        else if (text.startsWith("!닉네임재등록 ")) {
            if (!hash) { msg.reply("유저 해시를 인식할 수 없습니다."); return; }
            var lolNick = text.replace("!닉네임재등록 ", "").trim();
            if (!lolNick) { msg.reply("사용법: !닉네임재등록 롤닉네임"); return; }
            var result = reRegisterNickname(hash, lolNick, room);
            msg.reply(result.message);
            return;
        }

        // ── 내전 시작 ────────────────────────────────────────────
        else if (text === "!내전시작" && !st.partygathering && !st.gamestart) {
            st.partygathering = true;
            st.party = [];
            msg.reply("!참가 로 참가하세요.\n닉네임 등록: !닉네임등록 롤닉네임");
            return;
        }

        // ── 이전게임 ─────────────────────────────────────────────
        else if (text === "!이전게임") {
            if (st.lastgameparty.length === 0) { msg.reply("이전 게임에 참가한 사람이 없습니다."); return; }
            st.partygathering = true; st.party = [];
            for (var i=0; i<st.lastgameparty.length; i++) {
                if (st.party.indexOf(st.lastgameparty[i])===-1) st.party.push(st.lastgameparty[i]);
            }
            msg.reply("이전 게임 참가자 복원\n현재 참가자("+st.party.length+"인)\n"+st.party.join(", "));
            return;
        }

        // ── 참가 ─────────────────────────────────────────────────
        else if (text === "!참가" && st.partygathering && !st.gamestart) {
            if (!hash) { msg.reply("유저 해시를 인식할 수 없습니다."); return; }
            var nick = getNicknameFromHash(hash);
            if (!nick) { msg.reply("닉네임을 등록하세요.\n!닉네임등록 롤닉네임"); return; }
            if (st.party.length >= 10) { msg.reply("참가 인원이 가득 찼습니다."); return; }
            if (st.party.indexOf(nick) !== -1) { msg.reply("이미 참가하셨습니다."); return; }
            st.party.push(nick);
            msg.reply(nick+" 님 참가\n현재 참가자("+st.party.length+"인)\n"+st.party.join(", "));
            return;
        }

        // ── 강제참가 ─────────────────────────────────────────────
        else if (text.startsWith("!강제참가 ") && st.partygathering && !st.gamestart) {
            var input = text.replace("!강제참가 ","").trim();
            if (!input) { msg.reply("사용법: !강제참가 롤닉네임1,롤닉네임2"); return; }
            var requested = input.split(",");
            var added=[], noregistered=[], alreadyjoined=[], overlimit=[];
            for (var i=0; i<requested.length; i++) {
                var n=requested[i].replace(/^\s+|\s+$/g,"");
                if (st.party.length>=10) { overlimit.push(n); continue; }
                if (!getPlayerStats(n)) { noregistered.push(n); continue; }
                if (st.party.indexOf(n)!==-1) { alreadyjoined.push(n); continue; }
                st.party.push(n); added.push(n);
            }
            var m="";
            if (added.length) m+="참가 완료:\n"+added.join(", ")+"\n\n";
            if (noregistered.length) m+="등록되지 않은 닉네임:\n"+noregistered.join(", ")+"\n\n";
            if (alreadyjoined.length) m+="이미 참가 중:\n"+alreadyjoined.join(", ")+"\n\n";
            if (overlimit.length) m+="정원 초과:\n"+overlimit.join(", ")+"\n\n";
            m+="현재 참가자("+st.party.length+"명)\n"+st.party.join(", ");
            msg.reply(m);
            return;
        }

        // ── 참가취소 ─────────────────────────────────────────────
        else if (text === "!참가취소" && st.partygathering && !st.gamestart) {
            if (!hash) { msg.reply("유저 해시를 인식할 수 없습니다."); return; }
            var nick = getNicknameFromHash(hash);
            if (!nick) { msg.reply("닉네임이 등록되어 있지 않습니다."); return; }
            var idx = st.party.indexOf(nick);
            if (idx===-1) { msg.reply("참가하지 않은 상태입니다."); return; }
            st.party.splice(idx, 1);
            msg.reply(nick+" 님 참가 취소\n현재 참가자("+st.party.length+"인)\n"+st.party.join(", "));
            return;
        }

        // ── 시작 ─────────────────────────────────────────────────
        else if (text === "!시작" && st.partygathering && !st.gamestart) {
            if (st.party.length < 2) { msg.reply("최소 2명 이상 참가해야 합니다."); return; }
            if (st.party.length % 2 !== 0) { msg.reply("짝수 인원만 게임을 시작할 수 있습니다.\n현재 인원: "+st.party.length+"명"); return; }
            st.gamestart = true; st.partygathering = false;
            var shuffled = st.party.slice(); for (var i=shuffled.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=shuffled[i]; shuffled[i]=shuffled[j]; shuffled[j]=t; }
            var mid = shuffled.length/2;
            st.leftTeam = shuffled.slice(0, mid); st.rightTeam = shuffled.slice(mid);
            var tc = champlist.slice(); st.leftteamchamplist=[]; st.rightteamchamplist=[];
            for (var i=0; i<st.leftTeam.length*3; i++) st.leftteamchamplist.push(tc.splice(Math.floor(Math.random()*tc.length),1)[0]);
            for (var i=0; i<st.rightTeam.length*3; i++) st.rightteamchamplist.push(tc.splice(Math.floor(Math.random()*tc.length),1)[0]);
            msg.reply("왼쪽팀 : "+st.leftTeam.join(", ")+"\n오른쪽팀 : "+st.rightTeam.join(", ")+"\n\n각 팀은 개인톡으로 !챔프 입력\n게임 종료 후 !승리왼쪽 또는 !승리오른쪽 입력");
            return;
        }

        // ── 팀다시짜기 ────────────────────────────────────────────
        else if (text === "!팀다시짜기" && !st.partygathering && st.gamestart) {
            if (st.party.length < 6) { msg.reply("최소 6명 이상이어야 합니다."); return; }
            if (st.party.length % 2 !== 0) { msg.reply("짝수 인원만 게임을 시작할 수 있습니다.\n현재 인원: "+st.party.length+"명"); return; }
            var shuffled = st.party.slice(); for (var i=shuffled.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=shuffled[i]; shuffled[i]=shuffled[j]; shuffled[j]=t; }
            var mid = shuffled.length/2;
            st.leftTeam = shuffled.slice(0,mid); st.rightTeam = shuffled.slice(mid);
            var tc=champlist.slice(); st.leftteamchamplist=[]; st.rightteamchamplist=[];
            for (var i=0;i<st.leftTeam.length*3;i++) st.leftteamchamplist.push(tc.splice(Math.floor(Math.random()*tc.length),1)[0]);
            for (var i=0;i<st.rightTeam.length*3;i++) st.rightteamchamplist.push(tc.splice(Math.floor(Math.random()*tc.length),1)[0]);
            msg.reply("🔄 팀을 새롭게 구성했습니다!\n왼쪽팀 : "+st.leftTeam.join(", ")+"\n오른쪽팀 : "+st.rightTeam.join(", ")+"\n각 팀원은 개인톡으로 !챔프 입력");
            return;
        }

        // ── 승리왼쪽 ─────────────────────────────────────────────
        else if (text.startsWith("!승리왼쪽") && st.gamestart) {
            var gid = saveGameResult(st.leftTeam, st.rightTeam, st.leftteamchamplist, st.rightteamchamplist, "left");
            if (gid) {
                msg.reply(gid+"회차 내전 왼쪽 팀 승리!\n통계가 업데이트되었습니다.");
                st.lastgameparty=st.party.slice(); st.party=[]; st.leftTeam=[]; st.rightTeam=[]; st.leftteamchamplist=[]; st.rightteamchamplist=[]; st.partygathering=false; st.gamestart=false;
            } else msg.reply("게임 결과 저장에 실패했습니다.");
            return;
        }

        // ── 승리오른쪽 ───────────────────────────────────────────
        else if (text.startsWith("!승리오른쪽") && st.gamestart) {
            var gid = saveGameResult(st.leftTeam, st.rightTeam, st.leftteamchamplist, st.rightteamchamplist, "right");
            if (gid) {
                msg.reply(gid+"회차 내전 오른쪽 팀 승리!\n통계가 업데이트되었습니다.");
                st.lastgameparty=st.party.slice(); st.party=[]; st.leftTeam=[]; st.rightTeam=[]; st.leftteamchamplist=[]; st.rightteamchamplist=[]; st.partygathering=false; st.gamestart=false;
            } else msg.reply("게임 결과 저장에 실패했습니다.");
            return;
        }

        // ── 챔프 (롤닉네임으로 판별 — 다른 방 등록도 인식) ───────
        else if (text.startsWith("!챔프") && st.gamestart && !st.partygathering) {
            if (room === "명동(공공장소에서열지마세요)") {
                msg.reply("개인챗으로 !챔프 를 통해 챔피언을 확인하세요."); return;
            }
            if (!hash) { msg.reply("유저 해시를 인식할 수 없습니다."); return; }
            // 이 hash가 가진 모든 롤닉네임 후보
            var nicks = DBH.withDB(DB_PATH, function(db2){
            var cur2 = null; var out = [];
            try {
                cur2 = db2.rawQuery("SELECT DISTINCT lol_nickname FROM users WHERE hash=?", [hash]);
                while (cur2.moveToNext()) out.push(cur2.getString(0));
            } finally { if (cur2) cur2.close(); }
            return out;
            });
            var matched = null;
            for (var i=0; i<nicks.length; i++) {
                if (st.leftTeam.indexOf(nicks[i])!==-1 || st.rightTeam.indexOf(nicks[i])!==-1) { matched=nicks[i]; break; }
            }
            if (!matched) { msg.reply("현재 게임 참가자 목록에 없습니다.\n닉네임 등록: !닉네임등록 롤닉네임"); return; }
            if (st.leftTeam.indexOf(matched)!==-1) msg.reply("왼쪽 팀 챔피언\n"+st.leftteamchamplist.join(", "));
            else msg.reply("오른쪽 팀 챔피언\n"+st.rightteamchamplist.join(", "));
            return;
        }

        // ── 초기화 ───────────────────────────────────────────────
        else if (text.startsWith("!초기화")) {
            st.partygathering=false; st.gamestart=false; st.party=[]; st.leftTeam=[]; st.rightTeam=[]; st.leftteamchamplist=[]; st.rightteamchamplist=[];
            msg.reply("내전 모집 상태가 초기화되었습니다."); return;
        }

        // ── 통계 ─────────────────────────────────────────────────
        else if (text.startsWith("!통계")) {
            var input = text.replace("!통계","").trim();
            var targetNick = "";
            if (!input) {
                if (!hash) { msg.reply("유저 해시를 인식할 수 없습니다."); return; }
                targetNick = getNicknameFromHash(hash);
                if (!targetNick) { msg.reply("닉네임을 등록하세요.\n!닉네임등록 롤닉네임"); return; }
            } else if (input.startsWith("@")) {
                var kakaoName = input.replace("@","").trim();
                targetNick = getNicknameFromKakaoName(kakaoName);
                if (!targetNick) { msg.reply(kakaoName+" 님이 닉네임을 등록하지 않았습니다."); return; }
            } else {
                targetNick = input;
            }
            var stats = getPlayerStats(targetNick);
            if (!stats) msg.reply(targetNick+" 님의 게임 기록이 없습니다.");
            else msg.reply("'"+targetNick+"' 님의 통계\n"+stats.totalGames+"전 "+stats.wins+"승 "+stats.losses+"패 ("+stats.winRate.toFixed(1)+"%)");
            return;
        }

        // ── 파트너순위 ───────────────────────────────────────────
        else if (text.startsWith("!파트너순위")) {
            try {
                var input = text.replace("!파트너순위","").trim();
                var targetNick = "";
                if (!input) {
                    if (!hash) { msg.reply("유저 해시를 인식할 수 없습니다."); return; }
                    targetNick = getNicknameFromHash(hash);
                    if (!targetNick) { msg.reply("닉네임을 등록하세요."); return; }
                } else if (input.startsWith("@")) {
                    var kakaoName = input.replace("@","").trim();
                    targetNick = getNicknameFromKakaoName(kakaoName);
                    if (!targetNick) { msg.reply(kakaoName+" 님이 닉네임을 등록하지 않았습니다."); return; }
                } else {
                    targetNick = input;
                }
                var pStats = getPlayerStats(targetNick);
                if (!pStats || pStats.totalGames===0) { msg.reply(targetNick+" 님의 게임 기록이 없습니다."); return; }
                var partnerStats = DBH.withDB(DB_PATH, function(db3){
                var cur3 = null; var acc=[];
                try {
                cur3 = db3.rawQuery("SELECT lol_nickname FROM players WHERE total_games>0 AND lol_nickname!=? ORDER BY lol_nickname",[targetNick]);
                while (cur3.moveToNext()) {
                    var pn=cur3.getString(0), ts=getTeamStats(targetNick,pn);
                    if (ts && ts.sameTeam.totalGames>0)
                        acc.push({partner:pn,totalGames:ts.sameTeam.totalGames,wins:ts.sameTeam.wins,losses:ts.sameTeam.losses,winRate:ts.sameTeam.winRate});
                }
                } finally { if (cur3) cur3.close(); }
                return acc;
                });
                if (!partnerStats.length) { msg.reply(targetNick+" 님과 함께 팀을 이룬 기록이 없습니다."); return; }
                partnerStats.sort(function(a,b){ return Math.abs(a.winRate-b.winRate)<0.01?b.wins-a.wins:b.winRate-a.winRate; });
                var m="=== "+targetNick+" 파트너 순위 ===\n";
                var rank=1,cr=1,pwr=null,pw=null;
                for (var i=0;i<partnerStats.length;i++) {
                    var p=partnerStats[i];
                    if (pwr!==null&&(Math.abs(pwr-p.winRate)>0.01||pw!==p.wins)) cr=rank;
                    m+=cr+". "+p.partner+"\n "+p.totalGames+"전 "+p.wins+"승 "+p.losses+"패 ("+p.winRate.toFixed(1)+"%)";
                    if (i===5) m+=LONG_MSG_SPACER;
                    if (i<partnerStats.length-1) m+="\n";
                    pwr=p.winRate; pw=p.wins; rank++;
                }
                msg.reply(m);
            } catch(e) { msg.reply("파트너순위 조회 실패: "+e.message); }
            return;
        }

        // ── 상대전적 ─────────────────────────────────────────────
        else if (text.startsWith("!상대전적")) {
            var input = text.replace("!상대전적","").trim();
            var baseNick = "";
            if (!input) {
                if (!hash) { msg.reply("유저 해시를 인식할 수 없습니다."); return; }
                baseNick = getNicknameFromHash(hash);
                if (!baseNick) { msg.reply("닉네임을 등록하세요."); return; }
            } else if (input.startsWith("@")) {
                var kakaoName = input.replace("@","").trim();
                baseNick = getNicknameFromKakaoName(kakaoName);
                if (!baseNick) { msg.reply(kakaoName+" 님이 닉네임을 등록하지 않았습니다."); return; }
            } else {
                baseNick = input;
            }
            var os = getOpponentStats(baseNick);
            if (!os||!os.length) { msg.reply(baseNick+" 님의 상대전적 기록이 없습니다."); return; }
            var m="=== "+baseNick+" 상대전적 ===\n"; var rank=1;
            for (var i=0;i<os.length;i++) {
                var o=os[i];
                m+=rank+". "+o.opponent+"\n "+o.totalGames+"전 "+o.wins+"승 "+o.losses+"패 ("+o.winRate.toFixed(1)+"%)";
                if (i===5) m+=LONG_MSG_SPACER;
                if (i<os.length-1) m+="\n";
                rank++;
            }
            msg.reply(m);
            return;
        }

        // ── 팀통계순위 ───────────────────────────────────────────
        else if (text === "!팀통계순위") {
            try {
                var players = DBH.withDB(DB_PATH, function(db4){
                var cur4=null; var acc=[];
                try {
                cur4=db4.rawQuery("SELECT lol_nickname FROM players WHERE total_games>0 ORDER BY lol_nickname",[]);
                while (cur4.moveToNext()) acc.push(cur4.getString(0));
                } finally { if (cur4) cur4.close(); }
                return acc;
                });
                if (players.length<2) { msg.reply("플레이어가 부족합니다."); return; }
                var combos=[];
                for (var i=0;i<players.length;i++) for (var j=i+1;j<players.length;j++) {
                    var ts=getTeamStats(players[i],players[j]);
                    if (ts&&ts.sameTeam.totalGames>0)
                        combos.push({p1:players[i],p2:players[j],totalGames:ts.sameTeam.totalGames,wins:ts.sameTeam.wins,losses:ts.sameTeam.losses,winRate:ts.sameTeam.winRate});
                }
                if (!combos.length) { msg.reply("같은 팀으로 게임한 기록이 없습니다."); return; }
                combos.sort(function(a,b){ return Math.abs(a.winRate-b.winRate)<0.01?b.wins-a.wins:b.winRate-a.winRate; });
                var m="=== 팀 조합 승률 순위 ===\n"; var rank=1,cr=1,pwr=null,pw=null;
                for (var k=0;k<combos.length;k++) {
                    var t=combos[k];
                    if (pwr!==null&&(Math.abs(pwr-t.winRate)>0.01||pw!==t.wins)) cr=rank;
                    m+=cr+". "+t.p1+" + "+t.p2+"\n "+t.totalGames+"전 "+t.wins+"승 "+t.losses+"패 ("+t.winRate.toFixed(1)+"%)";
                    if (k===5) m+=LONG_MSG_SPACER;
                    if (k<combos.length-1) m+="\n";
                    pwr=t.winRate; pw=t.wins; rank++;
                }
                msg.reply(m);
            } catch(e) { msg.reply("팀통계순위 조회 실패: "+e.message); }
            return;
        }

        // ── 팀통계 ───────────────────────────────────────────────
        else if (text.startsWith("!팀통계")) {
            var inputText = text.replace("!팀통계","").trim();
            if (!inputText) { msg.reply("사용법: !팀통계 롤닉네임1 롤닉네임2"); return; }
            var parts = inputText.split(" ").filter(function(s){ return s.length>0; });
            if (parts.length < 2) { msg.reply("사용법: !팀통계 롤닉네임1 롤닉네임2"); return; }
            var n1=parts[0], n2=parts.slice(1).join(" ");
            var ts=getTeamStats(n1, n2);
            if (!ts) { msg.reply("팀 통계 조회에 실패했습니다."); return; }
            var m=n1+" VS "+n2+" 팀 통계\n\n같은 팀일 때\n"+ts.sameTeam.totalGames+"전 "+ts.sameTeam.wins+"승 "+ts.sameTeam.losses+"패 ("+ts.sameTeam.winRate.toFixed(1)+"%)\n\n적팀일 때 ("+n1+" 기준)\n"+ts.enemyTeam.totalGames+"전 "+ts.enemyTeam.wins+"승 "+ts.enemyTeam.losses+"패 ("+ts.enemyTeam.winRate.toFixed(1)+"%)";
            msg.reply(m);
            return;
        }

        // ── 순위 ─────────────────────────────────────────────────
        else if (text.startsWith("!순위")) {
            try {
                var m = DBH.withDB(DB_PATH, function(db5){
                var cur5=null;
                try {
                cur5=db5.rawQuery(
                    "SELECT p.lol_nickname,p.wins,p.losses,p.total_games,p.win_rate FROM players p " +
                    "LEFT JOIN hiding_players h ON p.lol_nickname=h.lol_nickname " +
                    "WHERE p.total_games>0 AND h.lol_nickname IS NULL " +
                    "ORDER BY p.win_rate DESC, p.wins DESC, p.total_games DESC",[]);
                if (cur5.getCount()===0) { msg.reply("아직 게임 기록이 없습니다."); return null; }
                var m="=== 승률 순위 ===\n"; var rank=1,cr=1,pwr=null,pw=null;
                while (cur5.moveToNext()) {
                    var n=cur5.getString(0),w=cur5.getInt(1),l=cur5.getInt(2),tot=cur5.getInt(3),wr=cur5.getFloat(4);
                    if (pwr!==null&&(Math.abs(pwr-wr)>0.01||pw!==w)) cr=rank;
                    m+=cr+". "+n+"\n "+tot+"전 "+w+"승 "+l+"패 ("+wr.toFixed(1)+"%)";
                    if (rank<cur5.getCount()) m+="\n";
                    pwr=wr; pw=w; rank++;
                }
                return m;
                } finally { if (cur5) cur5.close(); }
                });
                if (m===null) return;
                msg.reply(m);
            } catch(e) { msg.reply("순위 조회 실패: "+e.message); }
            return;
        }

        // ── ELO ──────────────────────────────────────────────────
        else if (text.startsWith("!ELO")||text.startsWith("!elo")) {
            var rest = text.replace("!ELO","").replace("!elo","").trim();
            if (!rest) {
                try {
                    var r=calculateAllEloRatings();
                    msg.reply(formatEloRankings(r.playerStats,['헤으8','미드감채팅안함']));
                } catch(e) { msg.reply("ELO 순위 조회 실패: "+e.message); }
            } else {
                try {
                    var ei=getPlayerEloInfo(rest);
                    if (!ei) msg.reply(rest+"님의 게임 기록이 없습니다.");
                    else msg.reply("'"+rest+"' ELO 정보\n순위: "+ei.rank+"위\nELO: "+ei.elo+"\n게임 수: "+ei.games);
                } catch(e) { msg.reply("ELO 조회 실패: "+e.message); }
            }
            return;
        }

        // ── 숨기기 ───────────────────────────────────────────────
        else if (text.startsWith("!숨기기 ")) {
            var nick = text.replace("!숨기기 ","").trim();
            if (!nick) { msg.reply("사용법: !숨기기 롤닉네임"); return; }
            if (!isRegisteredNickname(nick)) { msg.reply("등록되지 않은 롤 닉네임입니다."); return; }
            if (isHiddenPlayer(nick)) { msg.reply("'"+nick+"' 은(는) 이미 숨겨져 있습니다."); return; }
            DBH.withDB(DB_PATH, function(db6){ try { db6.execSQL("INSERT INTO hiding_players(lol_nickname) VALUES(?)",[nick]); } finally {  } });
            msg.reply("🙈 '"+nick+"' 을(를) 순위에서 숨겼습니다.");
            return;
        }

        // ── 숨김해제 ─────────────────────────────────────────────
        else if (text.startsWith("!숨김해제 ")) {
            var nick = text.replace("!숨김해제 ","").trim();
            if (!nick) { msg.reply("사용법: !숨김해제 롤닉네임"); return; }
            if (!isHiddenPlayer(nick)) { msg.reply("'"+nick+"' 은(는) 숨김 상태가 아닙니다."); return; }
            DBH.withDB(DB_PATH, function(db7){ try { db7.execSQL("DELETE FROM hiding_players WHERE lol_nickname=?",[nick]); } finally {  } });
            msg.reply("👀 '"+nick+"' 을(를) 다시 순위에 표시합니다.");
            return;
        }

        // ── 내전기록 ─────────────────────────────────────────────
        else if (text.startsWith("!내전기록")) {
            var gidInput = text.replace("!내전기록","").trim();
            if (!gidInput) {
                var rg=getRecentGameRecords(1);
                if (!rg.length) { msg.reply("게임 기록이 없습니다."); return; }
                var g=rg[0], m="=== 최근 게임 기록 ===\n["+g.id+"회차]\n왼쪽팀\n"+g.leftTeam.join(", ")+"\n";
                if (g.leftChampions.length) m+="=============\n"+g.leftChampions.join(", ")+"\n";
                m+="\n오른쪽팀\n"+g.rightTeam.join(", ")+"\n";
                if (g.rightChampions.length) m+="=============\n"+g.rightChampions.join(", ")+"\n";
                m+="\n결과: "+(g.winningTeam==="left"?"왼쪽팀 승리":"오른쪽팀 승리");
                msg.reply(m);
            } else {
                var gid=parseInt(gidInput);
                if (isNaN(gid)) { msg.reply("올바른 게임 ID를 입력하세요."); return; }
                var gr=getGameRecordById(gid);
                if (!gr) { msg.reply("해당 게임 ID의 기록이 없습니다."); return; }
                var m="["+gr.id+"회차 게임 기록]\n왼쪽팀\n"+gr.leftTeam.join(", ")+"\n";
                if (gr.leftChampions.length) m+="=============\n"+gr.leftChampions.join(", ")+"\n";
                m+="\n오른쪽팀\n"+gr.rightTeam.join(", ")+"\n";
                if (gr.rightChampions.length) m+="=============\n"+gr.rightChampions.join(", ")+"\n";
                m+="\n결과: "+(gr.winningTeam==="left"?"왼쪽팀 승리":"오른쪽팀 승리")+"\n일시: "+formatGameDate(gr.gameDate);
                msg.reply(m);
            }
            return;
        }

        // ── 회차수정 ─────────────────────────────────────────────
        else if (text.startsWith("!회차수정 ")) {
            var gid=parseInt(text.replace("!회차수정","").trim());
            if (isNaN(gid)) { msg.reply("사용법: !회차수정 게임ID"); return; }
            var g=getGameRecordById(gid);
            if (!g) { msg.reply("해당 회차 기록이 없습니다."); return; }
            st.editRecord={active:true,gameId:gid,originalGame:g,newLeftChamps:null,newRightChamps:null,newWinner:null};
            msg.reply("🛠 "+gid+"회차 수정 모드\n!승리 왼쪽 / 오른쪽\n!챔프수정 왼쪽 챔1,챔2...\n!챔프수정 오른쪽 챔1,챔2...\n!수정완료");
            return;
        }

        else if (st.editRecord.active && text.startsWith("!승리 ")) {
            var t=text.replace("!승리","").trim();
            if (t!=="왼쪽"&&t!=="오른쪽") { msg.reply("왼쪽 또는 오른쪽만 가능합니다."); return; }
            st.editRecord.newWinner=(t==="왼쪽")?"left":"right";
            msg.reply("승리 팀 수정 완료"); return;
        }

        else if (st.editRecord.active && text.startsWith("!챔프수정 ")) {
            var parts=text.replace("!챔프수정","").trim().split(" ");
            var side=parts.shift(), champs=parts.join(" ").split(",");
            if (side==="왼쪽") st.editRecord.newLeftChamps=champs;
            else if (side==="오른쪽") st.editRecord.newRightChamps=champs;
            else { msg.reply("왼쪽 또는 오른쪽만 가능합니다."); return; }
            msg.reply(side+" 챔프 수정 완료"); return;
        }

        else if (st.editRecord.active && text === "!수정완료") {
            var gid=st.editRecord.gameId, origW=st.editRecord.originalGame.winningTeam;
            var newW=st.editRecord.newWinner||origW;
            if (origW!==newW) { rollbackGameStats(gid); applyGameStats(gid, newW); }
            DBH.withDB(DB_PATH, function(db8){
            try {
                db8.execSQL("UPDATE games SET winning_team=?,left_team_champions=?,right_team_champions=? WHERE id=?",
                    [newW,(st.editRecord.newLeftChamps||st.editRecord.originalGame.leftChampions).join(","),(st.editRecord.newRightChamps||st.editRecord.originalGame.rightChampions).join(","),gid]);
            } finally {  }
            });
            st.editRecord.active=false;
            msg.reply("✅ 회차 수정 완료"); return;
        }

        // ── 무결성검사 ───────────────────────────────────────────
        else if (text === "!무결성검사") {
            var mm=checkIntegrity();
            if (!mm.length) { msg.reply("✅ 무결성 검사 완료\n모든 플레이어 기록이 정상입니다."); return; }
            var m="⚠ 무결성 오류 발견 ("+mm.length+"명)\n\n";
            for (var i=0;i<mm.length;i++) {
                var x=mm[i];
                m+="• "+x.nickname+"\n players: "+x.players.wins+"승 "+x.players.losses+"패 ("+x.players.total+")\n actual : "+x.actual.wins+"승 "+x.actual.losses+"패 ("+x.actual.total+")\n\n";
            }
            rebuildPlayersTableFromParticipants();
            msg.reply(m+"🔧 복구 완료"); return;
        }

        // ── undefined검사 ────────────────────────────────────────
        else if (text === "!undefined검사") {
            var broken=findUndefinedParticipants();
            if (!broken.length) { msg.reply("undefined 기록 없음"); return; }
            var m="undefined 발견 회차 목록\n\n";
            for (var i=0;i<broken.length;i++) {
                var b=broken[i], members=getGameParticipants(b.gameId);
                m+="회차: "+b.gameId+"\n팀: "+b.team+"\n";
                for (var j=0;j<members.length;j++) m+=" - "+(members[j].nickname||"[NULL]")+" ("+members[j].team+")\n";
                if (i<broken.length-1) m+="\n";
            }
            msg.reply(m); return;
        }

        // ── 기록모드 ─────────────────────────────────────────────
        else if (text === "!기록모드 시작") {
            st.manualRecord={active:true,leftTeam:[],rightTeam:[],leftChamps:[],rightChamps:[],winner:"",gameDate:""};
            msg.reply("📘 수동 기록 모드를 시작합니다.\n!기록 왼쪽팀 A,B,C,D,E"); return;
        }
        else if (text === "!기록 취소" && st.manualRecord.active) {
            st.manualRecord.active=false; msg.reply("수동 기록 모드가 취소되었습니다."); return;
        }
        else if (text.startsWith("!기록 왼쪽팀") && st.manualRecord.active) {
            var names=text.replace("!기록 왼쪽팀","").trim().split(",").map(function(s){return s.trim();});
            if (names.length>5) { msg.reply("5명을 초과할 수 없습니다."); return; }
            for (var i=0;i<names.length;i++) { if (!isRegisteredNickname(names[i])) { msg.reply("등록되지 않은 닉네임: "+names[i]); return; } }
            st.manualRecord.leftTeam=names; msg.reply("왼쪽팀 등록 완료: "+names.join(", ")+"\n!기록 오른쪽팀 을 입력하세요."); return;
        }
        else if (text.startsWith("!기록 오른쪽팀") && st.manualRecord.active) {
            var names=text.replace("!기록 오른쪽팀","").trim().split(",").map(function(s){return s.trim();});
            if (names.length>5) { msg.reply("5명을 초과할 수 없습니다."); return; }
            for (var i=0;i<names.length;i++) { if (!isRegisteredNickname(names[i])) { msg.reply("등록되지 않은 닉네임: "+names[i]); return; } }
            st.manualRecord.rightTeam=names; msg.reply("오른쪽팀 등록 완료: "+names.join(", ")+"\n!기록 왼쪽챔프 을 입력하세요."); return;
        }
        else if (text.startsWith("!기록 왼쪽챔프") && st.manualRecord.active) {
            var champs=text.replace("!기록 왼쪽챔프","").trim().split(",").map(function(s){return s.trim();});
            if (champs.length>5) { msg.reply("5개를 초과할 수 없습니다."); return; }
            for (var i=0;i<champs.length;i++) { if (champlist.indexOf(champs[i])===-1) { msg.reply("존재하지 않는 챔피언: "+champs[i]); return; } }
            st.manualRecord.leftChamps=champs; msg.reply("왼쪽팀 챔피언 입력 완료.\n!기록 오른쪽챔프 을 입력하세요."); return;
        }
        else if (text.startsWith("!기록 오른쪽챔프") && st.manualRecord.active) {
            var champs=text.replace("!기록 오른쪽챔프","").trim().split(",").map(function(s){return s.trim();});
            if (champs.length>5) { msg.reply("5개를 초과할 수 없습니다."); return; }
            for (var i=0;i<champs.length;i++) { if (champlist.indexOf(champs[i])===-1) { msg.reply("존재하지 않는 챔피언: "+champs[i]); return; } }
            st.manualRecord.rightChamps=champs; msg.reply("오른쪽팀 챔피언 입력 완료.\n!기록 승리 을 입력하세요."); return;
        }
        else if (text.startsWith("!기록 승리") && st.manualRecord.active) {
            var w=text.replace("!기록 승리","").trim();
            if (w!=="left"&&w!=="right") { msg.reply("left 또는 right 만 가능합니다."); return; }
            st.manualRecord.winner=w; msg.reply("승리팀 입력 완료: "+w+"\n!기록 날짜 을 입력하세요."); return;
        }
        else if (text.startsWith("!기록 날짜") && st.manualRecord.active) {
            var dt=text.replace("!기록 날짜","").trim();
            if (!isValidDateTime(dt)) { msg.reply("날짜 형식 오류\n예: 2025-01-02 21:30"); return; }
            st.manualRecord.gameDate=dt;
            var m="날짜 입력 완료: "+dt+"\n=== 기록 예정 게임 ===\n";
            m+="왼쪽팀: "+st.manualRecord.leftTeam.join(", ")+"\n왼쪽챔프: "+st.manualRecord.leftChamps.join(", ")+"\n\n";
            m+="오른쪽팀: "+st.manualRecord.rightTeam.join(", ")+"\n오른쪽챔프: "+st.manualRecord.rightChamps.join(", ")+"\n\n";
            m+="승리팀: "+st.manualRecord.winner+"\n날짜: "+st.manualRecord.gameDate+"\n\n!기록 저장 으로 저장합니다.";
            msg.reply(m); return;
        }
        else if (text === "!기록 확인" && st.manualRecord.active) {
            var m="=== 현재 기록 상태 ===\n왼쪽팀: "+st.manualRecord.leftTeam.join(", ")+"\n오른쪽팀: "+st.manualRecord.rightTeam.join(", ")+"\n승리팀: "+st.manualRecord.winner+"\n날짜: "+st.manualRecord.gameDate+"\n\n!기록 저장 으로 저장합니다.";
            msg.reply(m); return;
        }
        else if (text === "!기록 저장" && st.manualRecord.active) {
            if (!st.manualRecord.winner||!st.manualRecord.gameDate) { msg.reply("입력이 완료되지 않은 항목이 있습니다.\n!기록 확인으로 확인하세요."); return; }
            DBH.withDB(DB_PATH, function(db9){
            var gid=null;
            try {
                DBH.transaction(db9, function(db9){
                db9.execSQL("INSERT INTO games(left_team,right_team,left_team_champions,right_team_champions,winning_team,game_date) VALUES(?,?,?,?,?,?)",
                    [st.manualRecord.leftTeam.join(","),st.manualRecord.rightTeam.join(","),st.manualRecord.leftChamps.join(","),st.manualRecord.rightChamps.join(","),st.manualRecord.winner,st.manualRecord.gameDate]);
                var cur9=db9.rawQuery("SELECT last_insert_rowid()",[]);
                cur9.moveToFirst(); gid=cur9.getInt(0); cur9.close();
                for (var i=0;i<st.manualRecord.leftTeam.length;i++) {
                    var isWL=(st.manualRecord.winner==="left");
                    db9.execSQL("INSERT INTO game_participants(game_id,lol_nickname,team,is_winner) VALUES(?,?,?,?)",[gid,st.manualRecord.leftTeam[i],"left",isWL]);
                    updatePlayerStats(db9,st.manualRecord.leftTeam[i],isWL);
                }
                for (var i=0;i<st.manualRecord.rightTeam.length;i++) {
                    var isWR=(st.manualRecord.winner==="right");
                    db9.execSQL("INSERT INTO game_participants(game_id,lol_nickname,team,is_winner) VALUES(?,?,?,?)",[gid,st.manualRecord.rightTeam[i],"right",isWR]);
                    updatePlayerStats(db9,st.manualRecord.rightTeam[i],isWR);
                }
                });
                st.manualRecord.active=false;
                msg.reply("저장 완료! 게임ID: "+gid);
            } catch(e) { msg.reply("저장 실패: "+e.message); }
            finally {  }
            });
            return;
        }

        // ── 도움말 ───────────────────────────────────────────────
        else if (text === "!내전") {
            var h="=== 내전봇 명령어 ===\n";
            h+="!내전 - 이 명령어 도움말\n";
            h+="==================\n";
            h+="!닉네임 - 현재 등록된 롤 닉네임 확인\n";
            h+="!닉네임등록 롤닉네임 - 신규등록 / 닉네임변경 (hash 기준)\n";
            h+="!닉네임재등록 롤닉네임 - 카카오계정 변경 시 hash 재연결\n";
            h+="==================\n";
            h+="!내전시작 - 내전 시작\n";
            h+="!참가 - 내전 참가\n";
            h+="!강제참가 롤닉네임 - 특정 플레이어 강제참가\n";
            h+="!참가취소 - 내전 참가 취소\n";
            h+="!이전게임 - 전판 참여자 자동참가\n";
            h+="!시작 - 팀 배정 및 게임 시작\n";
            h+="!팀다시짜기 - 팀 재배정\n";
            h+="!챔프 - 팀별 챔피언 확인 (개인톡)\n";
            h+="!승리왼쪽 / !승리오른쪽 - 승리 기록\n";
            h+="!초기화 - 내전 모집 상태 초기화\n";
            h+="==================\n";
            h+="!순위 - 전체 플레이어 승률 순위\n";
            h+="!파트너순위 [@카카오이름|롤닉네임] - 파트너 승률 순위\n";
            h+="!상대전적 [@카카오이름|롤닉네임] - 상대전적 순위\n";
            h+="!팀통계순위 - 모든 팀 조합 승률 순위\n";
            h+="!통계 [@카카오이름|롤닉네임] - 플레이어 통계\n";
            h+="!팀통계 롤닉네임1 롤닉네임2 - 두 플레이어 팀별 승률\n";
            h+="!elo [롤닉네임] - ELO 순위 또는 특정 플레이어 ELO\n";
            h+="==================\n";
            h+="!내전기록 - 마지막 게임 기록\n";
            h+="!내전기록 게임ID - 게임 회차 기록 조회";
            msg.reply(h); return;
        }

        // ── 리로드 ───────────────────────────────────────────────
        else if ((msg.author.name === "신쫑" || msg.author.name === "신종화") && text.startsWith("!리로드")) {
            Api.reload(); msg.reply("봇이 리로드되었습니다."); return;
        }

    } catch(e) {
        try { msg.reply("오류: "+e.message); } catch(_) {}
    }
}

// ─── 프리필터: "!" 로 시작하는 명령만 처리 ──────────────────────────────────
function isMyCommand(text) {
    return !!text && text.indexOf("!") === 0;
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독, 공용 모듈) ───────────────────
var WORKER_NAME = "NAEJEON_BOT_WORKER";

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
    var text = String(msg.content || "");
    if (!isMyCommand(text)) return;
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