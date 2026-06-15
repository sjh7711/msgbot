/**
 * This API has been deprecated, please migration to api2
 * For a more detail, check https://messengerbotteam.github.io/posts/sunset-legacy-api.html
 */

const scriptName = "{{fileName}}";

/**
 * (string) room
 * (string) sender
 * (boolean) isGroupChat
 * (void) replier.reply(message)
 * (boolean) replier.reply(room, message, hideErrorToast = false) // 전송 성공시 true, 실패시 false 반환
 * (string) imageDB.getProfileBase64()
 * (string) packageName
 * 
 * The following parameters require the “Extended parameters” option to be enabled in the script settings to function.
 * (boolean) isMention
 * (bigint) logId
 * (bigint) channelId
 * (string) userHash
 */
function response(/*{{parameter}}*/) {
  
}

//아래 4개의 메소드는 액티비티 화면을 수정할때 사용됩니다.
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