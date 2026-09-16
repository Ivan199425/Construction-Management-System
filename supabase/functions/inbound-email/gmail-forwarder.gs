/**
 * Google Apps Script - hand invoices from Gmail to the CPMS inbound-email function.
 *
 * This is the route that needs nothing: no DNS, no MX record, no mail provider, no OAuth app.
 * It runs inside a Google account that receives the invoices, reads them with the permission
 * that account already has, and posts each message whole.
 *
 * ---------------------------------------------------------------------------
 * Invoices arrive at several addresses (ivan@, sales@, accounts@, ...)
 * ---------------------------------------------------------------------------
 * A script can only read the mailbox it runs in. Pick one of these:
 *
 *  A. One mailbox collects for everybody  (recommended - set up once, by the Workspace admin)
 *     Google Admin console -> Menu -> Apps -> Google Workspace -> Gmail -> Routing ->
 *     "Email forwarding using recipient address map" -> Configure (or Add another rule).
 *     Add one line per address:  Address ivan@sydneylvl.com   Map to address accounts@sydneylvl.com
 *     (and the same for sales@, sam@, hasan@, danny@ ...). Messages to affect: "Only external
 *     incoming messages". Tick "Also route to original destination" - without it the person stops
 *     getting their own mail. Save. Then install this script once, in accounts@.
 *     Everyone keeps their mail; accounts@ receives a copy of what outside senders write to them.
 *
 *  B. The same script in every mailbox
 *     Run make-gmail-script.ps1 ONCE, then paste that same file into script.google.com while
 *     signed in as each person, and do steps 3-5 below in each. (Running make-gmail-script.ps1
 *     again makes a new key and stops the copies already pasted.)
 *
 * ---------------------------------------------------------------------------
 * Setting it up  (about five minutes, once per mailbox)
 * ---------------------------------------------------------------------------
 * 1. From the project folder run
 *      powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\make-gmail-script.ps1
 *    It writes CPMS-gmail-collector.gs to your Desktop with the key already in ENDPOINT.
 *    Paste THAT file, never this one: this one lives in a public repository, and ENDPOINT here
 *    must stay as it is.
 * 2. Sign in to Gmail as the mailbox that collects, open https://script.google.com -> New project,
 *    delete the sample, paste the Desktop file in, press Ctrl+S.
 * 3. Pick testConnection -> Run. Google asks you to authorise it: it is your own script reading
 *    your own mailbox, so approve it ("unverified app" is expected - Advanced -> Go to project).
 *    The log should say 200.
 * 4. Pick collectInvoices -> Run. The log lists what it found and sent.
 * 5. Pick turnOn -> Run. From then on it runs by itself every 15 minutes.
 *
 * ---------------------------------------------------------------------------
 * What it sends
 * ---------------------------------------------------------------------------
 * The entire original message, exactly as it arrived - headers, body and attachments - which is
 * what CPMS wants, because it reads an emailed invoice with the same code it uses for a .eml
 * dropped on the Invoices screen. Nothing is summarised or re-encoded on the way.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The webhook URL, including ?key=... Leave this line exactly as it is in the repository copy:
 * make-gmail-script.ps1 fills it in, in the copy it writes to your Desktop.
 */
var ENDPOINT = 'PASTE_YOUR_WEBHOOK_URL_HERE';

/**
 * Which mail is an invoice.
 *
 * Gmail searches the words inside a PDF as well as the subject and the email, so an invoice sent
 * with nothing but "please see attached" is still found by the word "invoice" printed on it.
 * A scanned or photographed invoice has no words to find: ask for those to say "invoice" in the
 * subject, or forward them to the collecting mailbox with the word in it.
 *
 *   has:attachment     an invoice is a document, not a sentence in an email
 *   -from:me           the collecting mailbox's own sent mail is not a supplier invoice
 *   (invoice OR ...)   quotes, drawings and photos of the site stay out of the invoice queue
 *
 * To send every email with a PDF or picture attached, whatever it is:
 *   var SEARCH = 'has:attachment -from:me';
 * After changing SEARCH, run resetHistory once so mail already passed over is looked at again.
 */
var SEARCH = 'has:attachment -from:me (invoice OR invoices OR inv OR claim OR "amount due" OR "balance due" OR "payment due")';

/** How many days back to look. Older mail is never sent, however often it runs. */
var DAYS = 30;

/** Applied to a conversation when a message in it is sent, so you can see it in Gmail. Created if missing. */
var LABEL = 'CPMS collected';

/** How many messages to send in one run. The next run carries on from there. */
var MAX_PER_RUN = 25;

// ---------------------------------------------------------------------------

/** Conversations looked at in one run, and how long a run may take (Google stops a script at 6 minutes). */
var MAX_THREADS = 500;
var RUN_MS = 4.5 * 60 * 1000;

