# Prove the pipeline before any DNS is touched.
#
#     powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\send-test.ps1
#
# Sends sample-invoice.eml straight at the function, exactly as a mail provider would. If this
# works, everything except mail delivery is working: the key, the function, the table, and the
# app's ability to collect and read. Anything that goes wrong afterwards is then the MX record or
# the Resend webhook, and nothing else.
#
# You are asked for the webhook URL rather than it being stored, because it carries the key.

$ErrorActionPreference = 'Stop'
$eml = Join-Path $PSScriptRoot 'sample-invoice.eml'
if (-not (Test-Path $eml)) { Write-Host "sample-invoice.eml is missing from $PSScriptRoot" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Paste the webhook URL the setup script printed."
Write-Host "It looks like: https://vzxenkijxzzrgnmopnxh.supabase.co/functions/v1/inbound-email?key=..." -ForegroundColor DarkGray
$url = Read-Host "URL"
if ([string]::IsNullOrWhiteSpace($url)) { Write-Host "Nothing entered." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Sending a test invoice from 'Bingo Bins Pty Ltd' for NARRAWEENA, $1,259.50..." -ForegroundColor Cyan

try {
  $res = Invoke-RestMethod -Method Post -Uri $url.Trim() -InFile $eml -ContentType 'message/rfc822'
  Write-Host ""
  Write-Host ($res | ConvertTo-Json -Compress) -ForegroundColor Green
  Write-Host ""
  if ($res.duplicate) {
    Write-Host "Already sent once - the database refused the second copy, which is exactly what" -ForegroundColor Yellow
    Write-Host "should happen when a provider retries. Nothing further to see." -ForegroundColor Yellow
  } else {
    Write-Host "Stored. Now open the app, go to Invoices, and press  Check mail." -ForegroundColor Green
    Write-Host "An invoice from Bingo Bins Pty Ltd for `$1,259.50 should appear."
    Write-Host ""
    Write-Host "It will land under Unallocated unless NARRAWEENA has a project code - that is the"
    Write-Host "matching working as designed, not a fault. Assigning the project moves it on."
  }
} catch {
  $code = $null
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  Write-Host ""
  switch ($code) {
    401 { Write-Host "401 - the key in that URL is not the one on the server. Run setup.ps1 again" -ForegroundColor Red
          Write-Host "      and use the URL it prints (it makes a new key each time)." -ForegroundColor Red }
    404 { Write-Host "404 - the function is not deployed. Run setup.ps1 first." -ForegroundColor Red }
    500 { Write-Host "500 - the function ran but could not store the message. The most likely cause" -ForegroundColor Red
          Write-Host "      is that the ap_inbox migration has not been run in the SQL Editor." -ForegroundColor Red }
    default { Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red }
  }
  exit 1
}
