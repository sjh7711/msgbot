// =====================================================================
// kakao-msg-render.js — KakaoTalk chat_logs 메시지 → 사람이 읽는 한 줄 변환
//   (지운채팅 뷰어 등에서 재사용. 타입별 렌더링 + 미지 타입 자가발견 로깅)
//
// render(ctx): ctx = { type:Number, message:String|null, att:Object|null }
//   message/att 는 호출부에서 "복호화·JSON파싱 완료"된 값 (실패/빈값이면 null).
//   type 은 원본 chat_logs.type (0x4000 임시/잔여 비트는 내부에서 마스킹).
//
// 타입 추가법:
//   - 이모티콘류       → EMOTICON 에  type:1            한 줄
//   - URL 우선 미디어  → MEDIA 에     type:"(라벨)"     한 줄 (URL 자동 추출)
//   - 그 외(텍스트성)는 등록 불필요: message 있으면 그대로, 링크 있으면 URL.
//   - 처음 보는 타입은 /sdcard/msgbot/deleted_unknown_types.log 에 1회 기록됨.
//     (그 로그의 att.keys 를 보고 필요할 때 위 표에 한 줄 추가)
//
// RhinoJS-safe: var / function 만. arrow/템플릿리터럴/?. ?? 미사용.
// =====================================================================

var UNKNOWN_LOG = Packages.android.os.Environment.getExternalStorageDirectory()
    .getAbsolutePath() + "/msgbot/deleted_unknown_types.log";

function isHttp(v){ return (typeof v === "string") && /^https?:\/\//.test(v); }

// attachment 어디에 있든 '원본' http URL 1개 추출.
//   ① 원본 URL 우선순위 키 → ② 'thumb' 안 든 키의 http URL (미지 타입 대비)
//   섬네일(thumbnailUrl)은 의도적으로 회피 → 사진은 항상 원본 URL.
function pickUrl(att){
  if (!att) return null;
  var prefer = ["url", "videoUrl", "audioUrl", "fileUrl"];
  for (var i = 0; i < prefer.length; i++) if (isHttp(att[prefer[i]])) return String(att[prefer[i]]);
  for (var k in att) if (!/thumb/i.test(k) && isHttp(att[k])) return String(att[k]);
  return null;
}

// message 복호화가 비고 attachment 가 스티커인 이모티콘류 (12/20/25 실측)
var EMOTICON = { 12: 1, 20: 1, 25: 1 };
// 플레이스홀더('사진'/'동영상') 대신 원본 URL 을 보여줄 미디어. 값 = URL 없을 때 라벨.
var MEDIA = { 2: "(사진)", 3: "(동영상)", 5: "(음성메시지)", 18: "(파일)" };

var _seenUnknown = {};
function logUnknownType(t, att){
  if (_seenUnknown[t]) return; _seenUnknown[t] = 1;
  try {
    var keys = att ? Object.keys(att).join(",") : "(no att)";
    var fw = new java.io.FileWriter(UNKNOWN_LOG, true);
    fw.write(new java.util.Date().toString() + " type=" + t + " att.keys=" + keys + "\n");
    fw.close();
  } catch (_) {}
}

function render(ctx){
  var t = (ctx.type | 0) & 0x3FFF;                 // 0x4000 임시/삭제 잔여비트 제거
  if (EMOTICON[t]) return "이모티콘";
  if (MEDIA[t]) { var u = pickUrl(ctx.att); return u ? u : MEDIA[t]; }  // 미디어: URL 우선
  if (ctx.message) return String(ctx.message);     // 텍스트/위치/답장/미니게임/멀티사진
  var u2 = pickUrl(ctx.att);
  if (u2) return u2;                               // 미지 타입이라도 링크 있으면 URL
  logUnknownType(t, ctx.att);                      // 처음 보는 타입 자가발견 기록
  return "(첨부 type " + t + ")";
}

module.exports = {
  render: render,
  pickUrl: pickUrl,
  isHttp: isHttp,
  EMOTICON: EMOTICON,
  MEDIA: MEDIA
};
