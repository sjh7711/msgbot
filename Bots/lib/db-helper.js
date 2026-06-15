// =====================================================================
// db-helper.js — SQLite 공용 헬퍼 (withDB / queryAll / transaction)
//
// 목적: 매 호출마다 DB 를 직접 open/close 하는 봇들
//   (내전봇 naejeon / 상식퀴즈봇 quiz / zqt) 의 향후 마이그레이션용.
//   현재 어떤 봇에도 연결되어 있지 않다 (NOT yet wired). 기존 봇들의
//   openOrCreateDatabase(path,null) + rawQuery + 커서 finally close +
//   beginTransaction/setTransactionSuccessful/endTransaction 패턴을
//   그대로 캡슐화한다.
//
// ⚠ require() 경로 / lib 폴더 위치는 디바이스에서 미확인. subscriber.js
//   프로토타입(eval) 검증 후에 도입을 검토한다.
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
  queryAll: queryAll,
  transaction: transaction
};
