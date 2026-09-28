/**
 * Google Apps Script - send CPMS email from a Google Workspace mailbox.
 *
 * Why this exists: Resend will not send "from" a domain until DNS records prove the domain is
 * yours. This needs no DNS at all. It runs inside a mailbox you already own and sends with the
 * permission that mailbox already has, so every email:
 *   - goes out from a real address, and lands in that mailbox's Sent folder;
 *   - carries its attachments (agreement PDF, supplier invoices, reports);
 *   - brings replies back to the address it was sent from.
 *
 * Which address an email goes out from
 * ------------------------------------
 * The app asks for an address: the person signed in, or the From field on the send screen.
 *   - That address is this mailbox, or one of its Gmail "Send mail as" addresses: it is sent FROM
 *     that address, and replies go back to it.
 *   - Any other address: it is sent from this mailbox with Reply-To set to the address asked for,
 *     so replies still reach that person.
 * To send as someone else properly, add their address in Gmail -> Settings -> Accounts ->
 * "Send mail as" (Gmail emails them a confirmation link once).
 *
 * ---------------------------------------------------------------------------
 * Setting it up  (about ten minutes, once)
 * ---------------------------------------------------------------------------
 * 1. From the project folder run
 *      powershell -ExecutionPolicy Bypass -File supabase\functions\resend-email\make-gmail-sender.ps1
 *    It writes CPMS-gmail-sender.gs to your Desktop with the key already in SEND_KEY. Paste THAT
 *    file, never this one: this one lives in a public repository.
 * 2. Sign in to Gmail as the mailbox that should send, open https://script.google.com ->
 *    New project, delete the sample, paste the Desktop file in, press Ctrl+S.
 * 3. Pick testSetup -> Run. Google asks you to authorise it: it is your own script sending from
 *    your own mailbox, so approve it ("unverified app" is expected - Advanced -> Go to project).
 *    The log lists this mailbox, its Send-mail-as addresses and how many emails are left today.
 * 4. Deploy -> New deployment -> gear -> Web app.
 *      Execute as:      Me
 *      Who has access:  Anyone        (the key below is what keeps strangers out)
 *    Deploy, and copy the Web app URL. Paste it into the PowerShell window when it asks.
 * 5. Optional: pick sendTest -> Run to email yourself one message with this script.
 *
 * Changing the script later: Deploy -> Manage deployments -> edit -> Version: New version. A new
 * deployment would give a new URL, and the app would still be calling the old one.
 *
 * Google's limit: about 1,500 recipients a day on Google Workspace (100 on a free Gmail account).
 */

var SEND_KEY = 'PASTE_YOUR_SEND_KEY_HERE';

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!req || !SEND_KEY || SEND_KEY === 'PASTE_YOUR_SEND_KEY_HERE' || req.key !== SEND_KEY) return reply_({ error: 'Not authorised' });

    var to = clean_(req.to);
    if (!to.length) return reply_({ error: 'No recipients' });
    var cc = clean_(req.cc);

    var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    var aliases = GmailApp.getAliases().map(function (a) { return String(a).toLowerCase(); });
    var want = String(req.from || '').trim().toLowerCase();

    var opts = {};
    if (req.html) opts.htmlBody = String(req.html);
    if (cc.length) opts.cc = cc.join(',');
    var sentFrom = me, replyTo = me;
    if (want && want !== me && aliases.indexOf(want) >= 0) {
      // one of this mailbox's own Send-mail-as addresses: send as it, and replies come back to it
      opts.from = want; sentFrom = want; replyTo = want;
      if (req.fromName) opts.name = String(req.fromName);
    } else if (want && want !== me) {
      // not an address this mailbox may send as: send from here, with replies going to the person
      opts.replyTo = want; replyTo = want;
      if (req.fromName) opts.name = String(req.fromName) + ' (via ' + me + ')';
    } else if (req.fromName) {
      opts.name = String(req.fromName);
    }

    var files = [];
    (req.attachments || []).forEach(function (a) {
      if (!a || !a.data) return;
      files.push(Utilities.newBlob(Utilities.base64Decode(a.data), a.mimeType || 'application/octet-stream', a.name || 'attachment'));
    });
    if (files.length) opts.attachments = files;

    GmailApp.sendEmail(to.join(','), String(req.subject || '(no subject)'), String(req.text || ''), opts);
    return reply_({ ok: true, from: sentFrom, replyTo: replyTo, sent: to.length, cc: cc.length, attachments: files.length,
      leftToday: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply_({ error: String(err && err.message ? err.message : err) });
  }
}

// A browser opening the URL gets a plain answer instead of an error page.
function doGet() { return reply_({ ok: true, service: 'CPMS Gmail sender', note: 'POST only' }); }

function clean_(list) {
  return (Array.isArray(list) ? list : []).map(function (x) { return String(x || '').trim(); })
    .filter(function (x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); });
}
function reply_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// Run once: authorises the script and shows what it can send as. Sends nothing.
function testSetup() {
  Logger.log('Key filled in: ' + (SEND_KEY && SEND_KEY !== 'PASTE_YOUR_SEND_KEY_HERE' ? 'yes' : 'NO - paste the Desktop file, not the template'));
  Logger.log('This mailbox: ' + Session.getEffectiveUser().getEmail());
  var al = GmailApp.getAliases();
  Logger.log('Send mail as: ' + (al.length ? al.join(', ') : '(none - add them in Gmail > Settings > Accounts)'));
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
}

// Optional: one email to this mailbox, sent the same way the app sends.
function sendTest() {
  var me = Session.getEffectiveUser().getEmail();
  var res = doPost({ postData: { contents: JSON.stringify({ key: SEND_KEY, to: [me], subject: 'CPMS - Gmail sender test', text: 'If you can read this, CPMS can send from ' + me + '.' }) } });
  Logger.log(res.getContent());
}
