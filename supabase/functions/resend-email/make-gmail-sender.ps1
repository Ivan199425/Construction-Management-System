# Send CPMS email through your Google Workspace mailbox - no DNS records needed.
#
#     powershell -ExecutionPolicy Bypass -File supabase\functions\resend-email\make-gmail-sender.ps1
#
# This makes a new key, stores it on the server, brings the send function up to date, writes a
# finished Apps Script to your Desktop and opens it. You paste it into script.google.com, deploy it
# as a Web app, and paste the Web app URL back here. From then on the app sends from Gmail.
#
# The finished file has the key in it, so it is written to the Desktop and NOT into this project -
# this folder is a public GitHub repository.

$ErrorActionPreference = 'Stop'
$PROJECT = 'vzxenkijxzzrgnmopnxh'
$SRC = Join-Path $PSScriptRoot 'gmail-sender.gs'
$OUT = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CPMS-gmail-sender.gs'

function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Cyan }

if (-not (Test-Path $SRC)) { Write-Host "Cannot find $SRC" -ForegroundColor Red; exit 1 }

Step 1 "Making a new key"
# 32 random bytes as hex. A new one every time, which also retires any script pasted before.
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$KEY = -join ($bytes | ForEach-Object { $_.ToString('x2') })
Write-Host "    done"

Step 2 "Writing the finished script to your Desktop"
$code = Get-Content $SRC -Raw -Encoding UTF8
$code = $code -replace "var SEND_KEY = 'PASTE_YOUR_SEND_KEY_HERE';", ("var SEND_KEY = '" + $KEY + "';")
if ($code -notmatch [regex]::Escape($KEY)) {
  Write-Host "The template did not contain the line this replaces - not writing a half-finished file." -ForegroundColor Red
  exit 1
}
Set-Content -Path $OUT -Value $code -Encoding utf8
Write-Host "    $OUT"
Start-Process notepad.exe $OUT

Write-Host ""
Write-Host "Now, in the file that just opened:" -ForegroundColor Green
Write-Host ""
Write-Host "  1. Click in it, press Ctrl+A, then Ctrl+C              (copies everything)"
Write-Host "  2. In your browser, signed in to Gmail as the mailbox that should SEND,"
Write-Host "     open https://script.google.com  ->  New project"
Write-Host "  3. Click in the code, press Ctrl+A, then Ctrl+V, then Ctrl+S"
Write-Host "  4. Pick testSetup in the list at the top, press Run, and approve the access it asks for"
Write-Host "     ('unverified app' is expected - Advanced -> Go to project). The log shows the mailbox."
Write-Host "  5. Deploy -> New deployment -> gear icon -> Web app"
Write-Host "        Execute as:      Me"
Write-Host "        Who has access:  Anyone"
Write-Host "     Deploy, then copy the Web app URL (it ends in /exec)."
Write-Host ""

$URL = ''
while ($true) {
  $URL = (Read-Host "Paste the Web app URL here and press Enter").Trim()
  if ($URL -match '^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$') { break }
  Write-Host "    That is not a Web app URL. It looks like https://script.google.com/macros/s/.../exec" -ForegroundColor Yellow
}

Step 3 "Storing the key and the URL on the server"
& npx --yes supabase@latest secrets set "GMAIL_SEND_KEY=$KEY" "GMAIL_SEND_URL=$URL" --project-ref $PROJECT
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Could not store them. If it asked you to sign in, run" -ForegroundColor Red
  Write-Host "    npx supabase login" -ForegroundColor Red
  Write-Host "then run this again (and paste the new Desktop file - a new run makes a new key)." -ForegroundColor Red
  exit 1
}
Write-Host "    done"

Step 4 "Bringing the send function up to date"
$deployed = $false
Push-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..\..'))
try {
  & npx --yes supabase@latest functions deploy resend-email --no-verify-jwt --project-ref $PROJECT
  $deployed = ($LASTEXITCODE -eq 0)
} finally { Pop-Location }
if (-not $deployed) {
  Write-Host "    Could not deploy it. From the project folder, run:" -ForegroundColor Yellow
  Write-Host "      npx supabase functions deploy resend-email --no-verify-jwt --project-ref $PROJECT" -ForegroundColor Yellow
  exit 1
}
Write-Host "    done"

Step 5 "Checking the script answers"
try {
  $probe = Invoke-RestMethod -Method Post -Uri $URL -ContentType 'application/json' -Body (@{ key = $KEY; to = @() } | ConvertTo-Json)
  if ($probe.error -eq 'No recipients') { Write-Host "    The script is live and accepts the key (nothing was sent)." -ForegroundColor Green }
  else { Write-Host ("    The script answered: " + ($probe | ConvertTo-Json -Compress)) -ForegroundColor Yellow }
} catch {
  Write-Host "    Could not reach the script: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "    Check it is deployed as a Web app with 'Who has access: Anyone'." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Send something from CPMS: it goes out from Gmail and appears in that mailbox's Sent folder." -ForegroundColor Green
Write-Host ""
Write-Host "  To send as other addresses (e.g. ivan@ and accounts@), add them in that mailbox under"
Write-Host "  Gmail -> Settings -> See all settings -> Accounts -> 'Send mail as'. Other addresses still work:"
Write-Host "  the email comes from this mailbox and replies go to the person who sent it."
Write-Host ""
Write-Host "  Delete CPMS-gmail-sender.gs from your Desktop once it is pasted - it has the key in it." -ForegroundColor Yellow
Write-Host ""
