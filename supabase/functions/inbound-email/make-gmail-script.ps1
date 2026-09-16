# Build a ready-to-paste Gmail collector, with the key already in it.
#
#     powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\make-gmail-script.ps1
#
# There is no line to find and no URL to paste into the right spot. This makes a new key, stores
# it on the server, writes a finished script to your Desktop and opens it. You copy the whole
# thing and paste it into Apps Script over what is there.
#
# The finished file has the key in it, so it is written to the Desktop and NOT into this project -
# this folder is a public GitHub repository.

$ErrorActionPreference = 'Stop'
$PROJECT = 'vzxenkijxzzrgnmopnxh'
$SRC = Join-Path $PSScriptRoot 'gmail-forwarder.gs'
$OUT = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CPMS-gmail-collector.gs'

function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Cyan }

if (-not (Test-Path $SRC)) { Write-Host "Cannot find $SRC" -ForegroundColor Red; exit 1 }

Step 1 "Making a new key"
# 32 random bytes as hex. A new one every time, which also retires whatever came before - so a key
# that has been seen by anybody stops working the moment this finishes.
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$KEY = -join ($bytes | ForEach-Object { $_.ToString('x2') })
Write-Host "    done"

Step 2 "Storing it on the server"
& npx --yes supabase@latest secrets set "INBOUND_KEY=$KEY" --project-ref $PROJECT
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Could not store it. If it asked you to sign in, run setup.ps1 first - that signs you" -ForegroundColor Red
  Write-Host "in to Supabase - then run this again." -ForegroundColor Red
  exit 1
}

Step 3 "Bringing the inbound-email function up to date"
# The function in this folder, so its fixes go live with the new key: a second copy of a message is
# answered as already stored rather than as an error, and CPMS's own outgoing mail is turned away.
$deployed = $false
Push-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..\..'))
try {
  & npx --yes supabase@latest functions deploy inbound-email --no-verify-jwt --project-ref $PROJECT
  $deployed = ($LASTEXITCODE -eq 0)
} finally { Pop-Location }
if ($deployed) { Write-Host "    done" }
else {
  Write-Host "    Could not deploy it. The key is stored, so the script below still works with the function" -ForegroundColor Yellow
  Write-Host "    already on the server. To deploy later, from the project folder (do NOT run setup.ps1 - it" -ForegroundColor Yellow
  Write-Host "    would make another key):" -ForegroundColor Yellow
  Write-Host "      npx supabase functions deploy inbound-email --no-verify-jwt --project-ref $PROJECT" -ForegroundColor Yellow
}

Step 4 "Writing the finished script to your Desktop"
$url = "https://$PROJECT.supabase.co/functions/v1/inbound-email?key=$KEY"
$code = Get-Content $SRC -Raw -Encoding UTF8
# The one line that differs between a template and a working script.
$code = $code -replace "var ENDPOINT = 'PASTE_YOUR_WEBHOOK_URL_HERE';", ("var ENDPOINT = '" + $url + "';")
if ($code -notmatch [regex]::Escape($url)) {
  Write-Host "The template did not contain the line this replaces - not writing a half-finished file." -ForegroundColor Red
  exit 1
}
Set-Content -Path $OUT -Value $code -Encoding utf8
Write-Host "    $OUT"

Write-Host ""
Write-Host "Done. Now, in the file that is about to open:" -ForegroundColor Green
Write-Host ""
Write-Host "  1. Click in it, press Ctrl+A, then Ctrl+C            (selects and copies everything)"
Write-Host "  2. Go to your Apps Script tab, signed in as the mailbox that collects (e.g. accounts@)"
Write-Host "  3. Click in the code, press Ctrl+A, then Ctrl+V      (replaces everything with this)"
Write-Host "  4. Press Ctrl+S"
Write-Host "  5. The greyed-out 'No functions' becomes a list - pick testConnection, press Run"
Write-Host "  6. Pick collectInvoices, press Run                   (the log lists what it sent)"
Write-Host "  7. Pick turnOn, press Run                            (from now on, every 15 minutes)"
Write-Host ""
Write-Host "  Collecting for several mailboxes in one? See 'Invoices arrive at several addresses' at the"
Write-Host "  top of the file. Pasting into each mailbox instead? Use THIS file in all of them - running"
Write-Host "  this again makes a new key and stops the copies already pasted."
Write-Host ""
Write-Host "  Keep this file to yourself - it has the key in it. Delete it once it is pasted." -ForegroundColor Yellow
Write-Host ""

Start-Process notepad.exe $OUT
