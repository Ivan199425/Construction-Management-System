/**
 * Google Apps Script — hand invoices from Gmail to the CPMS inbound-email function.
 *
 * This is the route that needs nothing: no DNS, no MX record, no mail provider, no OAuth app.
 * It runs inside the Google account that already receives the invoices, reads them with the
 * permission that account already has, and posts each message whole.
 *
 * ---------------------------------------------------------------------------
 * Setting it up  (about five minutes, once)
 * ---------------------------------------------------------------------------
 * 1. Sign in to Gmail as the account the invoices arrive at, then open
 *      https://script.google.com  ->  New project
 * 2. Delete the sample code, paste this file in, and rename the project
 *    something like "CPMS invoice collector".
 * 3. Put your webhook URL in ENDPOINT below — the one setup.ps1 printed, including the
 *    ?key=... part. If you no longer have it, run setup.ps1 again and it will make a new one.
 * 4. Run -> Run function -> collectInvoices. Google will ask you to authorise it: it is your
 *    own script reading your own mailbox, so approve it. (The "unverified app" screen is
 *    expected for a script you wrote yourself — Advanced -> Go to project.)
 * 5. Check the log. It will say how many it found and sent.
 * 6. Triggers (the clock icon) -> Add trigger -> collectInvoices -> Time-driven ->
 *    Minutes timer -> Every 15 minutes.
 *
 * That is the whole thing. From then on, invoices arrive in CPMS by themselves.
 *
 * ---------------------------------------------------------------------------
 * What it sends
 * ---------------------------------------------------------------------------
 * The entire original message, exactly as it arrived — headers, body and attachments — which is
 * what CPMS wants, because it reads an emailed invoice with the same code it uses for a .eml
 * dropped on the Invoices screen. Nothing is summarised or re-encoded on the way.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The webhook URL, including ?key=... — from setup.ps1. */
var ENDPOINT = 'PASTE_YOUR_WEBHOOK_URL_HERE';

/**
 * Which mail counts as an invoice.
 *
 * Start narrow. Everything this matches is put in front of whoever clears the invoice queue, so
 * a query that catches the whole inbox makes work rather than saving it. CPMS will still set
 * aside anything it cannot place on a project, but that is a second line of defence, not a
 * substitute for a sensible query here.
 *
 *   has:attachment            an invoice is a document, not a sentence in an email
 *   newer_than:7d             a window, so a first run does not sweep up years of mail
 *   -from:me                  your own sent mail is not a supplier invoice
 *
 * Narrow it further once it is running, for example:
 *   subject:(invoice OR "tax invoice" OR claim OR statement)
 *   to:accounts@sydneylvl.com
 */
var QUERY = 'has:attachment newer_than:7d -from:me';

/** Applied to anything sent, so you can see what has been collected. Created if missing. */
var LABEL = 'CPMS collected';

/** How many messages to send in one run. The trigger comes round again for the rest. */
var MAX_PER_RUN = 25;

// ---------------------------------------------------------------------------

function collectInvoices() {
  if (ENDPOINT.indexOf('PASTE_YOUR') === 0) {
    throw new Error('Set ENDPOINT to the webhook URL that setup.ps1 printed.');
  }

  var label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  var props = PropertiesService.getScriptProperties();
  var seen = {};
  try { seen = JSON.parse(props.getProperty('seen') || '{}'); } catch (e) { seen = {}; }

  var threads = GmailApp.search(QUERY, 0, 100);
  var sent = 0, skipped = 0, failed = 0;

  for (var t = 0; t < threads.length && sent < MAX_PER_RUN; t++) {
    var msgs = threads[t].getMessages();
    var touched = false;

    for (var m = 0; m < msgs.length && sent < MAX_PER_RUN; m++) {
      var msg = msgs[m];
      var id = msg.getId();

      // Tracked per message, not per thread: a reply lands on the same thread, and a thread-level
      // mark would hide a second invoice that arrived in the same conversation.
      if (seen[id]) { skipped++; continue; }

      // An email with no attachment is a covering note, not an invoice. CPMS would set it aside
      // anyway, so there is no point spending a request on it.
      if (!msg.getAttachments().length) { seen[id] = 1; continue; }

      var raw = msg.getRawContent();

      // The address it was actually delivered to. On a forward the To: header names somebody
      // else, and this is what tells CPMS the message is one of yours.
      var url = ENDPOINT
        + (ENDPOINT.indexOf('?') >= 0 ? '&' : '?')
        + 'to=' + encodeURIComponent(firstAddress(msg.getTo()) || Session.getActiveUser().getEmail());

      var res;
      try {
        res = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'message/rfc822',
          payload: raw,
          muteHttpExceptions: true,
        });
      } catch (err) {
        Logger.log('could not reach CPMS: ' + err);
        failed++;
        continue;   // leave it unmarked, so the next run tries again
      }

      var code = res.getResponseCode();
      if (code === 200) {
        seen[id] = 1;
        touched = true;
        sent++;
        Logger.log('sent: ' + msg.getSubject() + '  ' + res.getContentText().slice(0, 120));
      } else if (code === 401) {
        // Nothing will work until this is fixed, so stop rather than hammer it.
        throw new Error('CPMS refused the key. Run setup.ps1 again and paste the new URL into ENDPOINT.');
      } else {
        failed++;
        Logger.log('CPMS said ' + code + ': ' + res.getContentText().slice(0, 200));
      }
    }

    if (touched) threads[t].addLabel(label);
  }

  // Keep the list from growing without end. Gmail ids are 16 characters, so a few thousand is
  // nothing, but there is no reason to remember last year's.
  var keys = Object.keys(seen);
  if (keys.length > 4000) {
    var trimmed = {};
    keys.slice(keys.length - 2000).forEach(function (k) { trimmed[k] = 1; });
    seen = trimmed;
  }
  props.setProperty('seen', JSON.stringify(seen));

  Logger.log('done — sent ' + sent + ', already had ' + skipped + ', failed ' + failed);
}

/** "Ivan <ivan@x.com>, accounts@x.com" -> "ivan@x.com" */
function firstAddress(header) {
  var first = String(header || '').split(',')[0] || '';
  var m = first.match(/<([^>]+)>/);
  return (m ? m[1] : first).trim();
}

/**
 * Run this once, by hand, to check the connection without sending anything real.
 * It posts a small made-up invoice and reports what CPMS said.
 */
function testConnection() {
  if (ENDPOINT.indexOf('PASTE_YOUR') === 0) throw new Error('Set ENDPOINT first.');
  var eml = [
    'From: Test Supplier <accounts@example.com>',
    'To: accounts@sydneylvl.com',
    'Subject: Tax Invoice TEST-0001 - connection check',
    'Message-ID: <cpms-gmail-test-' + Date.now() + '@example.com>',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Total: $1.00',
    '',
  ].join('\r\n');
  var res = UrlFetchApp.fetch(ENDPOINT + (ENDPOINT.indexOf('?') >= 0 ? '&' : '?')
    + 'to=accounts@sydneylvl.com', {
    method: 'post', contentType: 'message/rfc822', payload: eml, muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + '  ' + res.getContentText());
  if (res.getResponseCode() === 200) {
    Logger.log('Good. Open CPMS -> Invoices -> Check mail and it should appear.');
  }
}

/** Forget what has been sent, so the next run re-sends everything the query matches. */
function resetHistory() {
  PropertiesService.getScriptProperties().deleteProperty('seen');
  Logger.log('history cleared — the next run will re-send anything matching QUERY');
}