function collectInvoices() {
  if (ENDPOINT.indexOf('PASTE_YOUR') === 0) {
    throw new Error('Set ENDPOINT to the webhook URL - make-gmail-script.ps1 writes a copy with it filled in.');
  }

  var started = Date.now();
  var since = new Date(started - DAYS * 86400000);
  var me = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  var seen = seenList_();
  var query = SEARCH + ' newer_than:' + DAYS + 'd';
  var sent = 0, before = 0, passed = 0, failed = 0, refusedInARow = 0, stop = false;

  // Newest first, a page of 100 at a time. Reading past the first page is what keeps a busy month
  // from hiding its older invoices behind the ones already sent.
  for (var start = 0; start < MAX_THREADS && !stop; start += 100) {
    var threads = GmailApp.search(query, start, 100);

    for (var t = 0; t < threads.length && !stop; t++) {
      var msgs = threads[t].getMessages();
      var touched = false;

      for (var m = 0; m < msgs.length; m++) {
        if (sent >= MAX_PER_RUN || Date.now() - started > RUN_MS) { stop = true; break; }
        var msg = msgs[m];
        var id = msg.getId();

        // Tracked per message, not per thread: a reply lands on the same thread, and a thread-level
        // mark would hide a second invoice that arrived in the same conversation.
        if (seen.has(id)) { before++; continue; }

        // The search picks conversations; these are the messages in one that are not wanted - older
        // than the window, binned, sent from this mailbox, or with no PDF or picture attached.
        if (msg.getDate() < since) continue;
        if (msg.isInTrash()) continue;
        var subject = msg.getSubject();
        if (me && addressOf_(msg.getFrom()) === me) { seen.add(id, msg.getDate()); passed++; continue; }
        if (!hasDocument_(msg)) {
          seen.add(id, msg.getDate()); passed++;
          Logger.log('passed over (no PDF or picture attached): ' + subject);
          continue;
        }
        // A conversation is found when any message in it matches, so in a longer one check this
        // message on its own, so the quote that came before the invoice stays out.
        if (msgs.length > 1 && !matchesOnItsOwn_(msg, query)) {
          seen.add(id, msg.getDate()); passed++;
          Logger.log('passed over (not an invoice by SEARCH, in a conversation that has one): ' + subject);
          continue;
        }

        // The address it was written to. With a recipient address map this is still the person the
        // supplier wrote to (sam@, ivan@ ...), which is what CPMS records - not the collecting mailbox.
        var url = ENDPOINT
          + (ENDPOINT.indexOf('?') >= 0 ? '&' : '?')
          + 'to=' + encodeURIComponent(addressOf_(msg.getTo()) || me);

        var res;
        try {
          res = UrlFetchApp.fetch(url, {
            method: 'post',
            contentType: 'message/rfc822',
            payload: msg.getRawContent(),
            muteHttpExceptions: true,
          });
        } catch (err) {
          Logger.log('could not reach CPMS, will try again: ' + err);
          failed++;
          continue;   // left unmarked, so the next run tries again
        }

        var code = res.getResponseCode();
        var text = String(res.getContentText() || '');
        var reply = {};
        try { reply = JSON.parse(text) || {}; } catch (e) { reply = {}; }

        // A function deployed before the duplicate fix answers a second copy with a 500 naming
        // the unique index. It is still "already stored".
        if (code === 500 && /ap_inbox_msgid_idx|23505|duplicate key/i.test(text)) { code = 200; reply = { ok: true, duplicate: true }; }

        if (code === 200) {
          refusedInARow = 0;
          seen.add(id, msg.getDate());
          if (reply.duplicate) {
            // Already in CPMS - another copy of the same message. Not counted against MAX_PER_RUN,
            // so a mailbox full of copies can never stop new invoices getting through.
            before++;
            touched = true;
          } else if (reply.ignored) {
            passed++;
            Logger.log('not for CPMS (' + reply.ignored + '): ' + subject);
          } else {
            sent++;
            touched = true;
            Logger.log('sent: ' + subject);
          }
        } else if (code === 401) {
          seen.save();
          // Nothing will work until this is fixed, so stop rather than hammer it.
          throw new Error('CPMS refused the key. Paste the current CPMS-gmail-collector.gs from your Desktop into every mailbox that runs it; if that file is gone, run make-gmail-script.ps1 once and paste the new one into all of them.');
        } else if ((code === 400 && /Empty message/.test(text)) || code === 413) {
          // CPMS read the request and there is nothing it could ever store. Sending it again would
          // get the same answer.
          seen.add(id, msg.getDate());
          failed++;
          Logger.log('CPMS cannot take "' + subject + '" (' + code + '): ' + text.slice(0, 200));
        } else {
          // Busy, restricted or briefly misconfigured: left unmarked and tried again next run.
          failed++;
          Logger.log('CPMS said ' + code + ' to "' + subject + '", will try again: ' + text.slice(0, 200));
          if (code >= 400 && code < 500 && code !== 408 && code !== 429 && ++refusedInARow >= 3) {
            seen.save();
            // A failed run makes Google email the script's owner, which is the point.
            throw new Error('CPMS refused three messages in a row with ' + code + ': ' + text.slice(0, 200));
          }
        }
      }

      if (touched) threads[t].addLabel(label);
    }

    if (threads.length < 100) break;
  }

  seen.save();
  Logger.log('done - sent ' + sent + ', looked at before or already in CPMS ' + before + ', passed over ' + passed + ', failed ' + failed
    + (stop ? ' (more to do - the next run carries on)' : ''));
}

