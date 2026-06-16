// =====================================================================
// db-helper.js — SQLite 공용 헬퍼 (withDB / withReadOnlyDB / queryAll / transaction)
//
// 목적: 매 호출마다 DB 를 직접 open/close 하는 봇들의 공용 자원관리.
//   openOrCreateDatabase(path,null) + rawQuery + 커서 finally close +
//   beginTransaction/setTransactionSuccessful/endTransaction 패턴을
//   캡슐화해 커넥션/커서 누수를 막는다.
//
// 적용된 봇: zqt / 내전봇(naejeon) / 상식퀴즈봇(quiz) / 제미니봇 / 단어퀴즈봇.
//   - withDB         : openOrCreateDatabase (읽기/쓰기, 없으면 생성)
//   - withReadOnlyDB : openDatabase(OPEN_READONLY) — stdict/freq 사전, 교차조회
//                      quiz.db, userhash.db 등 남이 소유한 DB 를 읽기만 할 때
//   ※ 로그봇은 커넥션을 캐싱(_hashDb 재사용)하므로 의도적으로 미적용.
//
// RhinoJS-safe: var / function 만. ?. , ?? , 템플릿리터럴, arrow 미사용.
// =====================================================================

var SQLiteDatabase = Packages.android.database.sqlite.SQLiteDatabase;

// ─── withDB(path, fn): DB 를 열어 fn(db) 실행 후 항상 close ──────────
//   fn 의 반환값을 그대로 돌려준다.
function withDB(path, fn) {
  var db = SQLiteDatabase.openOrCreateDatabase(path, null);
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch(_) {}
  }
}

// ─── withReadOnlyDB(path, fn): 읽기전용으로 열어 fn(db) 실행 후 항상 close ──
//   다른 곳이 소유한 DB 를 읽기만 할 때 (stdict.db/freq.db 사전, 교차조회 quiz.db,
//   userhash.db 등). openOrCreateDatabase 와 달리 파일이 없으면 생성하지 않고
//   예외를 던지므로, "DB 없으면 폴백" 로직은 호출부에서 withReadOnlyDB 를
//   try/catch 로 감싸 처리한다. fn 의 반환값을 그대로 돌려준다.
function withReadOnlyDB(path, fn) {
  var db = SQLiteDatabase.openDatabase(path, null, SQLiteDatabase.OPEN_READONLY);
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch(_) {}
  }
}

// ─── queryAll(db, sql, args): rawQuery 결과를 행 배열로 변환 ─────────
//   각 행은 { 컬럼명: 값(String) } 객체. 커서는 finally 에서 close.
//   args 는 JS 배열(또는 null). Rhino 가 String[] 로 변환.
function queryAll(db, sql, args) {
  var cur = null;
  try {
    cur = db.rawQuery(sql, args || []);
    var rows = [];
    var colCount = cur.getColumnCount();
    var colNames = [];
    for (var c = 0; c < colCount; c++) {
      colNames.push(String(cur.getColumnName(c)));
    }
    while (cur.moveToNext()) {
      var row = {};
      for (var j = 0; j < colCount; j++) {
        if (cur.isNull(j)) {
          row[colNames[j]] = null;
        } else {
          row[colNames[j]] = String(cur.getString(j));
        }
      }
      rows.push(row);
    }
    return rows;
  } finally {
    if (cur) { try { cur.close(); } catch(_) {} }
  }
}

// ─── transaction(db, fn): 트랜잭션 안에서 fn(db) 실행 ───────────────
//   fn 이 정상 반환하면 setTransactionSuccessful, 예외면 롤백.
//   endTransaction 은 항상 호출. fn 반환값을 그대로 돌려준다.
function transaction(db, fn) {
  db.beginTransaction();
  try {
    var result = fn(db);
    db.setTransactionSuccessful();
    return result;
  } finally {
    try { db.endTransaction(); } catch(_) {}
  }
}

module.exports = {
  withDB: withDB,
  withReadOnlyDB: withReadOnlyDB,
  queryAll: queryAll,
  transaction: transaction
};