/** Run once: collectInvoices every 15 minutes from now on. Running it again does not add a second one. */
function turnOn() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'collectInvoices') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('collectInvoices').timeBased().everyMinutes(15).create();
  Logger.log('On - collectInvoices runs every 15 minutes. turnOff stops it.');
}

/** Stop the 15-minute runs. */
function turnOff() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'collectInvoices') { ScriptApp.deleteTrigger(tr); n++; }
  });
  Logger.log(n ? 'Off.' : 'It was not on.');
}

/**
 * A PDF, or a picture of an invoice - attached, or pasted into the email as a phone's mail app does -
 * but not a logo in somebody's signature: those are small, or named the way CPMS already ignores.
 */
function hasDocument_(msg) {
  var files = msg.getAttachments();
  for (var i = 0; i < files.length; i++) {
    var type = String(files[i].getContentType() || '').toLowerCase();
    var name = String(files[i].getName() || '').toLowerCase();
    if (type.indexOf('pdf') >= 0 || /\.pdf$/.test(name)) return true;
    var picture = type.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|tiff?)$/.test(name);
    if (picture && !/^(signature|logo|image00\d)/.test(name) && files[i].getSize() > 15000) return true;
  }
  return false;
}

/** Whether this one message, not just its conversation, matches the search. */
function matchesOnItsOwn_(msg, query) {
  var mid = String(msg.getHeader('Message-ID') || '').replace(/^\s*<|>\s*$/g, '');
  if (!mid) return true;   // nothing to search by: send it rather than risk losing an invoice
  return GmailApp.search('rfc822msgid:' + mid + ' ' + query, 0, 1).length > 0;
}

/** "Ivan <ivan@x.com>, accounts@x.com" -> "ivan@x.com" */
function addressOf_(header) {
  var first = String(header || '').split(',')[0] || '';
  var m = first.match(/<([^>]+)>/);
  return (m ? m[1] : first).trim().toLowerCase();
}

/**
 * Which messages have been dealt with. Google holds at most 9 KB in one script property, which is
 * about 400 message ids, so the list is kept in one property per day the mail arrived
 * (seen-20260917-0, then -1 if a day overflows) and days older than the window are dropped.
 */
function seenList_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties() || {};
  var days = {}, dirty = {};
  Object.keys(all).forEach(function (k) { if (/^seen-\d{8}-\d+$/.test(k)) days[k] = all[k]; });
  return {
    has: function (id) {
      for (var k in days) if (days[k].indexOf(',' + id + ',') >= 0) return true;
      return false;
    },
    add: function (id, date) {
      var day = dayKey_(date || new Date());
      for (var n = 0; ; n++) {
        var k = 'seen-' + day + '-' + n;
        var v = days[k] || ',';
        if (v.length + id.length + 1 <= 8000) { days[k] = v + id + ','; dirty[k] = 1; return; }
      }
    },
    save: function () {
      var oldest = dayKey_(new Date(Date.now() - (DAYS + 2) * 86400000));
      Object.keys(days).forEach(function (k) {
        if (k.slice(5, 13) < oldest) { props.deleteProperty(k); delete days[k]; }
        else if (dirty[k]) props.setProperty(k, days[k]);
      });
      if (all.seen !== undefined) props.deleteProperty('seen');   // the single list earlier versions kept
      dirty = {};
    },
  };
}

function dayKey_(d) {
  return String(d.getFullYear()) + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
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
  var code = res.getResponseCode();
  Logger.log(code + '  ' + res.getContentText());
  if (code === 200) {
    Logger.log('Good - the connection works. In CPMS press Check mail. The test has nothing attached, so it shows'
      + ' under Supplier Invoices -> Not collected, "No invoice was attached" - that is a pass.');
  } else if (code === 401) {
    Logger.log('CPMS refused the key. Paste the current CPMS-gmail-collector.gs from your Desktop; if that file is gone,'
      + ' run make-gmail-script.ps1 once and paste the new one into every mailbox that runs this script.'
      + ' Do not run setup.ps1 for this - it makes yet another key.');
  }
}

/** Forget what has been sent, so the next run looks at everything in the window again. */
function resetHistory() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties() || {}).forEach(function (k) {
    if (k === 'seen' || /^seen-\d{8}-\d+$/.test(k)) props.deleteProperty(k);
  });
  Logger.log('history cleared - the next run looks at everything SEARCH matches in the last ' + DAYS + ' days');
}
